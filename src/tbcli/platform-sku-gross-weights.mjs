import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { billSummary, importCourierBill, validateCourierBill } from './courier-bills.mjs';
import { estimatePlatformSkuGrossWeight, SKU_GROSS_METHOD } from './platform-sku-gross-stat.mjs';
import { updateResidualGrossWeights } from './platform-sku-gross-residual.mjs';

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const carriers = [
  ['sto', /申通|(?:^|[^a-z])sto(?:[^a-z]|$)/i],
  ['yunda', /韵达|yunda/i],
  ['jt', /极兔|(?:^|[^a-z])jt(?:[^a-z]|$)/i],
  ['sf', /顺丰|shunfeng/i],
];

function monthFromName(file, yearHint) {
  const name = path.basename(file);
  const explicit = name.match(/(20\d{2})[.年_\/-]?\s*(1[0-2]|0?[1-9])(?:月|[.\-_]|$)/);
  if (explicit) return `${explicit[1]}-${explicit[2].padStart(2, '0')}`;
  const short = `${name} ${path.basename(path.dirname(file))}`.match(/(?:^|\D)(1[0-2]|0?[1-9])\s*月/);
  if (short && yearHint) return `${yearHint}-${short[1].padStart(2, '0')}`;
  return null;
}

export async function discoverSkuGrossBillInputs(input, { carrier, billMonth, year } = {}) {
  if (!input) throw new Error('需要 --input 快递账单 Excel 文件或目录');
  const root = path.resolve(input), info = await fs.stat(root);
  const files = [];
  async function walk(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name.startsWith('~$')) continue;
      const location = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(location);
      else if (entry.isFile() && /\.xlsx$/i.test(entry.name)) files.push(location);
    }
  }
  if (info.isDirectory()) await walk(root);
  else if (info.isFile() && /\.xlsx$/i.test(root)) files.push(root);
  else throw new Error('输入路径必须是 .xlsx 文件或包含快递账单的目录');
  files.sort();
  if (!files.length) throw new Error('输入路径没有 .xlsx 快递账单');
  if (files.length > 100) throw new Error('一次最多处理 100 份快递账单');
  if (files.length > 1 && (carrier || billMonth))
    throw new Error('目录有多份账单时逐文件识别承运商和月份；--carrier/--bill-month 仅用于单文件');
  const explicitYears = [...new Set(files.flatMap(file => [...path.basename(file).matchAll(/20\d{2}/g)]
    .map(match => match[0])))];
  const inferredYear = year || (explicitYears.length === 1 ? explicitYears[0] : null);
  if (year && !/^20\d{2}$/.test(year)) throw new Error('--year 需要 YYYY');
  const result = files.map(file => {
    const matches = carriers.filter(([, pattern]) => pattern.test(path.basename(file))).map(([code]) => code);
    const resolvedCarrier = carrier || (matches.length === 1 ? matches[0] : null);
    const resolvedMonth = billMonth || monthFromName(file, inferredYear);
    if (!resolvedCarrier || !MONTH.test(resolvedMonth ?? ''))
      throw new Error(`无法从账单路径确定承运商或月份：${path.basename(file)}；单文件可传 --carrier/--bill-month，目录可传 --year`);
    return { file, carrier: resolvedCarrier, billMonth: resolvedMonth };
  });
  const keys = result.map(row => `${row.carrier}:${row.billMonth}:${path.basename(row.file)}`);
  if (new Set(keys).size !== keys.length) throw new Error('账单文件身份重复');
  return result;
}

export async function validateSkuGrossBills(inputs) {
  const validated = [];
  for (const item of inputs) {
    const result = await validateCourierBill(item.file, item);
    if (!result.ok) throw new Error(`快递账单校验失败 ${path.basename(item.file)}：${JSON.stringify(result.errors.slice(0, 10))}`);
    validated.push(result);
  }
  return validated;
}

export async function assertSkuGrossModeReady(client, shopKey, mode) {
  if (!shopKey || !['init', 'update'].includes(mode)) throw new Error('需要店铺键和 init|update 模式');
  const relation = await client.query("SELECT to_regclass('mart.platform_sku_gross_weight_samples') AS name");
  const count = relation.rows[0]?.name
    ? Number((await client.query('SELECT count(*)::int AS n FROM mart.platform_sku_gross_weight_samples WHERE shop_key=$1', [shopKey])).rows[0].n)
    : 0;
  if (mode === 'init' && count > 0) throw new Error('该店铺平台 SKU 毛重样本表已有数据；请使用 update');
  if (mode === 'update' && count === 0) throw new Error('该店铺尚未初始化平台 SKU 毛重；请使用 init');
}

