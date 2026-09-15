import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,readFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import ExcelJS from '@excel.js/exceljs';
import {buildProfitQuery,getProfitEstimate,exportProfitEstimate,validateProfitRequest,normalizeProfitOwners,formatProfitDate,PROFIT_COLUMN_LABELS} from '../src/tbcli/profit-estimate.mjs';
import {withProfitReadTransaction} from '../src/tbcli/commands/profit-estimate.mjs';
import {ROUTED_COMMAND_KEYS} from '../src/tbcli/cli.mjs';
const args={shopKey:'demo',startDate:'2026-07-01',endDate:'2026-07-02',groupBy:'owner-month'};
function reader({noAd=false}={}) {
  const calls=[];
  return {calls,query:async(sql,params)=>{
    calls.push({sql,params});
    assert.match(sql.trim(),/^(SELECT|WITH)\b/);
    assert.doesNotMatch(sql,/\b(CREATE|INSERT|UPDATE|DELETE|GRANT|mart\.)\b/i);
    if(sql.startsWith('SELECT shop_name'))return {rows:[{shop_name:'天猫 Demo'}]};
    if(sql.startsWith('SELECT DISTINCT stat_date'))return {rows:noAd?[]:[{stat_date:'2026-07-01'}]};
    if(sql.includes('FROM meta.profit_source_batches'))return {rows:[{coverage_start:'2026-07-01',coverage_end:'2026-07-02'}]};
    if(sql.startsWith('WITH'))return {rows:[{stat_month:'2026-07',owner_name:'A',estimated_profit:'10.00',net_sales:'20.00',profit_margin:'0.5'}]};
    return {rows:[{}]};
  }};
}
test('live profit parameters, month grouping and skipped dates',async()=>{
  const c=reader();const r=await getProfitEstimate(c,{...args,owners:'A,B'});
  assert.equal(r.mode,'live-read-only');assert.equal(r.complete,false);
  assert.deepEqual(r.skippedDates,['2026-07-02']);
  assert.equal('runId' in r,false);
  const last=c.calls.at(-1);
  assert.deepEqual(last.params,['demo','Demo','2026-07-01','2026-07-02',0.06,0.02,0.5,2,['A','B']]);
  assert.match(last.sql,/GROUP BY to_char\(stat_date,'YYYY-MM'\),owner_name/);
  assert.match(last.sql,/sum\(estimated_profit\)\/sum\(net_sales\)/);
});
test('missing ad data is explicit and never substitutes zero ad spend',async()=>{
 const c=reader({noAd:true});const r=await getProfitEstimate(c,args);
 assert.equal(r.reason,'AD_DATA_NOT_AVAILABLE');assert.deepEqual(r.rows,[]);
 assert.equal(c.calls.some(x=>x.sql.startsWith('WITH')),false);
});
test('invalid dates, retired identifier, owners, group and policy stop before queries',async()=>{
 const c={query:()=>assert.fail('unexpected query')};
 for(const patch of [{shopKey:''},{startDate:'2026-02-30'},{endDate:undefined},{taxRate:Infinity},{missingCostRate:-1},{platformFeeRate:2},{runId:'old'},{owner:'A',owners:'B'},{groupBy:'unsafe'}])await assert.rejects(()=>getProfitEstimate(c,{...args,...patch}));
 assert.throws(()=>buildProfitQuery('bad'));
});
test('live calculation contains no persisted result references or writes',()=>{
 for(const group of ['shop','owner','product','day','month','owner-month']){
  const sql=buildProfitQuery(group);
  assert.doesNotMatch(sql,/\b(CREATE|INSERT|UPDATE|DELETE|DROP)\b|mart\.|run_id/i);
  assert.match(sql,/master\.product_owner_versions/);
  assert.match(sql,/owner_name=ANY\(\$9::text\[\]\)/);
 }
 for(const key of ['profit estimate init','profit estimate run','profit estimate list'])assert.equal(ROUTED_COMMAND_KEYS.includes(key),false);
});
test('command transaction enforces read-only and rolls back failures',async()=>{
 const calls=[];const c={query:async sql=>{calls.push(sql);return {rows:[]};}};
 await withProfitReadTransaction(c,async()=>42);
 assert.equal(calls[0],'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 assert.equal(calls.at(-1),'COMMIT');
 await assert.rejects(()=>withProfitReadTransaction(c,async()=>{throw Error('denied');}));
 assert.equal(calls.at(-1),'ROLLBACK');
});
test('Excel includes monthly comparisons and preserves existing files',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'tbcli-live-profit-'));
 const out=path.join(dir,'profit.xlsx');
 const result=await exportProfitEstimate(reader(),{...args,out});
 assert.equal(result.sheets.length,6);
 assert.ok(result.sheets.includes('负责人月度对比'));
 const before=await readFile(out);
 const wb=new ExcelJS.Workbook();await wb.xlsx.readFile(out);
 assert.equal(wb.getWorksheet('负责人月度对比').getRow(1).getCell(1).value,'统计月份');
 assert.ok(wb.getWorksheet('计算规则').getSheetValues().flat().some(x=>x==='0.06'));
 await assert.rejects(()=>exportProfitEstimate(reader(),{...args,out}),/拒绝覆盖/);
 assert.deepEqual(await readFile(out),before);
});
test('labels, dates and owners remain stable',()=>{
 assert.equal(formatProfitDate('2026-07-01'),'2026-07-01');
 assert.deepEqual(normalizeProfitOwners({owners:'A,B,A'}),['A','B']);
 assert.ok(Object.values(PROFIT_COLUMN_LABELS).every(x=>!/^[a-z_]+$/i.test(x)));
 validateProfitRequest(args);
});
