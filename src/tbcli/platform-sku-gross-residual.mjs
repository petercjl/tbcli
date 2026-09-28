import crypto from 'node:crypto';
import { estimatePlatformSkuGrossWeight } from './platform-sku-gross-stat.mjs';

export const RESIDUAL_METHOD = 'platform-sku-gross-residual-v1';
export const SHARED_RESIDUAL_METHOD = 'platform-sku-gross-shared-residual-v1';
export const PACKAGING_ASSUMPTION_KG = 0.2;
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const round = (value, digits = 6) => Number(value.toFixed(digits));

export const MULTI_PACKAGE_SQL = `WITH target_tracking AS (
  SELECT DISTINCT tracking_no FROM raw.courier_bill_charges
  WHERE source_batch_id=ANY($1::uuid[])
), bill_weight AS (
  SELECT c.tracking_no,MIN(c.billable_weight_kg) AS weight_kg,
    MAX(c.billable_weight_kg) AS max_weight_kg,
    MIN(c.carrier) AS carrier,MIN(c.bill_month) AS first_bill_month,
    MAX(c.bill_month) AS last_bill_month,
    JSONB_AGG(DISTINCT c.source_batch_id::text) AS source_batch_ids
  FROM raw.courier_bill_charges c JOIN target_tracking t USING(tracking_no)
  GROUP BY c.tracking_no
), tracked_shipments AS (
  SELECT s.shop_key,s.wdt_trade_no,s.tracking_no
  FROM raw.shipments s JOIN target_tracking t USING(tracking_no)
  WHERE s.shop_key=$2
), unique_tracking AS (
  SELECT tracking_no FROM tracked_shipments
  GROUP BY tracking_no HAVING COUNT(DISTINCT wdt_trade_no)=1
), target_orders AS (
  SELECT DISTINCT wdt_trade_no FROM tracked_shipments
), one_waybill_order AS (
  SELECT s.wdt_trade_no,MIN(s.tracking_no) AS tracking_no
  FROM raw.shipments s JOIN target_orders o USING(wdt_trade_no)
  WHERE s.shop_key=$2 GROUP BY s.wdt_trade_no
  HAVING COUNT(DISTINCT s.tracking_no)=1
), billed_order AS (
  SELECT s.wdt_trade_no,s.tracking_no,b.weight_kg,b.carrier,
    b.first_bill_month,b.last_bill_month,b.source_batch_ids
  FROM one_waybill_order s JOIN unique_tracking u ON u.tracking_no=s.tracking_no
  JOIN bill_weight b ON b.tracking_no=s.tracking_no
  WHERE b.weight_kg>0 AND b.weight_kg=b.max_weight_kg
), actual_components AS (
  SELECT l.wdt_trade_no,l.platform_sku_id,l.erp_spec_no,
    SUM(l.quantity) AS quantity,MIN(l.platform_product_id) AS platform_product_id,
    COUNT(DISTINCT l.platform_product_id)::integer AS product_count
  FROM raw.wdt_order_lines l JOIN billed_order b USING(wdt_trade_no)
  WHERE l.shop_key=$2
  GROUP BY l.wdt_trade_no,l.platform_sku_id,l.erp_spec_no
), order_skus AS (
  SELECT a.wdt_trade_no,a.platform_sku_id,
    MIN(a.platform_product_id) AS platform_product_id,
    GREATEST(COUNT(DISTINCT a.platform_product_id),MAX(a.product_count))::integer AS product_count,
    JSONB_AGG(JSONB_BUILD_ARRAY(a.erp_spec_no,a.quantity) ORDER BY a.erp_spec_no) AS actual_components
  FROM actual_components a GROUP BY a.wdt_trade_no,a.platform_sku_id
), mapping AS (
  SELECT platform_sku_id,
    JSONB_AGG(JSONB_BUILD_ARRAY(erp_spec_no,component_qty) ORDER BY erp_spec_no) AS expected_components
  FROM master.current_platform_sku_components WHERE shop_key=$2 AND component_qty>0
  GROUP BY platform_sku_id
)
SELECT $2::text AS shop_key,b.wdt_trade_no,b.tracking_no,b.weight_kg,
  b.carrier,b.first_bill_month,b.last_bill_month,b.source_batch_ids,
  JSONB_AGG(JSONB_BUILD_OBJECT(
    'platformSkuId',s.platform_sku_id,'platformProductId',s.platform_product_id,
    'productCount',s.product_count,'actualComponents',s.actual_components,
    'expectedComponents',m.expected_components) ORDER BY s.platform_sku_id) AS items
FROM billed_order b JOIN order_skus s USING(wdt_trade_no)
LEFT JOIN mapping m ON m.platform_sku_id=s.platform_sku_id
GROUP BY b.wdt_trade_no,b.tracking_no,b.weight_kg,b.carrier,
  b.first_bill_month,b.last_bill_month,b.source_batch_ids
HAVING COUNT(*)>=2
ORDER BY b.wdt_trade_no`;

