import assert from 'node:assert/strict';
import test from 'node:test';
import { formatProfitDate, getProfitEstimate, normalizeProfitOwners, PROFIT_COLUMN_LABELS, PROFIT_RULE_ROWS } from '../src/tbcli/profit-estimate.mjs';

test('profit Excel exposes Chinese business headers and rule labels',()=>{
  assert.ok(Object.values(PROFIT_COLUMN_LABELS).every((label)=>!/^[a-z_]+$/i.test(label)));
  assert.deepEqual(PROFIT_RULE_ROWS[0],['口径','内容']);
  assert.ok(PROFIT_RULE_ROWS.every((row)=>row.length===2 && row.every((cell)=>typeof cell==='string' && cell.length>0)));
});

test('profit owner selection accepts one or several exact Chinese names',()=>{
  assert.deepEqual(normalizeProfitOwners({owner:'许能文'}),['许能文']);
  assert.deepEqual(normalizeProfitOwners({owners:'吴晓燕，杨中鑫, 许能文,吴晓燕'}),['吴晓燕','杨中鑫','许能文']);
  assert.throws(()=>normalizeProfitOwners({owner:'许能文',owners:'吴晓燕'}),/不能同时使用/);
});

test('profit command receipts always expose ISO calendar dates',()=>{
  assert.equal(formatProfitDate('2026-08-27'),'2026-08-27');
  assert.equal(formatProfitDate(new Date('2026-09-02T00:00:00.000Z')),'2026-09-02');
  assert.equal(formatProfitDate(new Date('2026-08-26T16:00:00.000Z')),'2026-08-27');
});

test('profit query sends multiple owners as one parameterized database filter',async()=>{
  const calls=[];
  const client={query:async(sql,params)=>{calls.push({sql,params});return{rows:[]};}};
  const result=await getProfitEstimate(client,{runId:'run-1',groupBy:'owner',owners:'吴晓燕,杨中鑫,许能文'});
  assert.deepEqual(result.owners,['吴晓燕','杨中鑫','许能文']);
  assert.match(calls[0].sql,/owner_name=ANY\(\$2::text\[\]\)/);
  assert.deepEqual(calls[0].params,['run-1',['吴晓燕','杨中鑫','许能文']]);
  assert.match(calls[0].sql,/profit_margin/);
});