export async function ensureSkuGrossSchema(client) {
  await client.query(`CREATE SCHEMA IF NOT EXISTS mart;
    CREATE SCHEMA IF NOT EXISTS master;
    CREATE SCHEMA IF NOT EXISTS meta;
    CREATE TABLE IF NOT EXISTS mart.platform_sku_gross_weight_samples(
      shop_key text NOT NULL,wdt_trade_no text NOT NULL,tracking_no text NOT NULL,
      platform_sku_id text NOT NULL,platform_product_id text,
      billable_weight_kg numeric(18,6) NOT NULL CHECK(billable_weight_kg>0),
      carrier text,first_bill_month text,last_bill_month text,
      source_batch_ids jsonb NOT NULL,actual_components jsonb NOT NULL,
      expected_components jsonb,eligibility text NOT NULL,source_hash text NOT NULL,
      first_seen_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(shop_key,wdt_trade_no,tracking_no));
    CREATE INDEX IF NOT EXISTS platform_sku_gross_samples_sku_idx
      ON mart.platform_sku_gross_weight_samples(shop_key,platform_sku_id);
    CREATE INDEX IF NOT EXISTS platform_sku_gross_samples_tracking_idx
      ON mart.platform_sku_gross_weight_samples(shop_key,tracking_no);
    CREATE TABLE IF NOT EXISTS meta.platform_sku_gross_weight_runs(
      run_id uuid PRIMARY KEY,shop_key text NOT NULL,mode text NOT NULL,
      method text NOT NULL,source_batch_ids jsonb NOT NULL,
      source_file_names jsonb NOT NULL,source_digest text NOT NULL,
      candidate_count integer NOT NULL,valid_sample_count integer NOT NULL,
      changed_sample_count integer NOT NULL,affected_sku_count integer NOT NULL,
      changed_estimate_count integer NOT NULL,
      status text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS master.current_platform_sku_gross_weights(
      shop_key text NOT NULL,platform_sku_id text NOT NULL,platform_product_id text,
      estimate_kg numeric(18,6),confidence_score numeric(8,6),confidence_level text,
      sample_count integer NOT NULL,candidate_count integer NOT NULL,
      ci95_low_kg numeric(18,6),ci95_high_kg numeric(18,6),
      status text NOT NULL,method text NOT NULL,evidence jsonb NOT NULL,
      source_hash text NOT NULL,run_id uuid NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(shop_key,platform_sku_id));
    CREATE TABLE IF NOT EXISTS master.platform_sku_gross_weight_versions(
      version_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      run_id uuid NOT NULL,shop_key text NOT NULL,platform_sku_id text NOT NULL,
      estimate_kg numeric(18,6),confidence_score numeric(8,6),confidence_level text,
      sample_count integer NOT NULL,candidate_count integer NOT NULL,
      status text NOT NULL,method text NOT NULL,evidence jsonb NOT NULL,
      source_hash text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(run_id,shop_key,platform_sku_id));`);
}

