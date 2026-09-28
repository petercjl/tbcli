import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertSkuGrossModeReady, classifySkuGrossCandidate, discoverSkuGrossBillInputs } from '../src/tbcli/platform-sku-gross-weights.mjs';
import { estimatePlatformSkuGrossWeight, SKU_GROSS_METHOD } from '../src/tbcli/platform-sku-gross-stat.mjs';
import { deriveResidualSample, deriveResidualSamples, restorePurchasedUnits, summarizeResidualSamples } from '../src/tbcli/platform-sku-gross-residual.mjs';
import { validateManualGrossInput, MANUAL_GROSS_METHOD, MANUAL_GROSS_STATUS } from '../src/tbcli/platform-sku-gross-manual.mjs';

test('manual gross input preserves long SKU IDs and rejects zero or duplicate weights', () => {
  const source={name:'Reviewed sheet',uri:'https://example.test/sheets/id',revision:'7'};
  const weight={platformSkuId:'2822117198074478897',platformProductId:'1070168442808',estimateKg:'0.300',sourceRow:36};
  const parsed=validateManualGrossInput({source,weights:[weight]});
  assert.equal(parsed.weights[0].platformSkuId,weight.platformSkuId);
  assert.equal(parsed.weights[0].estimateKg,0.3);
  assert.equal(MANUAL_GROSS_STATUS,'manual-estimate');
  assert.match(MANUAL_GROSS_METHOD,/manual/);
  assert.throws(()=>validateManualGrossInput({source,weights:[weight,{...weight,sourceRow:37}]}),/重复/);
  assert.throws(()=>validateManualGrossInput({source,weights:[{...weight,estimateKg:0}]}),/正数/);
});

test('one sample yields a weight with explicitly low confidence', () => {
  const result = estimatePlatformSkuGrossWeight([0.2], { skuKey:'shop:sku' });
  assert.equal(result.estimateKg, 0.2);
  assert.equal(result.sampleCount, 1);
  assert.equal(result.confidenceScore, 0.1);
  assert.equal(result.confidenceLevel, 'low');
  assert.equal(result.ci95LowKg, null);
  assert.match(SKU_GROSS_METHOD, /platform-sku-gross/);
});

test('sample size caps confidence and stable input produces stable result', () => {
  const sample = [0.2,0.2,0.21,0.22,0.24,0.25];
  const left = estimatePlatformSkuGrossWeight(sample,{skuKey:'shop:sku'});
  const right = estimatePlatformSkuGrossWeight(sample,{skuKey:'shop:sku'});
  assert.deepEqual(left,right);
  assert.ok(left.estimateKg > 0);
  assert.ok(left.confidenceScore <= Math.sqrt(sample.length / 100) + 0.001);
  assert.equal(left.confidenceLevel,'low');
});

test('candidate requires exact one-unit ERP component composition', () => {
  const base = { expected_components:[['A',2],['B',1]],actual_components:[['B',1],['A',2]] };
  assert.equal(classifySkuGrossCandidate(base),'valid');
  assert.equal(classifySkuGrossCandidate({ ...base,actual_components:[['A',4],['B',2]] }),'not-one-unit');
  assert.equal(classifySkuGrossCandidate({ ...base,actual_components:[['A',2]] }),'component-mismatch');
  assert.equal(classifySkuGrossCandidate({ ...base,expected_components:null }),'missing-mapping');
});

test('discovers courier bill files and infers a shared year without guessing', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'tbcli-sku-gross-test-'));
  try {
    await fs.mkdir(path.join(dir,'7月份'));
    await fs.writeFile(path.join(dir,'7月份','顺丰2026.7.xlsx'),'test');
    await fs.writeFile(path.join(dir,'7月份','岳王7月韵达对账单.xlsx'),'test');
    const found = await discoverSkuGrossBillInputs(dir);
    assert.equal(found.length,2);
    assert.deepEqual(new Set(found.map(x => x.billMonth)),new Set(['2026-07']));
    assert.deepEqual(new Set(found.map(x => x.carrier)),new Set(['sf','yunda']));
  } finally { await fs.rm(dir,{recursive:true,force:true}); }
});

test('rejects an incorrect mode before bill import', async () => {
  const client = { query: async sql => sql.includes('to_regclass')
    ? { rows:[{ name:'mart.platform_sku_gross_weight_samples' }] }
    : { rows:[{ n:3 }] } };
  await assert.rejects(assertSkuGrossModeReady(client,'shop','init'), /请使用 update/);
  await assert.doesNotReject(assertSkuGrossModeReady(client,'shop','update'));
});

test('restores a combo SKU purchase count before using package weight', () => {
  assert.equal(restorePurchasedUnits({productCount:1,
    actualComponents:[['pan',2],['handle',4]],expectedComponents:[['pan',1],['handle',2]]}),2);
  assert.equal(restorePurchasedUnits({productCount:1,
    actualComponents:[['pan',2],['handle',3]],expectedComponents:[['pan',1],['handle',2]]}),null);
});

