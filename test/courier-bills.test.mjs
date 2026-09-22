import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from '@excel.js/exceljs';
import {normalizeCharge,decimal,sumAmounts,billDate,validateCourierBill,importCourierBill,queryCourierBills} from '../src/tbcli/courier-bills.mjs';
import {assertMaintainerAccess} from '../src/tbcli/database.mjs';
const opts={carrier:'sf',billMonth:'2026-07'};
const sf={'运单号码':'SF0000000001','日期':'07-01','应付金额':'10.3','费用(元)':'12','折扣/促销':'1.7','服务':'运费'};
test('exact signed decimal sum and source dates',()=>{
 assert.equal(sumAmounts(['0.1','0.2','-0.03','1.2345']),'1.5045');
 assert.equal(decimal(1.2345000000000002),'1.2345');
 assert.throws(()=>decimal('0.123456789'));
 assert.throws(()=>decimal(0.123456789));
 assert.equal(billDate('07-01','2026-07'),'2026-07-01');
 assert.equal(billDate(46204,'2026-07'),'2026-07-01');
 assert.throws(()=>billDate('2026-02-30','2026-02'));
 assert.throws(()=>billDate(null,'2026-02'));
});
test('SF keeps negative adjustments and nullable auxiliary fields',()=>{
 const r=normalizeCharge({...sf,'应付金额':'-101.1'},opts);
 assert.equal(r.charge_amount,'-101.1');assert.equal(r.tax_amount,null);assert.equal(r.customer_name,null);
});
test('carrier-specific full amounts, prepaid offsets and supplements',()=>{
 const s=normalizeCharge({'运单号':'00012345678','业务时间':'2026-07-01','应收金额':5,'中转费/运费':2,'异形件':3},{carrier:'sto',billMonth:'2026-07'});
 assert.equal(s.tracking_no,'00012345678');assert.equal(s.charge_amount,'5');assert.equal(s.extra_charges['异形件'],'3');
 const y=normalizeCharge({'单号':'1234567890','账单日期':'2026-07-01','快递运费':1.8,'应收金额':-0.1},{carrier:'yunda',billMonth:'2026-07'});
 assert.equal(y.charge_amount,'1.8');assert.equal(y.prepaid_offset,'1.9');
 const j=normalizeCharge({'运单编号':'JT00012345678','寄件时间':'2026-07-01','合计金额':2.575,'收入':2.5,'税费':0.075,'客户名称':'示例退转件'},{carrier:'jt',billMonth:'2026-07'});
 assert.equal(j.charge_amount,'2.575');assert.equal(j.tax_amount,'0.075');assert.equal(j.charge_type,'退转件');
 assert.throws(()=>normalizeCharge({...sf,'应付金额':null},opts),/MISSING_CHARGE/);
});
async function fixture(t, rows, footer=false) {
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'tbcli-courier-test-'));
 t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,'fixture.xlsx'),wb=new ExcelJS.Workbook(),s=wb.addWorksheet('账单明细');
 const headers=Object.keys(sf);s.addRow(headers);
 for(const row of rows)s.addRow(headers.map(k=>row[k]??null));
 if(footer){s.addRow(['月结权益优惠']);s.addRow(['仅供参考','其他信息','文字']);}
 const ref=wb.addWorksheet('淘天运单');ref.addRow(headers);ref.addRow(Object.values(sf));
 await wb.xlsx.writeFile(file);return file;
}
test('actual XLSX reader keeps multiple fees and excludes reference sections',async t=>{
 const file=await fixture(t,[sf,{...sf,'服务':'保价','应付金额':'1','费用(元)':'1','折扣/促销':'0'}],true);
 const v=await validateCourierBill(file,opts);assert.equal(v.ok,true);assert.equal(v.detailCount,2);assert.equal(v.waybillCount,1);assert.equal(v.amount,'11.3');
});
test('missing tracking, uncached amount and identical duplicates block import',async t=>{
 for(const bad of [{...sf,'运单号码':null},{...sf,'应付金额':{formula:'1+2'}},sf]){
  const file=await fixture(t,[sf,bad]);const v=await validateCourierBill(file,opts);assert.equal(v.ok,false);
 }
});
function mock({old=false,overlap=false,fail=false}={}) {
 const calls=[];return {calls,async query(sql,params){calls.push(sql);
  if(sql.startsWith('SELECT * FROM meta.'))return {rowCount:old?1:0,rows:old?[{carrier:'sf',bill_month:'2026-07',source_sha256:'a',content_sha256:'b'}]:[]};
  if(sql.startsWith('SELECT count(*)::int n FROM raw.'))return {rows:[{n:overlap?1:0}]};
  if(sql.startsWith('INSERT INTO raw.')&&fail)throw new Error('injected failure');
  if(sql.startsWith('SELECT count(*)::int n,sum'))return {rows:[{n:1,amount:'10.3'}]};
  return {rows:[],rowCount:0};
 }};
}
const valid={ok:true,file:'example.xlsx',fileSha256:'a',contentSha256:'b',carrier:'sf',billMonth:'2026-07',parserVersion:'test',detailCount:1,waybillCount:1,amount:'10.3',rows:[{...normalizeCharge(sf,opts),charge_fingerprint:'c'}]};
test('import transaction commits only verified complete batch',async()=>{
 const c=mock();assert.equal((await importCourierBill(c,valid)).verified,true);assert.equal(c.calls.at(-1),'COMMIT');
 const f=mock({fail:true});await assert.rejects(importCourierBill(f,valid),/injected/);assert.equal(f.calls.at(-1),'ROLLBACK');
});
test('reimport is a no-op and partial overlap rolls back',async()=>{
 const c=mock({old:true});assert.equal((await importCourierBill(c,valid)).alreadyImported,true);assert.ok(!c.calls.some(x=>x.startsWith('INSERT')));
 const o=mock({overlap:true});await assert.rejects(importCourierBill(o,valid),/OVERLAPPING/);assert.equal(o.calls.at(-1),'ROLLBACK');
});
test('reader denied import; query uses read-only transaction',async()=>{
 assert.throws(()=>assertMaintainerAccess({accessMode:'read-only'}),/只读/);
 const c=mock();await queryCourierBills(c,{trackingNo:'SF0000000001'});assert.equal(c.calls[0],'BEGIN READ ONLY');assert.ok(c.calls.some(s=>s.includes('GROUP BY carrier,tracking_no')));
});