const CANDIDATE_SQL = `WITH target_tracking AS (
  SELECT DISTINCT tracking_no FROM raw.courier_bill_charges
  WHERE source_batch_id=ANY($1::uuid[])
), bill_weight AS (
  SELECT c.tracking_no,MIN(c.billable_weight_kg) AS weight_kg,
    MAX(c.billable_weight_kg) AS max_weight_kg,
    MIN(c.carrier) AS carrier,MIN(c.bill_month) AS first_bill_month,
    MAX(c.bill_month) AS last_bill_month,
    JSONB_AGG(DISTINCT c.source_batch_id::text) AS source_batch_ids
  FROM raw.courier_bill_charges c
  JOIN target_tracking t ON t.tracking_no=c.tracking_no
  GROUP BY c.tracking_no
), tracked_shipments AS (
  SELECT s.shop_key,s.wdt_trade_no,s.tracking_no
  FROM raw.shipments s JOIN target_tracking t ON t.tracking_no=s.tracking_no
  WHERE s.shop_key=$2
), unique_tracking AS (
  SELECT tracking_no FROM tracked_shipments
  GROUP BY tracking_no HAVING COUNT(DISTINCT wdt_trade_no)=1
), target_orders AS (
  SELECT DISTINCT wdt_trade_no FROM tracked_shipments
), one_waybill_order AS (
  SELECT s.wdt_trade_no,MIN(s.tracking_no) AS tracking_no
  FROM raw.shipments s JOIN target_orders o ON o.wdt_trade_no=s.wdt_trade_no
  WHERE s.shop_key=$2
  GROUP BY s.wdt_trade_no HAVING COUNT(DISTINCT s.tracking_no)=1
), billed_order AS (
  SELECT s.wdt_trade_no,s.tracking_no,b.weight_kg,b.carrier,
    b.first_bill_month,b.last_bill_month,b.source_batch_ids
  FROM one_waybill_order s JOIN unique_tracking u ON u.tracking_no=s.tracking_no
  JOIN bill_weight b ON b.tracking_no=s.tracking_no
  WHERE b.weight_kg>0 AND b.weight_kg=b.max_weight_kg
), single_sku_order AS (
  SELECT l.wdt_trade_no,MIN(l.platform_sku_id) AS platform_sku_id,
    MIN(l.platform_product_id) AS platform_product_id,
    JSONB_AGG(JSONB_BUILD_ARRAY(l.erp_spec_no,l.quantity) ORDER BY l.erp_spec_no) AS actual_components
  FROM raw.wdt_order_lines l JOIN billed_order b ON b.wdt_trade_no=l.wdt_trade_no
  WHERE l.shop_key=$2
  GROUP BY l.wdt_trade_no
  HAVING COUNT(DISTINCT l.platform_sku_id)=1
    AND COUNT(*) FILTER(WHERE l.platform_sku_id IS NULL OR l.erp_spec_no IS NULL
      OR l.quantity IS NULL OR l.quantity<=0)=0
), mapping AS (
  SELECT platform_sku_id,
    JSONB_AGG(JSONB_BUILD_ARRAY(erp_spec_no,component_qty) ORDER BY erp_spec_no) AS expected_components
  FROM master.current_platform_sku_components WHERE shop_key=$2 AND component_qty>0
  GROUP BY platform_sku_id
)
SELECT $2::text AS shop_key,o.wdt_trade_no,b.tracking_no,o.platform_sku_id,
  o.platform_product_id,b.weight_kg,b.carrier,b.first_bill_month,b.last_bill_month,
  b.source_batch_ids,o.actual_components,m.expected_components
FROM billed_order b JOIN single_sku_order o ON o.wdt_trade_no=b.wdt_trade_no
LEFT JOIN mapping m ON m.platform_sku_id=o.platform_sku_id
ORDER BY o.platform_sku_id,o.wdt_trade_no`;

function componentMap(pairs) {
  if (!Array.isArray(pairs) || !pairs.length) return null;
  const map = new Map();
  for (const [spec, rawQty] of pairs) {
    const qty = Number(rawQty);
    if (!spec || !Number.isFinite(qty) || qty <= 0) return null;
    map.set(String(spec), (map.get(String(spec)) ?? 0) + qty);
  }
  return map;
}

export function classifySkuGrossCandidate(row) {
  const expected = componentMap(row.expected_components);
  const actual = componentMap(row.actual_components);
  if (!expected) return 'missing-mapping';
  if (!actual || expected.size !== actual.size || [...actual.keys()].some(key => !expected.has(key)))
    return 'component-mismatch';
  if ([...expected].some(([key, qty]) => Math.abs(actual.get(key) - qty) > 1e-8))
    return 'not-one-unit';
  return 'valid';
}

const stablePairs = pairs => Array.isArray(pairs)
  ? [...pairs].map(([spec, qty]) => [String(spec), Number(qty)]).sort((a, b) => a[0].localeCompare(b[0]))
  : null;
function normalizedSample(row) {
  const sample = {
    shop_key: String(row.shop_key),wdt_trade_no: String(row.wdt_trade_no),
    tracking_no: String(row.tracking_no),platform_sku_id: String(row.platform_sku_id),
    platform_product_id: row.platform_product_id == null ? null : String(row.platform_product_id),
    billable_weight_kg: Number(row.weight_kg),carrier: row.carrier,
    first_bill_month: row.first_bill_month,last_bill_month: row.last_bill_month,
    source_batch_ids: [...row.source_batch_ids].sort(),
    actual_components: stablePairs(row.actual_components),
    expected_components: stablePairs(row.expected_components),
    eligibility: classifySkuGrossCandidate(row),
  };
  sample.source_hash = sha(JSON.stringify(sample));
  return sample;
}