function quantities(pairs) {
  if (!Array.isArray(pairs) || !pairs.length) return null;
  const values = new Map();
  for (const pair of pairs) {
    if (!Array.isArray(pair) || pair.length !== 2 || !pair[0]) return null;
    const quantity = Number(pair[1]);
    if (!Number.isFinite(quantity) || quantity <= 0) return null;
    values.set(String(pair[0]), (values.get(String(pair[0])) ?? 0) + quantity);
  }
  return values;
}

export function restorePurchasedUnits(item) {
  if (Number(item.productCount) !== 1) return null;
  const actual = quantities(item.actualComponents);
  const expected = quantities(item.expectedComponents);
  if (!actual || !expected || actual.size !== expected.size) return null;
  const units = [...actual].map(([spec, quantity]) => expected.has(spec)
    ? quantity / expected.get(spec) : NaN);
  if (units.some(value => !Number.isFinite(value) || value <= 0 ||
      Math.abs(value - units[0]) > 1e-8)) return null;
  const rounded = Math.round(units[0]);
  return Math.abs(units[0] - rounded) <= 1e-8 ? rounded : null;
}

export function deriveResidualSamples(pkg, directAnchors, { packagingKg = PACKAGING_ASSUMPTION_KG } = {}) {
  if (!Number.isFinite(packagingKg) || packagingKg < 0) throw new Error('包装假设重量必须为非负数');
  const billed = Number(pkg.billable_weight_kg ?? pkg.weight_kg);
  if (!Number.isFinite(billed) || billed <= 0 || !Array.isArray(pkg.items) || pkg.items.length < 2) return [];
  const units = pkg.items.map(item => ({ item, purchasedUnits:restorePurchasedUnits(item) }));
  if (units.some(row => !row.item.platformSkuId || row.purchasedUnits == null) ||
      new Set(units.map(row => String(row.item.platformSkuId))).size !== units.length) return [];
  const unknown = [],known = [];
  for (const row of units) {
    const anchor = directAnchors.get(String(row.item.platformSkuId));
    if (anchor && Number(anchor.estimateKg) > 0 && Number(anchor.sampleCount) > 0) known.push({
      platformSkuId:String(row.item.platformSkuId),purchasedUnits:row.purchasedUnits,
      unitGrossKg:Number(anchor.estimateKg),confidenceScore:Number(anchor.confidenceScore ?? 0),
      runId:anchor.runId ?? null,
    });
    else unknown.push(row);
  }
  if (!unknown.length) return [];
  const knownGross = known.reduce((sum,row) => sum + row.unitGrossKg*row.purchasedUnits,0);
  const knownUnits = known.reduce((sum,row) => sum + row.purchasedUnits,0);
  const unknownUnits = unknown.reduce((sum,row) => sum + row.purchasedUnits,0);
  // Each standalone gross includes packaging; one shared package contains it once.
  const remainingNetKg = billed - knownGross + packagingKg*(knownUnits - 1);
  if (!Number.isFinite(remainingNetKg) || remainingNetKg <= 0 || unknownUnits <= 0) return [];
  const estimate = remainingNetKg/unknownUnits + packagingKg;
  return unknown.map(row => {
    const candidate = {
      shop_key:String(pkg.shop_key),wdt_trade_no:String(pkg.wdt_trade_no),
      tracking_no:String(pkg.tracking_no),platform_sku_id:String(row.item.platformSkuId),
      billable_weight_kg:billed,purchased_units:row.purchasedUnits,
      estimated_unit_gross_kg:round(estimate),packaging_assumption_kg:packagingKg,
      known_anchors:known,source_batch_ids:pkg.source_batch_ids ?? [],
      coarse_one_kg_bill:Math.abs(billed - 1) < 1e-8,
      ...(unknown.length>1?{inference_method:'shared_unknown_residual',unknown_sku_count:unknown.length}:{}),
    };
    candidate.source_hash = sha(JSON.stringify(candidate));
    return candidate;
  });
}

