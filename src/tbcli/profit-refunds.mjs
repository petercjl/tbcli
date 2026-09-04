import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ensureProfitOrderSchema } from './profit-orders.mjs';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const text = (v) => v == null || String(v).trim() === '' ? null : String(v).trim();
const datePart = (v) => text(v)?.slice(0, 10) || null;
const sha = (v) => crypto.createHash('sha256').update(v).digest('hex');
const num = (v) => v == null || v === '' ? null : Number(v);
const ts = (v) => {
  const s = text(v); if (!s) return null;
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})/);
  return m ? `${m[1]}T${m[2]}+08:00` : null;
};

export async function ensureProfitRefundSchema(client) {
  await ensureProfitOrderSchema(client);
  await client.query(`
    CREATE TABLE IF NOT EXISTS raw.wdt_refund_headers(
      shop_key text NOT NULL, refund_no text NOT NULL, wdt_trade_no text, wdt_trade_id text,
      platform_refund_nos jsonb, platform_trade_ids jsonb, wdt_shop_id text NOT NULL, shop_name text NOT NULL,
      refund_type integer, refund_type_text text, refund_status integer, refund_status_text text,
      platform_status integer, platform_status_text text, applied_at timestamptz NOT NULL,
      settled_at timestamptz, closed_at timestamptz, paid_at timestamptz,
      return_amount numeric, actual_refund_amount numeric, refunded_amount numeric, refund_quantity numeric,
      is_financially_refunded boolean NOT NULL, source_refund jsonb NOT NULL,
      source_batch_id uuid NOT NULL REFERENCES meta.profit_source_batches(batch_id), observed_at timestamptz NOT NULL,
      PRIMARY KEY(shop_key,refund_no));
    CREATE INDEX IF NOT EXISTS wdt_refund_headers_apply_idx ON raw.wdt_refund_headers(shop_key,applied_at);
    CREATE INDEX IF NOT EXISTS wdt_refund_headers_settle_idx ON raw.wdt_refund_headers(shop_key,settled_at) WHERE is_financially_refunded;
    CREATE TABLE IF NOT EXISTS raw.wdt_refund_lines(
      shop_key text NOT NULL, refund_line_key text NOT NULL, refund_no text NOT NULL,
      refund_item_id text, wdt_order_line_id text, source_order_line_id text,
      platform_product_id text, platform_sku_id text, erp_spec_no text, erp_goods_no text,
      product_name text, sku_name text, ordered_quantity numeric, refund_quantity numeric,
      refund_amount numeric, actual_refund_amount numeric, refunded_amount numeric,
      refund_status integer, stockin_status integer, source_line jsonb NOT NULL,
      source_batch_id uuid NOT NULL REFERENCES meta.profit_source_batches(batch_id), observed_at timestamptz NOT NULL,
      PRIMARY KEY(shop_key,refund_line_key),
      FOREIGN KEY(shop_key,refund_no) REFERENCES raw.wdt_refund_headers(shop_key,refund_no));
    CREATE INDEX IF NOT EXISTS wdt_refund_lines_refund_idx ON raw.wdt_refund_lines(shop_key,refund_no);
    CREATE INDEX IF NOT EXISTS wdt_refund_lines_product_idx ON raw.wdt_refund_lines(shop_key,platform_product_id,platform_sku_id);
  `);
}

