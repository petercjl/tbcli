import assert from 'node:assert/strict';
import test from 'node:test';
import { formatProfitDate, getProfitEstimate, listProfitEstimates, normalizeProfitOwners, PROFIT_COLUMN_LABELS, PROFIT_RULE_ROWS } from '../src/tbcli/profit-estimate.mjs';

test('snapshot discovery is read only, bounded and discloses actual coverage',async()=>{
  const calls=[];
  const c={query:async(sql,params)=>{calls.push({sql,params});assert.match(sql,/^SELECT/);assert.doesNotMatch(sql,/\b(CREATE|INSERT|UPDATE|DELETE|GRANT)\b/);return {rows:[{run_id:'a',start_date:'2026-07-01',end_date:'2026-07-03',available_dates:['2026-07-01','2026-07-03']},{run_id:'b'}]};}};
  const result=await listProfitEstimates(c,{shopKey:"shop'",startDate:'2026-07-01',endDate:'2026-07-03',limit:1});
  assert.equal(result.hasMore,true);assert.equal(result.rows.length,1);
  assert.equal(result.rows[0].coverage.complete,false);
  assert.equal(result.rows[0].coverage.availableDays,2);
  assert.deepEqual(calls[0].params,["shop'",'2026-07-01','2026-07-03',2]);
  assert.match(calls[0].sql,/r.start_date <= \$2::date AND r.end_date >= \$3::date/);
});

test('empty snapshot list does not initiate computation',async()=>{
  let count=0;const result=await listProfitEstimates({query:async()=>{count++;return {rows:[]};}});
  assert.deepEqual(result.rows,[]);assert.equal(result.hasMore,false);assert.equal(count,1);
});

test('read filters reject invalid dates and limits before connecting',async()=>{
  const c={query:async()=>{assert.fail('query must not run');}};
  for(const options of [{limit:0},{limit:1001},{limit:'bad'},{startDate:'2026-07-01'},{startDate:'2026-02-30',endDate:'2026-03-01'},{startDate:'2026-08-01',endDate:'2026-07-01'}])await assert.rejects(()=>listProfitEstimates(c,options));
  await assert.rejects(()=>getProfitEstimate(c,{runId:'a',startDate:'2026-02-30',endDate:'2026-03-01'}));
});

test('owner-month groups months separately and parameterizes date and owner filters',async()=>{
  const c={query:async(sql,params)=>{
    assert.match(sql,/to_char\(stat_date,'YYYY-MM'\) AS stat_month/);
    assert.match(sql,/GROUP BY to_char\(stat_date,'YYYY-MM'\),owner_name/);
    assert.match(sql,/stat_date BETWEEN \$3::date AND \$4::date/);
    assert.match(sql,/sum\(estimated_profit\)\/sum\(net_sales\)/);
    assert.deepEqual(params,['a',['Operator'],'2026-07-01','2026-08-31']);return {rows:[]};
  }};
  const r=await getProfitEstimate(c,{runId:'a',groupBy:'owner-month',owner:'Operator',startDate:'2026-07-01',endDate:'2026-08-31'});
  assert.deepEqual(r.period,{startDate:'2026-07-01',endDate:'2026-08-31'});
});

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