export function deriveResidualSample(pkg, directAnchors, options) {
  const samples=deriveResidualSamples(pkg,directAnchors,options);
  return samples.length===1?samples[0]:null;
}

export function summarizeResidualSamples(samples, skuKey) {
  if (!samples.length) return null;
  const single=samples.filter(row => row.inference_method!=='shared_unknown_residual');
  const selected=single.length?single:samples;
  const shared=!single.length;
  const estimate = estimatePlatformSkuGrossWeight(selected.map(row => Number(row.estimated_unit_gross_kg)), { skuKey });
  const anchorScores=selected.flatMap(row => row.known_anchors.map(anchor => Number(anchor.confidenceScore ?? 0)));
  const anchorConfidence=anchorScores.length?Math.min(...anchorScores):0;
  const coarseCount = selected.filter(row => row.coarse_one_kg_bill).length;
  const base = Number(estimate.confidenceScore ?? 0);
  const score = shared
    ? round(Math.min(0.1,base*0.5,coarseCount===selected.length?0.05:1),3)
    : round(Math.min(0.55,base*0.65,anchorConfidence*0.65,
      coarseCount === selected.length ? 0.2 : 1),3);
  return { ...estimate,status:'inferred',confidenceScore:score,confidenceLevel:'low',
    sampleCount:selected.length,packagingAssumptionKg:PACKAGING_ASSUMPTION_KG,
    coarseOneKgBillSamples:coarseCount,minAnchorConfidence:round(anchorConfidence,3),
    sourceType:shared?'multi_sku_shared_residual':'multi_sku_residual',
    ...(shared?{identification:'underdetermined_equal_net_weight_per_unknown_unit',
      maxUnknownSkuCount:Math.max(...selected.map(row=>Number(row.unknown_sku_count)))}:{}) };
}

