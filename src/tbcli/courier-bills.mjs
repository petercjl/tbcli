import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import {readCourierSheet} from './courier-xlsx.mjs';

const sha = v => crypto.createHash('sha256').update(v).digest('hex');
export const PARSER_VERSION = 'courier-v1';
const formats = {
  sto: { sheet:'Sheet1', key:'运单号', date:'业务时间', amount:'应收金额', required:['中转费/运费','附加费','异形件','加收费','结算重量'] },
  yunda: { sheet:'Sheet1', key:'单号', date:'账单日期', amount:null, required:['应收金额','结算重量','商家名称'] },
  jt: { sheet:'寄件明细', key:'运单编号', date:'寄件时间', amount:'合计金额', required:['收入','税费','预充金额','客户名称'] },
  sf: { sheet:'账单明细', key:'运单号码', date:'日期', amount:'应付金额', required:['费用(元)','折扣/促销','服务'] },
};
function value(v) {
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    if ('formula' in v || 'sharedFormula' in v) return value(v.result);
    if (v.richText) return v.richText.map(x=>x.text).join('');
    if (v.error) throw new Error(`EXCEL_ERROR: ${v.error}`);
    if ('text' in v) return v.text;
  }
  return v ?? null;
}
const text = v => v == null || String(v).trim()==='' ? null : String(v).trim();
// Decimal arithmetic uses fixed-point integers. Source amounts with more than
// eight significant fractional digits fail instead of being silently rounded.
export function decimal(v) {
  if (v == null || v === '') return null;
  if(typeof v==='number' && (!Number.isFinite(v)||Math.abs(v-Number(v.toFixed(8)))>Math.max(1e-12,Math.abs(v)*Number.EPSILON*4)))throw new Error('DECIMAL_PRECISION_UNSUPPORTED');
  let s = typeof v === 'number' ? v.toFixed(8) : String(v).trim().replaceAll(',','');
  if (!/^-?\d+(\.\d+)?$/.test(s)) throw new Error('INVALID_DECIMAL');
  s=s.replace(/(\.\d*?)0+$/,'$1').replace(/\.$/,'');
  const [a,b='']=s.split('.');
  if(b.length>8) throw new Error('DECIMAL_PRECISION_UNSUPPORTED');
  return (a==='-0' && !b ? '0' : a)+(b?'.'+b:'');
}
const units = s => { const neg=s.startsWith('-');const [a,b='']=s.replace(/^-/,'').split('.');return (neg?-1n:1n)*(BigInt(a)*100000000n+BigInt(b.padEnd(8,'0'))); };
const ununits = n => {const neg=n<0n;if(neg)n=-n;return decimal(`${neg?'-':''}${n/100000000n}.${String(n%100000000n).padStart(8,'0')}`);};
export const sumAmounts = xs => ununits(xs.reduce((s,x)=>s+units(x),0n));
export function billDate(v, month) {
  let s;
  if(v instanceof Date) s=v.toISOString().slice(0,10);
  else if(typeof v==='number') s=new Date(Date.UTC(1899,11,30)+Math.round(v*86400000)).toISOString().slice(0,10);
  else {s=text(v);if(/^\d{2}-\d{2}$/.test(s))s=month.slice(0,4)+'-'+s;else s=s?.slice(0,10);}
  if(!/^\d{4}-\d{2}-\d{2}$/.test(s) || !Number.isFinite(Date.parse(s+'T00:00:00Z')) || new Date(s+'T00:00:00Z').toISOString().slice(0,10)!==s)throw new Error('INVALID_DATE');
  return s;
}
export function normalizeCharge(source, {carrier,billMonth}) {
  const f=formats[carrier]; if(!f)throw new Error('UNSUPPORTED_CARRIER');
  const get=k=>source[k]??null, d=k=>decimal(get(k));
  const tracking=text(get(f.key));
  if(!/^(?:JT|SF)?\d{8,}$/i.test(tracking||'')) throw new Error('INVALID_TRACKING_NO');
  const amountKey=carrier==='yunda' ? ('韵达运费' in source?'韵达运费':'快递运费') : f.amount;
  const amount=d(amountKey);if(amount===null)throw new Error('MISSING_CHARGE_AMOUNT');
  const row={carrier,tracking_no:tracking,business_date:billDate(get(f.date),billMonth),date_field:f.date,bill_month:billMonth,
    charge_amount:amount,amount_field:amountKey,customer_name:null,destination_province:null,destination_city:null,destination_raw:null,
    billable_weight_kg:null,base_freight:null,extra_charges:null,tax_amount:null,discount_amount:null,prepaid_offset:null,charge_type:null,remarks:null};
  if(carrier==='sto') Object.assign(row,{customer_name:text(get('订单客户')),destination_province:text(get('目的省份')),destination_city:text(get('目的城市')),billable_weight_kg:d('结算重量'),base_freight:d('中转费/运费'),extra_charges:{'附加费':d('附加费'),'异形件':d('异形件'),'加收费':d('加收费')},prepaid_offset:d('预收面单费'),charge_type:'综合运费'});
  if(carrier==='yunda') Object.assign(row,{customer_name:text(get('商家名称')),destination_province:text(get('目的地省')??get('目的')),billable_weight_kg:d('结算重量'),prepaid_offset:d('应收金额')===null?null:sumAmounts([amount,ununits(-units(d('应收金额')))])});
  if(carrier==='jt') Object.assign(row,{customer_name:text(get('客户名称')),destination_province:text(get('收件省份')),destination_city:text(get('收件城市')),destination_raw:text(get('目的地')),billable_weight_kg:d('内部计费重量'),base_freight:d('收入'),tax_amount:d('税费'),prepaid_offset:d('预充金额'),charge_type:/退转件/.test(get('客户名称')||'')?'退转件':null});
  if(carrier==='sf') Object.assign(row,{destination_raw:text(get('到件地区')),billable_weight_kg:d('计费重量'),base_freight:get('服务')==='运费'?d('费用(元)'):null,extra_charges:get('服务')!=='运费'?{[get('服务')]:d('费用(元)')}:null,discount_amount:d('折扣/促销'),charge_type:text(get('服务'))});
  return row;
}