async function upsertSamples(client, samples) {
  const changed = new Set();
  let changedRows = 0;
  for (let i = 0; i < samples.length; i += 500) {
    const chunk = samples.slice(i, i + 500);
    const previous = await client.query(`SELECT s.wdt_trade_no,s.tracking_no,s.platform_sku_id
      FROM mart.platform_sku_gross_weight_samples s
      JOIN jsonb_to_recordset($2::jsonb) AS x(wdt_trade_no text,tracking_no text)
        ON x.wdt_trade_no=s.wdt_trade_no AND x.tracking_no=s.tracking_no
      WHERE s.shop_key=$1`,[samples[0].shop_key,JSON.stringify(chunk)]);
    const oldSku = new Map(previous.rows.map(row => [`${row.wdt_trade_no}|${row.tracking_no}`,row.platform_sku_id]));
    const written = await client.query(`INSERT INTO mart.platform_sku_gross_weight_samples(
      shop_key,wdt_trade_no,tracking_no,platform_sku_id,platform_product_id,
      billable_weight_kg,carrier,first_bill_month,last_bill_month,source_batch_ids,
      actual_components,expected_components,eligibility,source_hash)
      SELECT x.shop_key,x.wdt_trade_no,x.tracking_no,x.platform_sku_id,x.platform_product_id,
      x.billable_weight_kg,x.carrier,x.first_bill_month,x.last_bill_month,x.source_batch_ids,
      x.actual_components,x.expected_components,x.eligibility,x.source_hash
      FROM jsonb_to_recordset($1::jsonb) AS x(
        shop_key text,wdt_trade_no text,tracking_no text,platform_sku_id text,
        platform_product_id text,billable_weight_kg numeric,carrier text,
        first_bill_month text,last_bill_month text,source_batch_ids jsonb,
        actual_components jsonb,expected_components jsonb,eligibility text,source_hash text)
      ON CONFLICT(shop_key,wdt_trade_no,tracking_no) DO UPDATE SET
        platform_sku_id=EXCLUDED.platform_sku_id,platform_product_id=EXCLUDED.platform_product_id,
        billable_weight_kg=EXCLUDED.billable_weight_kg,carrier=EXCLUDED.carrier,
        first_bill_month=EXCLUDED.first_bill_month,last_bill_month=EXCLUDED.last_bill_month,
        source_batch_ids=EXCLUDED.source_batch_ids,actual_components=EXCLUDED.actual_components,
        expected_components=EXCLUDED.expected_components,eligibility=EXCLUDED.eligibility,
        source_hash=EXCLUDED.source_hash,updated_at=now()
      WHERE mart.platform_sku_gross_weight_samples.source_hash<>EXCLUDED.source_hash
      RETURNING platform_sku_id`,[JSON.stringify(chunk)]);
    changedRows += written.rowCount;
    for (const row of written.rows) changed.add(row.platform_sku_id);
    for (const row of chunk) {
      const prior = oldSku.get(`${row.wdt_trade_no}|${row.tracking_no}`);
      if (prior && prior !== row.platform_sku_id) changed.add(prior);
    }
  }
  return { changedSkus: changed, changedRows };
}