export async function ensureResidualSchema(client) {
  await client.query(`CREATE TABLE IF NOT EXISTS mart.platform_sku_gross_weight_multi_packages(
    shop_key text NOT NULL,wdt_trade_no text NOT NULL,tracking_no text NOT NULL,
    billable_weight_kg numeric(18,6) NOT NULL,carrier text,
    first_bill_month text,last_bill_month text,source_batch_ids jsonb NOT NULL,
    items jsonb NOT NULL,source_hash text NOT NULL,
    first_seen_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(shop_key,wdt_trade_no,tracking_no));
    CREATE TABLE IF NOT EXISTS mart.platform_sku_gross_weight_residual_samples(
    shop_key text NOT NULL,wdt_trade_no text NOT NULL,tracking_no text NOT NULL,
    platform_sku_id text NOT NULL,billable_weight_kg numeric(18,6) NOT NULL,
    purchased_units numeric(18,6) NOT NULL,estimated_unit_gross_kg numeric(18,6) NOT NULL,
    packaging_assumption_kg numeric(18,6) NOT NULL,known_anchors jsonb NOT NULL,
    source_batch_ids jsonb NOT NULL,coarse_one_kg_bill boolean NOT NULL,
    inference_method text NOT NULL DEFAULT 'single_unknown_residual',
    unknown_sku_count integer NOT NULL DEFAULT 1,
    active boolean NOT NULL DEFAULT true,
    source_hash text NOT NULL,first_seen_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(shop_key,wdt_trade_no,tracking_no,platform_sku_id));
    CREATE INDEX IF NOT EXISTS platform_sku_gross_residual_sku_idx
      ON mart.platform_sku_gross_weight_residual_samples(shop_key,platform_sku_id);
    ALTER TABLE mart.platform_sku_gross_weight_residual_samples
      ADD COLUMN IF NOT EXISTS inference_method text NOT NULL DEFAULT 'single_unknown_residual',
      ADD COLUMN IF NOT EXISTS unknown_sku_count integer NOT NULL DEFAULT 1,
      ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true;
    ALTER TABLE meta.platform_sku_gross_weight_runs
      ADD COLUMN IF NOT EXISTS multi_package_count integer NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS residual_sample_count integer NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS changed_residual_sample_count integer NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS inferred_sku_count integer NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS changed_inferred_count integer NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS shared_residual_sample_count integer NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS shared_inferred_sku_count integer NOT NULL DEFAULT 0;`);
}

function normalizedPackage(row) {
  const pkg = { shop_key:String(row.shop_key),wdt_trade_no:String(row.wdt_trade_no),
    tracking_no:String(row.tracking_no),billable_weight_kg:Number(row.weight_kg),
    carrier:row.carrier,first_bill_month:row.first_bill_month,last_bill_month:row.last_bill_month,
    source_batch_ids:[...row.source_batch_ids].sort(),items:row.items };
  pkg.source_hash = sha(JSON.stringify(pkg));
  return pkg;
}

async function upsertPackages(client, packages) {
  let changed=0;
  for(let offset=0;offset<packages.length;offset+=500) {
    const chunk=packages.slice(offset,offset+500);
    const result=await client.query(`INSERT INTO mart.platform_sku_gross_weight_multi_packages(
      shop_key,wdt_trade_no,tracking_no,billable_weight_kg,carrier,
      first_bill_month,last_bill_month,source_batch_ids,items,source_hash)
      SELECT x.shop_key,x.wdt_trade_no,x.tracking_no,x.billable_weight_kg,x.carrier,
        x.first_bill_month,x.last_bill_month,x.source_batch_ids,x.items,x.source_hash
      FROM jsonb_to_recordset($1::jsonb) AS x(
        shop_key text,wdt_trade_no text,tracking_no text,billable_weight_kg numeric,
        carrier text,first_bill_month text,last_bill_month text,source_batch_ids jsonb,
        items jsonb,source_hash text)
      ON CONFLICT(shop_key,wdt_trade_no,tracking_no) DO UPDATE SET
        billable_weight_kg=EXCLUDED.billable_weight_kg,carrier=EXCLUDED.carrier,
        first_bill_month=EXCLUDED.first_bill_month,last_bill_month=EXCLUDED.last_bill_month,
        source_batch_ids=EXCLUDED.source_batch_ids,items=EXCLUDED.items,
        source_hash=EXCLUDED.source_hash,updated_at=now()
      WHERE mart.platform_sku_gross_weight_multi_packages.source_hash<>EXCLUDED.source_hash`,
    [JSON.stringify(chunk)]);
    changed+=result.rowCount;
  }
  return changed;
}