export async function validateProfitRefundExport(input, { shopKey, shopName } = {}) {
  if (!input || !shopKey || !shopName) throw new Error('退款校验需要 --input、--shop-key 和 --shop-name');
  const file = path.resolve(input); const bytes = await fsp.readFile(file); const fileSha256 = sha(bytes);
  const doc = JSON.parse(bytes.toString('utf8')); const metadata = doc?.metadata || {}; const refunds = doc?.refunds;
  const errors = []; if (!Array.isArray(refunds)) return { ok:false,file,fileSha256,errors:[{code:'REFUNDS_NOT_ARRAY'}] };
  const start = datePart(metadata.query?.applyTimeBegin); const end = datePart(metadata.query?.applyTimeEnd);
  if (!start || !end || start > end) errors.push({code:'REFUND_COVERAGE_INVALID'});
  if (metadata.channel !== 'erp-web' || metadata.query?.timeField !== 'applyTime') errors.push({code:'REFUND_SOURCE_UNSUPPORTED'});
  if (Number(metadata.apiTotal) !== refunds.length || (metadata.apiTotalAfter != null && Number(metadata.apiTotalAfter) !== refunds.length)) errors.push({code:'REFUND_COUNT_MISMATCH'});
  const refundsSha256 = sha(JSON.stringify(refunds)); if (metadata.refundsSha256 && metadata.refundsSha256 !== refundsSha256) errors.push({code:'REFUND_ARRAY_SHA256_MISMATCH'});
  const headers=[]; const lines=[]; const seen=new Set(); const seenLines=new Set();
  refunds.forEach((r,i)=>{
    const refundNo=text(r.refundNo), applyDate=datePart(r.applyTime), actualShop=text(r.shopName), shopId=text(r.shopId);
    if (!refundNo || seen.has(refundNo)) errors.push({code:'REFUND_KEY_INVALID',index:i,refundNo}); else seen.add(refundNo);
    if (actualShop !== shopName || !shopId) errors.push({code:'REFUND_SHOP_MISMATCH',index:i,expected:shopName,actual:actualShop});
    if (!applyDate || applyDate < start || applyDate > end) errors.push({code:'REFUND_OUTSIDE_COVERAGE',index:i,applyDate,start,end});
    headers.push({shop_key:shopKey,refund_no:refundNo,wdt_trade_no:text(r.tradeNo),wdt_trade_id:text(r.tradeId),platform_refund_nos:r.platformRefundNos??null,platform_trade_ids:r.tids??null,wdt_shop_id:shopId,shop_name:actualShop,refund_type:Number.isInteger(r.type)?r.type:null,refund_type_text:text(r.typeText),refund_status:Number.isInteger(r.status)?r.status:null,refund_status_text:text(r.statusText),platform_status:Number.isInteger(r.platformStatus)?r.platformStatus:null,platform_status_text:text(r.platformStatusText),applied_at:ts(r.applyTime),settled_at:ts(r.settlementTime),closed_at:ts(r.closeTime),paid_at:ts(r.payTime),return_amount:num(r.returnAmount),actual_refund_amount:num(r.actualRefundAmount),refunded_amount:num(r.refundedAmount),refund_quantity:num(r.refundNum),is_financially_refunded:Boolean(r.isFinanciallyRefunded),source_refund:r});
    (Array.isArray(r.items)?r.items:[]).forEach((item,j)=>{
      const stable=text(item.refundItemId); const signature=[refundNo,text(item.tradeItemId),text(item.oid),text(item.apiSpuId),text(item.apiSkuId),j].join('\0');
      const key=stable?`id:${stable}`:`fallback:${sha(signature).slice(0,32)}`; if(seenLines.has(key)) errors.push({code:'REFUND_LINE_DUPLICATE',index:i,itemIndex:j,key}); seenLines.add(key);
      lines.push({shop_key:shopKey,refund_line_key:key,refund_no:refundNo,refund_item_id:stable,wdt_order_line_id:text(item.tradeItemId),source_order_line_id:text(item.oid),platform_product_id:text(item.apiSpuId),platform_sku_id:text(item.apiSkuId),erp_spec_no:text(item.skuNo),erp_goods_no:text(item.spuNo),product_name:text(item.spuName),sku_name:text(item.skuName),ordered_quantity:num(item.orderedNum),refund_quantity:num(item.refundNum),refund_amount:num(item.refundAmount),actual_refund_amount:num(item.actualRefundAmount),refunded_amount:num(item.refundedAmount),refund_status:Number.isInteger(item.status)?item.status:null,stockin_status:Number.isInteger(item.stockinStatus)?item.stockinStatus:null,source_line:item});
    });
  });
  if(metadata.exportedItemRows!=null && Number(metadata.exportedItemRows)!==lines.length) errors.push({code:'REFUND_LINE_COUNT_MISMATCH'});
  return {ok:errors.length===0,file,fileSha256,refundsSha256,shopKey,shopName,coverageStart:start,coverageEnd:end,observedAt:text(metadata.exportedAt)||new Date().toISOString(),sourceSchemaVersion:Number(metadata.schemaVersion)||1,sourceChannel:metadata.channel,refundCount:headers.length,lineCount:lines.length,errors,metadata,rows:{headers,lines}};
}

async function chunks(client, table, rows, batch, observed) {
  for(let i=0;i<rows.length;i+=500){const data=rows.slice(i,i+500).map(r=>({...r,source_batch_id:batch,observed_at:observed})); await client.query(`INSERT INTO ${table} SELECT x.* FROM jsonb_populate_recordset(NULL::${table},$1::jsonb) x ON CONFLICT DO NOTHING`,[JSON.stringify(data)]);}
}