async function refreshEstimates(client, shopKey, affected, runId) {
  if (!affected.size) return { changed: 0, affected: 0 };
  const skus = [...affected].sort(), all = await client.query(`SELECT platform_sku_id,
    MIN(platform_product_id) AS platform_product_id,COUNT(*)::int AS candidate_count,
    ARRAY_AGG(billable_weight_kg::float8 ORDER BY tracking_no)
      FILTER(WHERE eligibility='valid') AS valid_weights,
    COUNT(*) FILTER(WHERE eligibility='missing-mapping')::int AS missing_mapping_count,
    COUNT(*) FILTER(WHERE eligibility='component-mismatch')::int AS component_mismatch_count,
    COUNT(*) FILTER(WHERE eligibility='not-one-unit')::int AS not_one_unit_count
    FROM mart.platform_sku_gross_weight_samples
    WHERE shop_key=$1 AND platform_sku_id=ANY($2::text[])
    GROUP BY platform_sku_id ORDER BY platform_sku_id`,[shopKey,skus]);
  const currentRows = await client.query(`SELECT platform_sku_id,status,source_hash
    FROM master.current_platform_sku_gross_weights
    WHERE shop_key=$1 AND platform_sku_id=ANY($2::text[])`,[shopKey,skus]);
  const currentBySku = new Map(currentRows.rows.map(row => [row.platform_sku_id,row]));
  const changed = [];
  for (const row of all.rows) {
    const estimate = estimatePlatformSkuGrossWeight(row.valid_weights ?? [], {
      skuKey: `${shopKey}:${row.platform_sku_id}` });
    const status = estimate.status === 'estimated' ? 'estimated'
      : row.missing_mapping_count === row.candidate_count ? 'missing-mapping' : 'no-valid-single-unit-sample';
    const evidence = { ...estimate, exclusions: { missingMapping: row.missing_mapping_count,
      componentMismatch: row.component_mismatch_count, notOneUnit: row.not_one_unit_count } };
    if (estimate.status !== 'estimated' && ['inferred','manual-estimate'].includes(currentBySku.get(row.platform_sku_id)?.status)) continue;
    const content = { shopKey,sku:row.platform_sku_id,productId:row.platform_product_id,
      estimateKg:estimate.estimateKg,score:estimate.confidenceScore,level:estimate.confidenceLevel,
      sampleCount:estimate.sampleCount,candidateCount:row.candidate_count,
      ciLow:estimate.ci95LowKg??null,ciHigh:estimate.ci95HighKg??null,
      status,method:SKU_GROSS_METHOD,evidence };
    const sourceHash = sha(JSON.stringify(content));
    if (currentBySku.get(row.platform_sku_id)?.source_hash === sourceHash) continue;
    changed.push({ shop_key:shopKey,platform_sku_id:row.platform_sku_id,
      platform_product_id:row.platform_product_id,estimate_kg:estimate.estimateKg,
      confidence_score:estimate.confidenceScore,confidence_level:estimate.confidenceLevel,
      sample_count:estimate.sampleCount,candidate_count:row.candidate_count,
      ci95_low_kg:estimate.ci95LowKg??null,ci95_high_kg:estimate.ci95HighKg??null,
      status,method:SKU_GROSS_METHOD,evidence,source_hash:sourceHash,run_id:runId });
  }
  for (let i = 0; i < changed.length; i += 500) {
    const chunk = changed.slice(i, i + 500);
    await client.query(`INSERT INTO master.current_platform_sku_gross_weights(
      shop_key,platform_sku_id,platform_product_id,estimate_kg,confidence_score,
      confidence_level,sample_count,candidate_count,ci95_low_kg,ci95_high_kg,
      status,method,evidence,source_hash,run_id)
      SELECT x.shop_key,x.platform_sku_id,x.platform_product_id,x.estimate_kg,
        x.confidence_score,x.confidence_level,x.sample_count,x.candidate_count,
        x.ci95_low_kg,x.ci95_high_kg,x.status,x.method,x.evidence,x.source_hash,x.run_id
      FROM jsonb_to_recordset($1::jsonb) AS x(
        shop_key text,platform_sku_id text,platform_product_id text,estimate_kg numeric,
        confidence_score numeric,confidence_level text,sample_count integer,candidate_count integer,
        ci95_low_kg numeric,ci95_high_kg numeric,status text,method text,evidence jsonb,
        source_hash text,run_id uuid)
      ON CONFLICT(shop_key,platform_sku_id) DO UPDATE SET
        platform_product_id=EXCLUDED.platform_product_id,estimate_kg=EXCLUDED.estimate_kg,
        confidence_score=EXCLUDED.confidence_score,confidence_level=EXCLUDED.confidence_level,
        sample_count=EXCLUDED.sample_count,candidate_count=EXCLUDED.candidate_count,
        ci95_low_kg=EXCLUDED.ci95_low_kg,ci95_high_kg=EXCLUDED.ci95_high_kg,
        status=EXCLUDED.status,method=EXCLUDED.method,evidence=EXCLUDED.evidence,
        source_hash=EXCLUDED.source_hash,run_id=EXCLUDED.run_id,updated_at=now()`,[JSON.stringify(chunk)]);
    await client.query(`INSERT INTO master.platform_sku_gross_weight_versions(
      run_id,shop_key,platform_sku_id,estimate_kg,confidence_score,confidence_level,
      sample_count,candidate_count,status,method,evidence,source_hash)
      SELECT x.run_id,x.shop_key,x.platform_sku_id,x.estimate_kg,x.confidence_score,
        x.confidence_level,x.sample_count,x.candidate_count,x.status,x.method,x.evidence,
        x.source_hash FROM jsonb_to_recordset($1::jsonb) AS x(
        run_id uuid,shop_key text,platform_sku_id text,estimate_kg numeric,
        confidence_score numeric,confidence_level text,sample_count integer,candidate_count integer,
        status text,method text,evidence jsonb,source_hash text)`,[JSON.stringify(chunk)]);
  }
  return { changed:changed.length, affected:skus.length };
}