async function upsertResidualSamples(client,samples) {
  let changed=0;
  for(let offset=0;offset<samples.length;offset+=500) {
    const chunk=samples.slice(offset,offset+500);
    const result=await client.query(`INSERT INTO mart.platform_sku_gross_weight_residual_samples(
      shop_key,wdt_trade_no,tracking_no,platform_sku_id,billable_weight_kg,
      purchased_units,estimated_unit_gross_kg,packaging_assumption_kg,
      known_anchors,source_batch_ids,coarse_one_kg_bill,inference_method,
      unknown_sku_count,source_hash)
      SELECT x.shop_key,x.wdt_trade_no,x.tracking_no,x.platform_sku_id,x.billable_weight_kg,
        x.purchased_units,x.estimated_unit_gross_kg,x.packaging_assumption_kg,
        x.known_anchors,x.source_batch_ids,x.coarse_one_kg_bill,
        coalesce(x.inference_method,'single_unknown_residual'),coalesce(x.unknown_sku_count,1),x.source_hash
      FROM jsonb_to_recordset($1::jsonb) AS x(
        shop_key text,wdt_trade_no text,tracking_no text,platform_sku_id text,
        billable_weight_kg numeric,purchased_units numeric,estimated_unit_gross_kg numeric,
        packaging_assumption_kg numeric,known_anchors jsonb,source_batch_ids jsonb,
        coarse_one_kg_bill boolean,inference_method text,unknown_sku_count integer,source_hash text)
      ON CONFLICT(shop_key,wdt_trade_no,tracking_no,platform_sku_id) DO UPDATE SET
        billable_weight_kg=EXCLUDED.billable_weight_kg,purchased_units=EXCLUDED.purchased_units,
        estimated_unit_gross_kg=EXCLUDED.estimated_unit_gross_kg,
        packaging_assumption_kg=EXCLUDED.packaging_assumption_kg,
        known_anchors=EXCLUDED.known_anchors,source_batch_ids=EXCLUDED.source_batch_ids,
        coarse_one_kg_bill=EXCLUDED.coarse_one_kg_bill,
        inference_method=EXCLUDED.inference_method,unknown_sku_count=EXCLUDED.unknown_sku_count,
        active=true,
        source_hash=EXCLUDED.source_hash,updated_at=now()
      WHERE mart.platform_sku_gross_weight_residual_samples.source_hash<>EXCLUDED.source_hash
        OR NOT mart.platform_sku_gross_weight_residual_samples.active`,
    [JSON.stringify(chunk)]);
    changed+=result.rowCount;
  }
  return changed;
}

async function deactivateStaleSamples(client,shopKey,samples) {
  const keys=samples.map(row=>({wdt_trade_no:row.wdt_trade_no,
    tracking_no:row.tracking_no,platform_sku_id:row.platform_sku_id}));
  const result=await client.query(`WITH valid AS (
    SELECT x.wdt_trade_no,x.tracking_no,x.platform_sku_id
    FROM jsonb_to_recordset($2::jsonb) AS x(
      wdt_trade_no text,tracking_no text,platform_sku_id text)
  ) UPDATE mart.platform_sku_gross_weight_residual_samples s
    SET active=false,updated_at=now()
    WHERE s.shop_key=$1 AND s.active
      AND (s.wdt_trade_no,s.tracking_no,s.platform_sku_id) NOT IN (
        SELECT v.wdt_trade_no,v.tracking_no,v.platform_sku_id FROM valid v)`,
    [shopKey,JSON.stringify(keys)]);
  return result.rowCount;
}

