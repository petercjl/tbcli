import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { ensureSkuGrossSchema } from './platform-sku-gross-weights.mjs';

export const MANUAL_GROSS_METHOD = 'platform-sku-gross-manual-v1';
export const MANUAL_GROSS_STATUS = 'manual-estimate';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');

export function validateManualGrossInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('人工毛重输入须为 JSON 对象');
  const source = input.source;
  if (!source || typeof source !== 'object' || !source.name || !source.uri)
    throw new Error('人工毛重输入需要 source.name 和 source.uri');
  if (!Array.isArray(input.weights) || !input.weights.length || input.weights.length > 10000)
    throw new Error('weights 需要 1–10000 条记录');
  const seen = new Set();
  const weights = input.weights.map((item, index) => {
    const sku = String(item?.platformSkuId ?? '').trim();
    const productId = item?.platformProductId == null ? null : String(item.platformProductId).trim();
    const estimateKg = Number(item?.estimateKg);
    if (!/^\d{8,20}$/.test(sku)) throw new Error(`第 ${index + 1} 条平台 SKU ID 无效`);
    if (productId && !/^\d{8,20}$/.test(productId)) throw new Error(`SKU ${sku} 的商品 ID 无效`);
    if (!Number.isFinite(estimateKg) || estimateKg <= 0 || estimateKg > 100)
      throw new Error(`SKU ${sku} 的人工毛重须为 0–100 kg 内的正数`);
    if (seen.has(sku)) throw new Error(`平台 SKU ID 重复：${sku}`);
    seen.add(sku);
    const sourceRow = Number(item.sourceRow);
    if (!Number.isInteger(sourceRow) || sourceRow < 1) throw new Error(`SKU ${sku} 缺少有效 sourceRow`);
    return { platformSkuId:sku,platformProductId:productId || null,
      estimateKg:Number(estimateKg.toFixed(6)),sourceRow };
  });
  return { source:{ name:String(source.name),uri:String(source.uri),
    revision:source.revision == null ? null : String(source.revision) },weights };
}

export async function readManualGrossInput(file) {
  if (!file) throw new Error('需要 --input JSON 文件');
  return validateManualGrossInput(JSON.parse(await fs.readFile(file,'utf8')));
}