export async function validateCourierBill(input, {carrier,billMonth}={}) {
  if(!input||!formats[carrier]||!/^\d{4}-(0[1-9]|1[0-2])$/.test(billMonth||''))throw new Error('需要 --input FILE --carrier sto|yunda|jt|sf --bill-month YYYY-MM');
  const file=path.resolve(input),bytes=await fs.readFile(file),f=formats[carrier];
  const sheet=readCourierSheet(bytes,f.sheet);
  const rows=[],errors=[],seen=new Set();let found=false,headers=null,footerRows=0,excludedSection=false;const outside=new Set();
    for(const r of sheet.rows) {
      const vals=r.values.map(value);
      if(carrier==='sf' && vals.some(v=>typeof v==='string'&&v.includes('月结权益优惠')))excludedSection=true;
      if(excludedSection){footerRows++;continue;}
      if(!headers) {
        if(!vals.includes(f.key)||!vals.includes(f.date))continue;
        headers=vals.map(v=>text(v));found=true;
        const required=[f.key,f.date,...f.required,...(f.amount?[f.amount]:[])];
        if(required.some(k=>!headers.includes(k)) || (carrier==='yunda'&&!headers.includes('韵达运费')&&!headers.includes('快递运费')))throw new Error('BILL_HEADERS_UNSUPPORTED');
        continue;
      }
      const source={};headers.forEach((h,i)=>{if(h)source[h]=vals[i]??null;});
      if(sheet.date1904&&typeof source[f.date]==='number')source[f.date]=new Date(Date.UTC(1904,0,1)+Math.round(source[f.date]*86400000));
      if(carrier==='sto' && /^(件量|账单合计|预收面单费|五省超出加收|剩余应收)$/.test(text(source[f.date])||'')){footerRows++;continue;}
      const key=text(source[f.key]);
      if(!key){
        if(typeof source[f.date]==='string'&&/^合计/.test(source[f.date])){footerRows++;continue;}
        if(source[f.date]!=null && (source[f.amount] != null || source['韵达运费'] != null || source['快递运费'] != null))errors.push({row:r.number,code:'MISSING_TRACKING_NO'});
        else footerRows++;
        continue;
      }
      if(!/^(?:JT|SF)?\d{8,}$/i.test(key)) {
        if(key===f.key||/^(合计|总计|小计|汇总)/.test(key)){footerRows++;continue;}
        errors.push({row:r.number,code:'INVALID_TRACKING_NO'});continue;
      }
      try {
        const normalized=normalizeCharge(source,{carrier,billMonth});
        if(!normalized.business_date.startsWith(billMonth))outside.add(normalized.business_date);
        const fingerprint=sha(JSON.stringify(normalized));
        if(seen.has(fingerprint))throw new Error('DUPLICATE_IDENTICAL_CHARGE_REVIEW_REQUIRED');
        seen.add(fingerprint);
        rows.push({...normalized,source_sheet:f.sheet,source_row:r.number,source_data:source,charge_fingerprint:fingerprint});
      } catch(e){errors.push({row:r.number,code:e.message});}
    }
  if(!found||!rows.length)errors.push({code:'NO_CHARGE_ROWS'});
  const waybills=new Set(rows.map(r=>r.tracking_no));
  return {ok:!errors.length,file,fileSha256:sha(bytes),contentSha256:sha([...seen].sort().join('\n')),carrier,billMonth,parserVersion:PARSER_VERSION,
    detailCount:rows.length,waybillCount:waybills.size,extraChargeRows:rows.length-waybills.size,amount:sumAmounts(rows.map(r=>r.charge_amount)),
    negativeCount:rows.filter(r=>units(r.charge_amount)<0n).length,datesOutsideBillMonth:[...outside].sort(),footerRows,errors,rows};
}
export const billSummary = ({rows,...rest})=>rest;

