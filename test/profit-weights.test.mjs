import assert from 'node:assert/strict';
import test from 'node:test';
import {inferComponentWeights,loadWeightObservations,validateWeightRequest} from '../src/tbcli/profit-weights.mjs';

function order(id,month,carrier,weight,parts) {
  return {trackingNo:id,month,carrier,weight,components:new Map(Object.entries(parts)),invalid:false};
}

test('weight inference uses paired baskets rather than single-item billable weight as net',()=>{
  const observations=[];
  let id=0;
  for(const month of ['2026-07','2026-08']) for(const carrier of ['sto','jt']) {
    for(let k=0;k<12;k++) {
      observations.push(order(String(++id),month,carrier,0.15,{A:1}));
      observations.push(order(String(++id),month,carrier,0.25,{A:2}));
      observations.push(order(String(++id),month,carrier,0.35,{A:3}));
      observations.push(order(String(++id),month,carrier,0.35,{A:1,B:1}));
      observations.push(order(String(++id),month,carrier,0.45,{A:2,B:1}));
    }
  }
  const result=inferComponentWeights(observations,{shopKey:'test',months:['2026-07','2026-08']});
  const a=result.results.find(r=>r.erpSpecNo==='A');
  assert.equal(a.netWeightKg,0.1);
  assert.equal(a.soloPackedBillableWeightKg,0.15);
  assert.equal(a.packagingIncrementKg,0.05);
  assert.equal(a.netConfidence,'high');
  assert.equal(result.observations.used,240);
});

test('single unit alone does not identify net weight',()=>{
  const result=inferComponentWeights([order('1','2026-07','sto',0.3,{A:1})],
    {shopKey:'test',months:['2026-07']});
  assert.equal(result.results[0].netWeightKg,null);
  assert.equal(result.results[0].netConfidence,'unidentified');
  assert.equal(result.results[0].soloPackedBillableWeightKg,0.3);
});

test('single-SKU audit preserves the paired raw waybills and calculation inputs',()=>{
  const rows=[order('w1','2026-07','sto',0.15,{A:1}),
    order('w2','2026-07','sto',0.16,{A:1}),
    order('w3','2026-07','sto',0.25,{A:2}),
    order('w4','2026-07','sto',0.26,{A:2})];
  const report=inferComponentWeights(rows,{shopKey:'test',months:['2026-07'],auditSku:'A'});
  assert.equal(report.audit.erpSpecNo,'A');
  assert.equal(report.audit.comparisons.length,1);
  assert.equal(report.audit.comparisons[0].deltaKg,0.1);
  assert.equal(report.audit.comparisons[0].support,2);
  assert.equal(report.audit.rawRows.length,4);
  assert.deepEqual(report.audit.rawRows.map(r=>r.trackingNo).sort(),['w1','w2','w3','w4']);
  assert.throws(()=>inferComponentWeights(rows,{auditSku:'missing'}),/不存在/);
  const withUnpaired=inferComponentWeights([...rows,order('w5','2026-07','sto',0.4,{A:1,C:1})],
    {auditSku:'A'});
  assert.equal(withUnpaired.audit.unpairedGroups.length,1);
  assert.ok(withUnpaired.audit.rawRows.some(r=>r.trackingNo==='w5' && r.role==='no-baseline'));
});

test('invalid rows and duplicate waybills are excluded',()=>{
  const rows=[order('1','2026-07','sto',0.3,{A:1}),order('1','2026-07','sto',0.3,{A:1}),
    {...order('2','2026-07','sto',0.2,{B:1}),invalid:true}];
  const result=inferComponentWeights(rows,{shopKey:'test',months:['2026-07']});
  assert.equal(result.observations.used,1);
  assert.deepEqual(result.observations.excluded,{invalid:1,duplicate:1,weight:0});
});

test('month request requires new report target and unique valid months',()=>{
  assert.deepEqual(validateWeightRequest({shopKey:'x',months:'2026-08,2026-07',out:'new.json'}),
    ['2026-07','2026-08']);
  assert.throws(()=>validateWeightRequest({shopKey:'x',months:'2026-07,2026-07',out:'new.json'}));
});

test('warehouse loader reads courier charges by source batch, then matches one order',async()=>{
  const calls=[];
  const client={query:async(sql,params=[])=>{
    calls.push({sql,params});
    let rows=[];
    if(sql.includes('FROM meta.courier_bill_batches')) rows=[
      {batch_id:'batch-1',carrier:'sto',bill_month:'2026-07'}];
    else if(sql.includes('FROM raw.courier_bill_charges')) rows=[
      {charge_id:'charge-1',tracking_no:'waybill-1',carrier:'sto',bill_month:'2026-07',
        billable_weight_kg:'0.3',source_sheet:'sheet-1',source_row:2}];
    else if(sql.includes('FROM raw.shipments')) rows=[
      {shipment_key:'shipment-1',tracking_no:'waybill-1',wdt_trade_no:'order-1'}];
    else if(sql.includes('FROM raw.wdt_order_headers')) rows=[
      {wdt_trade_no:'order-1',order_status_code:95}];
    else if(sql.includes('FROM raw.wdt_order_lines')) rows=[
      {order_line_key:'line-1',wdt_trade_no:'order-1',erp_spec_no:'sku-1',quantity:1}];
    return {rows,rowCount:rows.length};
  }};
  const result=await loadWeightObservations(client,'test',['2026-07']);
  assert.equal(result.observations.length,1);
  assert.equal(result.observations[0].components.get('sku-1'),1);
  const billCall=calls.find(call=>call.sql.includes('FROM raw.courier_bill_charges'));
  assert.deepEqual(billCall.params,['batch-1',null,null]);
  assert.match(billCall.sql,/source_batch_id=\$1/);
  assert.equal(calls.at(-1).sql,'COMMIT');
});