export async function importManualGrossWeights(client,{shopKey,input}) {
  if (!shopKey) throw new Error('需要 --shop-key');
  const normalized=validateManualGrossInput(input);
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL statement_timeout='600000ms'");
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`tbcli:platform-sku-gross:${shopKey}`]);
    await ensureSkuGrossSchema(client);
    const ids=normalized.weights.map(row=>row.platformSkuId);
    const existing=(await client.query(`SELECT platform_sku_id,status,estimate_kg,source_hash
      FROM master.current_platform_sku_gross_weights
      WHERE shop_key=$1 AND platform_sku_id=ANY($2::text[])`,[shopKey,ids])).rows;
    const bySku=new Map(existing.map(row=>[row.platform_sku_id,row]));
    const runId=crypto.randomUUID();
    const skippedObserved=[],unchanged=[],changed=[];
    for (const row of normalized.weights) {
      const old=bySku.get(row.platformSkuId);
      // Courier evidence takes precedence. A manual value never downgrades an observed estimate.
      if (old && ['estimated','inferred'].includes(old.status) && Number(old.estimate_kg)>0) {
        skippedObserved.push(row.platformSkuId);continue;
      }
      const evidence={sourceType:'manual_estimate',source:normalized.source,
        sourceRow:row.sourceRow,replacementRule:'valid_single_sku_one_unit_courier_sample',
        note:'No courier sample supports this value; confidence is deliberately low.'};
      const sourceHash=sha(JSON.stringify({shopKey,sku:row.platformSkuId,
        productId:row.platformProductId,estimateKg:row.estimateKg,
        sourceUri:normalized.source.uri,sourceRow:row.sourceRow,method:MANUAL_GROSS_METHOD}));
      if (old?.source_hash===sourceHash) {unchanged.push(row.platformSkuId);continue;}
      changed.push({shop_key:shopKey,platform_sku_id:row.platformSkuId,
        platform_product_id:row.platformProductId,estimate_kg:row.estimateKg,
        confidence_score:0.05,confidence_level:'low',sample_count:0,candidate_count:0,
        status:MANUAL_GROSS_STATUS,method:MANUAL_GROSS_METHOD,evidence,
        source_hash:sourceHash,run_id:runId});
    }
    if (changed.length) {
      await client.query(`INSERT INTO master.current_platform_sku_gross_weights(
        shop_key,platform_sku_id,platform_product_id,estimate_kg,confidence_score,
        confidence_level,sample_count,candidate_count,ci95_low_kg,ci95_high_kg,
        status,method,evidence,source_hash,run_id)
        SELECT x.shop_key,x.platform_sku_id,x.platform_product_id,x.estimate_kg,
          x.confidence_score,x.confidence_level,x.sample_count,x.candidate_count,
          NULL,NULL,x.status,x.method,x.evidence,x.source_hash,x.run_id
        FROM jsonb_to_recordset($1::jsonb) AS x(
          shop_key text,platform_sku_id text,platform_product_id text,estimate_kg numeric,
          confidence_score numeric,confidence_level text,sample_count integer,candidate_count integer,
          status text,method text,evidence jsonb,source_hash text,run_id uuid)
        ON CONFLICT(shop_key,platform_sku_id) DO UPDATE SET
          platform_product_id=EXCLUDED.platform_product_id,estimate_kg=EXCLUDED.estimate_kg,
          confidence_score=EXCLUDED.confidence_score,confidence_level=EXCLUDED.confidence_level,
          sample_count=EXCLUDED.sample_count,candidate_count=EXCLUDED.candidate_count,
          ci95_low_kg=NULL,ci95_high_kg=NULL,status=EXCLUDED.status,method=EXCLUDED.method,
          evidence=EXCLUDED.evidence,source_hash=EXCLUDED.source_hash,
          run_id=EXCLUDED.run_id,updated_at=now()`,[JSON.stringify(changed)]);
      await client.query(`INSERT INTO master.platform_sku_gross_weight_versions(
        run_id,shop_key,platform_sku_id,estimate_kg,confidence_score,confidence_level,
        sample_count,candidate_count,status,method,evidence,source_hash)
        SELECT x.run_id,x.shop_key,x.platform_sku_id,x.estimate_kg,x.confidence_score,
          x.confidence_level,x.sample_count,x.candidate_count,x.status,x.method,
          x.evidence,x.source_hash FROM jsonb_to_recordset($1::jsonb) AS x(
          run_id uuid,shop_key text,platform_sku_id text,estimate_kg numeric,
          confidence_score numeric,confidence_level text,sample_count integer,
          candidate_count integer,status text,method text,evidence jsonb,source_hash text)`,
      [JSON.stringify(changed)]);
    }
    const digest=sha(JSON.stringify(normalized));
    await client.query(`INSERT INTO meta.platform_sku_gross_weight_runs(
      run_id,shop_key,mode,method,source_batch_ids,source_file_names,source_digest,
      candidate_count,valid_sample_count,changed_sample_count,affected_sku_count,
      changed_estimate_count,status)
      VALUES($1,$2,'manual-import',$3,'[]'::jsonb,$4::jsonb,$5,$6,0,0,$7,$8,'complete')`,
    [runId,shopKey,MANUAL_GROSS_METHOD,JSON.stringify([normalized.source.name]),
      digest,normalized.weights.length,changed.length,changed.length]);
    const verified=(await client.query(`SELECT count(*)::int AS n FROM master.current_platform_sku_gross_weights
      WHERE shop_key=$1 AND run_id=$2 AND status=$3`,[shopKey,runId,MANUAL_GROSS_STATUS])).rows[0].n;
    if (verified!==changed.length) throw new Error('人工毛重写后核验数量不符');
    await client.query('COMMIT');
    return {runId,shopKey,source:normalized.source,requested:normalized.weights.length,
      imported:changed.length,unchanged:unchanged.length,skippedObserved:skippedObserved.length,
      skippedObservedSkus:skippedObserved,verified,wrote:true};
  } catch(error) {await client.query('ROLLBACK');throw error;}
}