export async function ensureCourierSchema(c) {
  await c.query(`CREATE SCHEMA IF NOT EXISTS meta; CREATE SCHEMA IF NOT EXISTS raw;
    CREATE TABLE IF NOT EXISTS meta.courier_bill_batches(
      batch_id uuid PRIMARY KEY,source_file text NOT NULL,source_sha256 text NOT NULL UNIQUE,
      content_sha256 text NOT NULL UNIQUE,carrier text NOT NULL,bill_month text NOT NULL,parser_version text NOT NULL,
      detail_count integer NOT NULL,waybill_count integer NOT NULL,charge_amount numeric NOT NULL,imported_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS raw.courier_bill_charges(
      charge_id uuid PRIMARY KEY,source_batch_id uuid NOT NULL REFERENCES meta.courier_bill_batches(batch_id),
      carrier text NOT NULL,tracking_no text NOT NULL,business_date date NOT NULL,date_field text NOT NULL,bill_month text NOT NULL,
      charge_amount numeric NOT NULL,amount_field text NOT NULL,customer_name text,destination_province text,destination_city text,destination_raw text,
      billable_weight_kg numeric,base_freight numeric,extra_charges jsonb,tax_amount numeric,discount_amount numeric,prepaid_offset numeric,charge_type text,remarks text,
      source_sheet text NOT NULL,source_row integer NOT NULL,source_data jsonb NOT NULL,charge_fingerprint text NOT NULL UNIQUE,
      UNIQUE(source_batch_id,source_sheet,source_row));
    CREATE INDEX IF NOT EXISTS courier_tracking_idx ON raw.courier_bill_charges(tracking_no,carrier);
    CREATE INDEX IF NOT EXISTS courier_date_idx ON raw.courier_bill_charges(business_date);`);
}
export async function importCourierBill(c,v) {
  if(!v.ok)throw new Error('BILL_VALIDATION_FAILED');
  await c.query('BEGIN');
  try {
    await c.query(`SELECT pg_advisory_xact_lock(734291826)`);
    await ensureCourierSchema(c);
    const old=await c.query('SELECT * FROM meta.courier_bill_batches WHERE source_sha256=$1 OR content_sha256=$2 OR (source_file=$3 AND carrier=$4 AND bill_month=$5)',[v.fileSha256,v.contentSha256,path.basename(v.file),v.carrier,v.billMonth]);
    if(old.rowCount){
      if(old.rows[0].carrier!==v.carrier||old.rows[0].bill_month!==v.billMonth)throw new Error('PREVIOUS_IMPORT_IDENTITY_MISMATCH');
      if(old.rows[0].source_sha256!==v.fileSha256&&old.rows[0].content_sha256!==v.contentSha256)throw new Error('CORRECTED_BILL_REVIEW_REQUIRED');
      await c.query('COMMIT');return {alreadyImported:true,batch:old.rows[0]};
    }
    const overlaps=await c.query('SELECT count(*)::int n FROM raw.courier_bill_charges WHERE charge_fingerprint=ANY($1::text[]) OR (carrier=$2 AND bill_month=$3 AND tracking_no=ANY($4::text[]))',[v.rows.map(r=>r.charge_fingerprint),v.carrier,v.billMonth,[...new Set(v.rows.map(r=>r.tracking_no))]]);
    if(overlaps.rows[0].n>0)throw new Error(`OVERLAPPING_BILL_REVIEW_REQUIRED: ${overlaps.rows[0].n}`);
    const id=crypto.randomUUID();
    await c.query('INSERT INTO meta.courier_bill_batches(batch_id,source_file,source_sha256,content_sha256,carrier,bill_month,parser_version,detail_count,waybill_count,charge_amount) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[id,path.basename(v.file),v.fileSha256,v.contentSha256,v.carrier,v.billMonth,v.parserVersion,v.detailCount,v.waybillCount,v.amount]);
    for(let i=0;i<v.rows.length;i+=500) {
      const data=v.rows.slice(i,i+500).map(r=>({...r,charge_id:crypto.randomUUID(),source_batch_id:id}));
      await c.query('INSERT INTO raw.courier_bill_charges SELECT x.* FROM jsonb_populate_recordset(NULL::raw.courier_bill_charges,$1::jsonb) x',[JSON.stringify(data)]);
    }
    const verified=await c.query('SELECT count(*)::int n,sum(charge_amount)::text amount FROM raw.courier_bill_charges WHERE source_batch_id=$1',[id]);
    if(verified.rows[0].n!==v.detailCount||decimal(verified.rows[0].amount)!==v.amount)throw new Error('IMPORT_VERIFY_FAILED');
    await c.query('COMMIT');return {alreadyImported:false,batchId:id,detailCount:v.detailCount,waybillCount:v.waybillCount,amount:v.amount,verified:true};
  }catch(e){await c.query('ROLLBACK');throw e;}
}
export async function queryCourierBills(c,args={}) {
  await c.query('BEGIN READ ONLY');try {
    await c.query(`SET LOCAL statement_timeout='60s'`);
    let result;
    if(args.trackingNo) {
      if(!/^(?:JT|SF)?\d{8,}$/i.test(args.trackingNo))throw new Error('INVALID_TRACKING_NO');
      result=await c.query(`SELECT carrier,tracking_no,count(*)::int detail_count,min(business_date)::text first_charge_date,max(business_date)::text last_charge_date,sum(charge_amount)::text charge_amount FROM raw.courier_bill_charges WHERE tracking_no=$1 GROUP BY carrier,tracking_no`,[args.trackingNo]);
    } else result=await c.query(`SELECT carrier,bill_month,count(*)::int detail_count,count(DISTINCT tracking_no)::int waybill_count,min(business_date)::text first_date,max(business_date)::text last_date,sum(charge_amount)::text charge_amount,count(*) FILTER(WHERE charge_amount<0)::int negative_count FROM raw.courier_bill_charges GROUP BY carrier,bill_month ORDER BY carrier,bill_month`);
    await c.query('COMMIT');return {rows:result.rows};
  }catch(e){await c.query('ROLLBACK');throw e;}
}