async function refreshResidualEstimates(client,shopKey,runId) {
  const rows=await client.query(`SELECT platform_sku_id,wdt_trade_no,tracking_no,
    estimated_unit_gross_kg,known_anchors,coarse_one_kg_bill,
    inference_method,unknown_sku_count
    FROM mart.platform_sku_gross_weight_residual_samples WHERE shop_key=$1 AND active
    ORDER BY platform_sku_id,wdt_trade_no,tracking_no`,[shopKey]);
  const current=await client.query(`SELECT platform_sku_id,status,source_hash FROM master.current_platform_sku_gross_weights
    WHERE shop_key=$1`,[shopKey]);
  const currentBySku=new Map(current.rows.map(row=>[row.platform_sku_id,row]));
  const bySku=new Map();
  for(const row of rows.rows) {
    if(!bySku.has(row.platform_sku_id)) bySku.set(row.platform_sku_id,[]);
    bySku.get(row.platform_sku_id).push(row);
  }
  const changed=[];
  let inferredSkuCount=0;
  let sharedInferredSkuCount=0;
  for(const [sku,samples] of bySku) {
    if(['estimated','manual-estimate'].includes(currentBySku.get(sku)?.status)) continue;
    inferredSkuCount++;
    const estimate=summarizeResidualSamples(samples,`${shopKey}:${sku}:residual`);
    if(estimate.sourceType==='multi_sku_shared_residual') sharedInferredSkuCount++;
    const method=estimate.sourceType==='multi_sku_shared_residual'
      ? SHARED_RESIDUAL_METHOD:RESIDUAL_METHOD;
    const content={shopKey,sku,estimateKg:estimate.estimateKg,
      confidenceScore:estimate.confidenceScore,sampleCount:estimate.sampleCount,
      ciLow:estimate.ci95LowKg??null,ciHigh:estimate.ci95HighKg??null,
      method,evidence:estimate};
    const sourceHash=sha(JSON.stringify(content));
    if(currentBySku.get(sku)?.source_hash===sourceHash) continue;
    changed.push({shop_key:shopKey,platform_sku_id:sku,estimate_kg:estimate.estimateKg,
      confidence_score:estimate.confidenceScore,confidence_level:estimate.confidenceLevel,
      sample_count:estimate.sampleCount,candidate_count:estimate.sampleCount,
      ci95_low_kg:estimate.ci95LowKg??null,ci95_high_kg:estimate.ci95HighKg??null,
      status:'inferred',method,evidence:estimate,
      source_hash:sourceHash,run_id:runId});
  }
  let invalidatedInferredCount=0;
  for(const [sku,row] of currentBySku) {
    if(row.status!=='inferred' || bySku.has(sku)) continue;
    invalidatedInferredCount++;
    const evidence={reason:'no-active-multi-sku-sample'};
    changed.push({shop_key:shopKey,platform_sku_id:sku,estimate_kg:null,
      confidence_score:null,confidence_level:null,sample_count:0,candidate_count:0,
      ci95_low_kg:null,ci95_high_kg:null,status:'no-valid-multi-sku-sample',
      method:RESIDUAL_METHOD,evidence,
      source_hash:sha(JSON.stringify({shopKey,sku,evidence})),run_id:runId});
  }
  for(let offset=0;offset<changed.length;offset+=500) {
    const chunk=changed.slice(offset,offset+500);
    await client.query(`INSERT INTO master.current_platform_sku_gross_weights(
      shop_key,platform_sku_id,estimate_kg,confidence_score,confidence_level,
      sample_count,candidate_count,ci95_low_kg,ci95_high_kg,status,method,evidence,source_hash,run_id)
      SELECT x.shop_key,x.platform_sku_id,x.estimate_kg,x.confidence_score,x.confidence_level,
        x.sample_count,x.candidate_count,x.ci95_low_kg,x.ci95_high_kg,
        x.status,x.method,x.evidence,x.source_hash,x.run_id
      FROM jsonb_to_recordset($1::jsonb) AS x(
        shop_key text,platform_sku_id text,estimate_kg numeric,confidence_score numeric,
        confidence_level text,sample_count integer,candidate_count integer,
        ci95_low_kg numeric,ci95_high_kg numeric,status text,method text,
        evidence jsonb,source_hash text,run_id uuid)
      ON CONFLICT(shop_key,platform_sku_id) DO UPDATE SET
        estimate_kg=EXCLUDED.estimate_kg,confidence_score=EXCLUDED.confidence_score,
        confidence_level=EXCLUDED.confidence_level,sample_count=EXCLUDED.sample_count,
        candidate_count=EXCLUDED.candidate_count,ci95_low_kg=EXCLUDED.ci95_low_kg,
        ci95_high_kg=EXCLUDED.ci95_high_kg,status=EXCLUDED.status,method=EXCLUDED.method,
        evidence=EXCLUDED.evidence,source_hash=EXCLUDED.source_hash,
        run_id=EXCLUDED.run_id,updated_at=now()`,[JSON.stringify(chunk)]);
    await client.query(`INSERT INTO master.platform_sku_gross_weight_versions(
      run_id,shop_key,platform_sku_id,estimate_kg,confidence_score,confidence_level,
      sample_count,candidate_count,status,method,evidence,source_hash)
      SELECT x.run_id,x.shop_key,x.platform_sku_id,x.estimate_kg,x.confidence_score,
        x.confidence_level,x.sample_count,x.candidate_count,x.status,x.method,
        x.evidence,x.source_hash FROM jsonb_to_recordset($1::jsonb) AS x(
        run_id uuid,shop_key text,platform_sku_id text,estimate_kg numeric,
        confidence_score numeric,confidence_level text,sample_count integer,
        candidate_count integer,status text,method text,evidence jsonb,source_hash text)
      ON CONFLICT(run_id,shop_key,platform_sku_id) DO UPDATE SET
        estimate_kg=EXCLUDED.estimate_kg,confidence_score=EXCLUDED.confidence_score,
        confidence_level=EXCLUDED.confidence_level,sample_count=EXCLUDED.sample_count,
        candidate_count=EXCLUDED.candidate_count,status=EXCLUDED.status,
        method=EXCLUDED.method,evidence=EXCLUDED.evidence,source_hash=EXCLUDED.source_hash`,
      [JSON.stringify(chunk)]);
  }
  return { inferredSkuCount,sharedInferredSkuCount,
    changedInferredCount:changed.length,invalidatedInferredCount };
}