export async function importProfitRefundExport(client,v){
  if(!v.ok) throw new Error('退款导出未通过校验'); await ensureProfitRefundSchema(client);
  const old=await client.query(`SELECT batch_id,status,order_count,line_count,coverage_start,coverage_end,imported_at FROM meta.profit_source_batches WHERE source_sha256=$1`,[v.fileSha256]); if(old.rowCount) return {alreadyImported:true,...old.rows[0]};
  const batch=crypto.randomUUID(); await client.query('BEGIN'); try{
    await client.query(`INSERT INTO meta.profit_source_batches(batch_id,source_type,shop_key,source_file,source_sha256,source_schema_version,source_channel,query_time_field,coverage_start,coverage_end,observed_at,order_count,line_count,shipment_count,status,source_metadata) VALUES($1,'wdt-refunds',$2,$3,$4,$5,$6,'applyTime',$7,$8,$9,$10,$11,0,'importing',$12::jsonb)`,[batch,v.shopKey,path.basename(v.file),v.fileSha256,v.sourceSchemaVersion,v.sourceChannel,v.coverageStart,v.coverageEnd,v.observedAt,v.refundCount,v.lineCount,JSON.stringify(v.metadata)]);
    const refundNos=v.rows.headers.map(r=>r.refund_no); if(refundNos.length){await client.query(`DELETE FROM raw.wdt_refund_lines WHERE shop_key=$1 AND refund_no=ANY($2::text[])`,[v.shopKey,refundNos]);await client.query(`DELETE FROM raw.wdt_refund_headers WHERE shop_key=$1 AND refund_no=ANY($2::text[])`,[v.shopKey,refundNos]);}
    await chunks(client,'raw.wdt_refund_headers',v.rows.headers,batch,v.observedAt); await chunks(client,'raw.wdt_refund_lines',v.rows.lines,batch,v.observedAt);
    await client.query(`UPDATE meta.profit_source_batches SET status='imported',imported_at=now() WHERE batch_id=$1`,[batch]); await client.query('COMMIT');
  }catch(e){await client.query('ROLLBACK');throw e;} return {alreadyImported:false,batchId:batch,sourceSha256:v.fileSha256,coverageStart:v.coverageStart,coverageEnd:v.coverageEnd,refundCount:v.refundCount,lineCount:v.lineCount};
}

function dates(a,b){const out=[];for(let d=new Date(a+'T00:00:00Z'),e=new Date(b+'T00:00:00Z');d<=e;d=new Date(d.getTime()+86400000))out.push(d.toISOString().slice(0,10));return out;}
function periods(ds){if(!ds.length)return[];const out=[];let a=ds[0],p=a;for(const d of ds.slice(1)){if(new Date(d)-new Date(p)!==86400000){out.push({startDate:a,endDate:p});a=d;}p=d;}out.push({startDate:a,endDate:p});return out;}
export async function getProfitRefundCoverage(client,{shopKey,startDate,endDate}){if(!shopKey||!DATE.test(startDate)||!DATE.test(endDate))throw new Error('退款覆盖需要 shop-key 和 YYYY-MM-DD 日期');await ensureProfitRefundSchema(client);const r=await client.query(`SELECT batch_id,coverage_start::text,coverage_end::text,order_count AS refund_count,line_count,imported_at FROM meta.profit_source_batches WHERE source_type='wdt-refunds' AND shop_key=$1 AND status='imported' AND coverage_end >= $2 AND coverage_start <= $3 ORDER BY coverage_start`,[shopKey,startDate,endDate]);const covered=new Set();for(const x of r.rows)for(const d of dates(x.coverage_start>startDate?x.coverage_start:startDate,x.coverage_end<endDate?x.coverage_end:endDate))covered.add(d);const all=dates(startDate,endDate),missing=all.filter(d=>!covered.has(d));const c=await client.query(`SELECT count(*)::bigint refunds,(SELECT count(*)::bigint FROM raw.wdt_refund_lines l JOIN raw.wdt_refund_headers h USING(shop_key,refund_no) WHERE h.shop_key=$1 AND (h.applied_at AT TIME ZONE 'Asia/Shanghai')::date BETWEEN $2 AND $3) lines FROM raw.wdt_refund_headers h WHERE h.shop_key=$1 AND (h.applied_at AT TIME ZONE 'Asia/Shanghai')::date BETWEEN $2 AND $3`,[shopKey,startDate,endDate]);return{dataset:'旺店通-退款及明细',shopKey,startDate,endDate,complete:!missing.length,coveredDays:covered.size,expectedDays:all.length,missingPeriods:periods(missing),batches:r.rows,rows:c.rows[0]};}

export function scanForbiddenRefundKeys(file){const raw=fs.readFileSync(file,'utf8');return ['receiver','mobile','phone','address','buyerNick','remark','customerMessage'].filter(k=>new RegExp(`"${k}"\\s*:`, 'i').test(raw));}