test('multi-SKU residual uses one shared 0.2 kg package and a direct anchor', () => {
  const pkg={shop_key:'shop',wdt_trade_no:'T1',tracking_no:'W1',billable_weight_kg:1.3,
    source_batch_ids:['batch'],items:[
      {platformSkuId:'A',productCount:1,actualComponents:[['a',1]],expectedComponents:[['a',1]]},
      {platformSkuId:'B',productCount:1,actualComponents:[['b',1]],expectedComponents:[['b',1]]},
    ]};
  const anchors=new Map([['A',{estimateKg:0.7,confidenceScore:0.8,sampleCount:100,runId:'direct'}]]);
  const sample=deriveResidualSample(pkg,anchors);
  assert.equal(sample.platform_sku_id,'B');
  assert.equal(sample.estimated_unit_gross_kg,0.8);
  assert.equal(sample.packaging_assumption_kg,0.2);
  assert.equal(sample.known_anchors[0].runId,'direct');
  assert.equal(deriveResidualSample(pkg,new Map([...anchors,['B',{estimateKg:0.8,confidenceScore:0.5,sampleCount:5}]])),null);
  assert.equal(deriveResidualSample({...pkg,billable_weight_kg:0.1},anchors),null);
});

test('multi-unit residual and coarse bill keep conservative confidence', () => {
  const pkg={shop_key:'shop',wdt_trade_no:'T2',tracking_no:'W2',billable_weight_kg:1.9,
    source_batch_ids:['batch'],items:[
      {platformSkuId:'A',productCount:1,actualComponents:[['a',2]],expectedComponents:[['a',1]]},
      {platformSkuId:'B',productCount:1,actualComponents:[['b',1]],expectedComponents:[['b',1]]},
    ]};
  const sample=deriveResidualSample(pkg,new Map([['A',{estimateKg:0.7,confidenceScore:0.8,sampleCount:100}]]));
  assert.equal(sample.estimated_unit_gross_kg,0.9);
  const coarse={...sample,coarse_one_kg_bill:true};
  const summary=summarizeResidualSamples([coarse],'shop:B');
  assert.equal(summary.status,'inferred');
  assert.equal(summary.confidenceLevel,'low');
  assert.ok(summary.confidenceScore<=0.2);
});

test('three- and four-SKU parcels share unknown net weight by purchased units', () => {
  const item=(sku,quantity=1)=>({platformSkuId:sku,productCount:1,
    actualComponents:[[sku,quantity]],expectedComponents:[[sku,1]]});
  const pkg={shop_key:'shop',wdt_trade_no:'T3',tracking_no:'W3',billable_weight_kg:1.9,
    source_batch_ids:['batch'],items:[item('A'),item('B'),item('C',2)]};
  const anchors=new Map([['A',{estimateKg:0.7,confidenceScore:0.8,sampleCount:100}]]);
  const samples=deriveResidualSamples(pkg,anchors);
  assert.equal(samples.length,2);
  assert.deepEqual(samples.map(row=>row.platform_sku_id),['B','C']);
  assert.deepEqual(samples.map(row=>row.estimated_unit_gross_kg),[0.6,0.6]);
  assert.deepEqual(samples.map(row=>row.purchased_units),[1,2]);
  assert.ok(samples.every(row=>row.inference_method==='shared_unknown_residual' && row.unknown_sku_count===2));
  assert.equal(deriveResidualSample(pkg,anchors),null);
  const four={...pkg,items:[...pkg.items,item('D')]};
  assert.equal(deriveResidualSamples(four,anchors).length,3);
  assert.equal(deriveResidualSamples({...pkg,billable_weight_kg:0.1},anchors).length,0);
});

test('multiple unknowns with no direct anchor remain explicitly low confidence', () => {
  const item=sku=>({platformSkuId:sku,productCount:1,
    actualComponents:[[sku,1]],expectedComponents:[[sku,1]]});
  const pkg={shop_key:'shop',wdt_trade_no:'T4',tracking_no:'W4',billable_weight_kg:1.4,
    source_batch_ids:['batch'],items:['A','B','C','D'].map(item)};
  const shared=deriveResidualSamples(pkg,new Map());
  assert.equal(shared.length,4);
  assert.ok(shared.every(row=>row.estimated_unit_gross_kg===0.5));
  const estimate=summarizeResidualSamples([shared[0]],'shop:A');
  assert.equal(estimate.sourceType,'multi_sku_shared_residual');
  assert.equal(estimate.confidenceLevel,'low');
  assert.ok(estimate.confidenceScore<=0.1);
  const single={...shared[0],inference_method:'single_unknown_residual',known_anchors:[
    {platformSkuId:'X',confidenceScore:0.8}]};
  assert.equal(summarizeResidualSamples([shared[0],single],'shop:A').sourceType,'multi_sku_residual');
});