export async function updateResidualGrossWeights(client,{shopKey,batchIds,runId}) {
  await ensureResidualSchema(client);
  const candidates=(await client.query(MULTI_PACKAGE_SQL,[batchIds,shopKey])).rows;
  const changedPackages=await upsertPackages(client,candidates.map(normalizedPackage));
  const direct=(await client.query(`SELECT platform_sku_id,estimate_kg,confidence_score,
    sample_count,run_id FROM master.current_platform_sku_gross_weights
    WHERE shop_key=$1 AND status='estimated' AND estimate_kg>0 AND sample_count>0`,[shopKey])).rows;
  const anchors=new Map(direct.map(row=>[row.platform_sku_id,{
    estimateKg:Number(row.estimate_kg),confidenceScore:Number(row.confidence_score),
    sampleCount:row.sample_count,runId:row.run_id,
  }]));
  const packages=(await client.query(`SELECT shop_key,wdt_trade_no,tracking_no,
    billable_weight_kg,source_batch_ids,items
    FROM mart.platform_sku_gross_weight_multi_packages WHERE shop_key=$1`,[shopKey])).rows;
  const samples=packages.flatMap(pkg=>deriveResidualSamples(pkg,anchors));
  const changedResidualSamples=await upsertResidualSamples(client,samples);
  const deactivatedResidualSampleCount=await deactivateStaleSamples(client,shopKey,samples);
  const estimates=await refreshResidualEstimates(client,shopKey,runId);
  return {multiPackageCount:candidates.length,changedMultiPackageCount:changedPackages,
    residualSampleCount:samples.length,changedResidualSampleCount:changedResidualSamples,
    deactivatedResidualSampleCount,
    sharedResidualSampleCount:samples.filter(row=>row.inference_method==='shared_unknown_residual').length,
    ...estimates};
}