export async function applySkuGrossWeights(client, { shopKey, mode, batchIds, fileNames }) {
  if (!shopKey || !['init','update'].includes(mode) || !batchIds.length)
    throw new Error('需要店铺键、init|update 模式和至少一个账单批次');
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL statement_timeout='600000ms'");
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`tbcli:platform-sku-gross:${shopKey}`]);
    await ensureSkuGrossSchema(client);
    const existing = await client.query(`SELECT count(*)::int n FROM mart.platform_sku_gross_weight_samples
      WHERE shop_key=$1`,[shopKey]);
    if (mode === 'init' && existing.rows[0].n > 0) throw new Error('该店铺平台 SKU 毛重样本表已有数据；请使用 update');
    if (mode === 'update' && existing.rows[0].n === 0) throw new Error('该店铺尚未初始化平台 SKU 毛重；请使用 init');
    const candidates = await client.query(CANDIDATE_SQL,[batchIds,shopKey]);
    if (mode === 'init' && !candidates.rowCount) throw new Error('账单没有匹配可分析的单平台 SKU 订单，未初始化空表');
    const samples = candidates.rows.map(normalizedSample);
    const runId = crypto.randomUUID();
    const { changedSkus, changedRows } = samples.length
      ? await upsertSamples(client,samples) : { changedSkus:new Set(),changedRows:0 };
    const estimates = await refreshEstimates(client,shopKey,changedSkus,runId);
    const residual = await updateResidualGrossWeights(client,{shopKey,batchIds,runId});
    const sourceDigest = sha(JSON.stringify({ batchIds:[...batchIds].sort(),fileNames:[...fileNames].sort(),method:SKU_GROSS_METHOD }));
    await client.query(`INSERT INTO meta.platform_sku_gross_weight_runs(
      run_id,shop_key,mode,method,source_batch_ids,source_file_names,source_digest,
      candidate_count,valid_sample_count,changed_sample_count,affected_sku_count,
      changed_estimate_count,multi_package_count,residual_sample_count,
      changed_residual_sample_count,inferred_sku_count,changed_inferred_count,
      shared_residual_sample_count,shared_inferred_sku_count,status)
      VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,'complete')`,[
      runId,shopKey,mode,SKU_GROSS_METHOD,JSON.stringify(batchIds),JSON.stringify(fileNames),sourceDigest,
      samples.length,samples.filter(row=>row.eligibility==='valid').length,
      // Changed sample rows may be fewer than candidates on an idempotent update.
      changedRows,estimates.affected,estimates.changed,residual.multiPackageCount,
      residual.residualSampleCount,residual.changedResidualSampleCount,
      residual.inferredSkuCount,residual.changedInferredCount,
      residual.sharedResidualSampleCount,residual.sharedInferredSkuCount]);
    const verified = await client.query(`SELECT
      count(*)::int candidate_count,
      count(*) FILTER(WHERE eligibility='valid')::int valid_sample_count,
      count(DISTINCT platform_sku_id)::int sku_count
      FROM mart.platform_sku_gross_weight_samples WHERE shop_key=$1`,[shopKey]);
    const weightTotals = await client.query(`SELECT status,count(*)::integer AS sku_count
      FROM master.current_platform_sku_gross_weights WHERE shop_key=$1
      GROUP BY status ORDER BY status`,[shopKey]);
    await client.query('COMMIT');
    return { runId,shopKey,mode,method:SKU_GROSS_METHOD,sourceBatchIds:batchIds,
      sourceFiles:fileNames,candidateCount:samples.length,
      validSampleCount:samples.filter(row=>row.eligibility==='valid').length,
      changedSampleCount:changedRows,affectedSkuCount:estimates.affected,
      changedEstimateCount:estimates.changed,residual,
      warehouse:{...verified.rows[0],weightStatusCounts:weightTotals.rows},wrote:true };
  } catch(error) { await client.query('ROLLBACK'); throw error; }
}

export async function importSkuGrossBills(client, validations) {
  const imports=[];
  for (const validated of validations) {
    const result = await importCourierBill(client,validated);
    imports.push({ file:path.basename(validated.file),carrier:validated.carrier,
      billMonth:validated.billMonth,validation:billSummary(validated),
      batchId:result.batchId??result.batch?.batch_id,
      alreadyImported:result.alreadyImported });
  }
  return imports;
}
