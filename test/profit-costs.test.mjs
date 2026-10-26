import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { reconcileExplicitZeroCosts, reconcileWdtCosts, validateExplicitZeroInput, validateWdtCostExport } from '../src/tbcli/profit-costs.mjs';
import { COMMAND_DEFINITIONS } from '../src/tbcli/command-registry.mjs';
import { ROUTED_COMMAND_KEYS } from '../src/tbcli/cli.mjs';

test('WDT cost export validates complete source and current cost reconciliation preserves zeros',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'tbcli-cost-test-'));
  try {
    const file=path.join(dir,'costs.json');
    const rows=[
      {goodsNo:'G1',specNo:'S1',refCostPrice:3.5,goodsDeleted:0,goodsStatus:0,specDeleted:0,specStatus:0},
      {goodsNo:'G0',specNo:'S1',refCostPrice:9,goodsDeleted:1,goodsStatus:0,specDeleted:1,specStatus:2},
      {goodsNo:'G2',specNo:'S2',refCostPrice:0,goodsDeleted:0,goodsStatus:0,specDeleted:0,specStatus:0},
    ];
    await fs.writeFile(file,JSON.stringify({source:'wdt-openapi:goods_query.php',fetchedAt:'2026-09-25T00:00:00Z',goodsCount:3,specCount:3,rows}),'utf8');
    const validation=await validateWdtCostExport(file,{shopKey:'demo',effectiveFrom:'2026-09-25'});
    assert.equal(validation.specCount,3);
    const client={query:async(sql)=>{
      if(sql.includes('raw.wdt_order_lines')) return {rows:[{erp_spec_no:'S1',erp_goods_no:'G1'},{erp_spec_no:'S2',erp_goods_no:'G2'}]};
      if(sql.includes('master.current_skus')) return {rows:[]};
      if(sql.includes('master.current_sku_costs')) return {rows:[{version_id:'1',erp_spec_no:'S1',unit_cost:'3.000000',cost_status:'available',effective_from:'2026-07-01'}]};
      throw new Error('unexpected query');
    }};
    const result=await reconcileWdtCosts(client,validation);
    assert.equal(result.targetSpecCount,2);
    assert.equal(result.changedCount,1);
    assert.equal(result.changes[0].erpSpecNo,'S1');
    assert.equal(result.changes[0].unitCost,3.5);
    assert.equal(result.issueSummary.source_cost_zero,1);
  } finally { await fs.rm(dir,{recursive:true,force:true}); }
});

test('cost acquisition, reconciliation and sync are registered as stable business commands',()=>{
  for(const key of ['profit costs fetch','profit costs reconcile','profit costs sync','profit costs approve-zero']) {
    assert.ok(ROUTED_COMMAND_KEYS.includes(key));
    const item=COMMAND_DEFINITIONS.find((entry)=>entry.key===key);
    assert.equal(item.maturity,'stable');
    assert.equal(item.audience,'business');
    assert.ok(item.capability?.examplePrompt);
  }
});

test('explicit zero confirmation requires unique observed SKU identity and rejects positive costs',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'tbcli-zero-test-'));
  try {
    const file=path.join(dir,'confirmed.json');
    await fs.writeFile(file,JSON.stringify({rows:[{erpSpecNo:'S0',platformSkuId:'P0',
      platformProductId:'G0',reason:'人工确认成本为零'}]}));
    const validation=await validateExplicitZeroInput(file,{shopKey:'demo',effectiveFrom:'2026-09-28'});
    const client={query:async(sql)=>{
      if(sql.includes('raw.wdt_order_lines')) return {rows:[{erp_spec_no:'S0',platform_sku_id:'P0',
        platform_product_id:'G0',line_count:'2'}]};
      if(sql.includes('master.current_sku_costs')) return {rows:[]};
      throw new Error('unexpected query');
    }};
    const preview=await reconcileExplicitZeroCosts(client,validation);
    assert.equal(preview.changedCount,1);
    assert.equal(preview.changes[0].lineCount,2);
    const mismatch={query:async(sql)=>sql.includes('raw.wdt_order_lines')
      ?{rows:[{erp_spec_no:'S0',platform_sku_id:'WRONG',platform_product_id:'G0',line_count:'2'}]}
      :{rows:[]}};
    await assert.rejects(reconcileExplicitZeroCosts(mismatch,validation),/不唯一|不符/);
    const positive={query:async(sql)=>sql.includes('raw.wdt_order_lines')
      ?{rows:[{erp_spec_no:'S0',platform_sku_id:'P0',platform_product_id:'G0',line_count:'2'}]}
      :{rows:[{erp_spec_no:'S0',unit_cost:'1.2',cost_status:'available'}]}};
    await assert.rejects(reconcileExplicitZeroCosts(positive,validation),/正成本/);
  } finally { await fs.rm(dir,{recursive:true,force:true}); }
});
