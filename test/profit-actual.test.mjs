import assert from 'node:assert/strict';
import test from 'node:test';
import {ACTUAL_PROFIT_POLICY,actualProfitPeriod,buildActualProfitQuery,getActualComboCostAudit,getActualCostAudit,getActualOrderCostAudit,getActualProfitCoverage,getActualProfitQuery,getActualReferenceCostAudit,validateActualComboCostAuditRequest,validateActualCostAuditRequest,validateActualOrderCostAuditRequest,validateActualCoverageRequest,validateActualProfitQueryRequest,validateActualReferenceCostAuditRequest} from '../src/tbcli/profit-actual.mjs';
import {COMMAND_DEFINITIONS} from '../src/tbcli/command-registry.mjs';
import {candidateWeightComparison,getActualFreightFallbackAudit,jointPurchaseCandidates} from '../src/tbcli/freight-fallback-audit.mjs';
import {ROUTED_COMMAND_KEYS} from '../src/tbcli/cli.mjs';

function reader({allocatedLineRevenue='101.00',missingCostLines='1',missingWeightOrders=0}={}) {
  const calls=[];
  return {calls,query:async(sql,params=[])=>{
    calls.push({sql,params});
    assert.match(sql.trim(),/^(SELECT|WITH)\b/);
    assert.doesNotMatch(sql,/\b(CREATE|INSERT|UPDATE|DELETE|DROP|GRANT|REVOKE)\b/i);
    if(sql.startsWith('SELECT shop_name')) return {rows:[{shop_name:'天猫 Demo'}]};
    if(sql.includes("source_type='wdt-orders'")) return {rows:[{coverage_start:'2026-07-01',coverage_end:'2026-07-31'}]};
    if(sql.includes("source_type='wdt-refunds'")) return {rows:[{coverage_start:'2026-07-01',coverage_end:'2026-08-15'}]};
    if(sql.includes('AS eligible_orders')) return {rows:[{eligible_orders:'2',order_lines:'3',shipments:'2',paid_amount:'100.00',allocated_line_revenue:allocatedLineRevenue}]};
    if(sql.includes('AS settled_refunds')) return {rows:[{settled_refunds:'1',header_refund_amount:'10.00',refund_lines:'1',line_refund_amount:'10.00',unmatched_refund_headers:'0',unmapped_refund_lines:'1',unmapped_refund_amount:'2.00',unmapped_refund_details:[{wdtTradeNo:'T1',platformTradeId:'P1'}]}]};
    if(sql.includes('AS shipment_waybills')) return {rows:[{shipment_waybills:'2',matched_waybills:'1',unmatched_waybills:'1',shared_tracking_waybills:'0',multi_charge_waybills:'0',multi_carrier_waybills:'0',matched_charge_amount:'3.00',matched_bill_months:'2026-07',by_source_carrier:[]}]};
    if(sql.includes("value_state='actual'")) return {rows:[{lines:'3',actual_lines:missingCostLines==='0'?'3':'2',standard_reference_lines:'0',missing_lines:missingCostLines,missing_revenue:missingCostLines==='0'?'0.00':'5.00',covered_cost:'20.00',missing_items:missingCostLines==='0'?[]:[{erpSpecNo:'S1'}]}]};
    if(sql.includes("data_type='sku-cost-sync'")) return {rows:[{batch_id:'batch-1',source_metadata:{source:'wdt-openapi:goods_query.php'},effective_from:'2026-09-25'}]};
    if(sql.includes('FROM meta.platform_sku_gross_weight_runs')) return {rows:[{run_id:'weight-run-1',method:'platform-sku-gross-kde-v2'}]};
    if(sql.includes('AS sku_groups') && sql.includes('FROM order_sku_weights')) return {rows:[{
      sku_groups:3,weighted_sku_groups:missingWeightOrders?2:3,
      missing_sku_groups:missingWeightOrders?1:0,inferred_sku_groups:1,shared_inferred_sku_groups:1,
      low_confidence_sku_groups:1,fallback_freight_amount:missingWeightOrders?'1.20':'0.00',
      orders:2,missing_weight_orders:missingWeightOrders,missing_platform_skus:missingWeightOrders?1:0,
      missing_examples:missingWeightOrders?[{wdt_trade_no:'T1',platform_sku_id:'S1',reason:'sku_weight_missing'}]:[],
    }]};
    if(sql.includes('AS assigned_product_days')) return {rows:[{product_days:'2',assigned_product_days:'1',unassigned_product_days:'1',unassigned_products:'1',review_unassigned_products:'1',intentional_unassigned_products:'0',unassigned_product_ids:['p2'],unassigned_product_details:[{platformProductId:'p2'}]}]};
    if(sql.includes('freight_targets AS MATERIALIZED')) return {rows:[
      {level:'shop',gross_revenue:'10.00',refund_amount:'0.00',net_sales:'10.00',goods_cost:'0.00',freight_cost:'0.00',ad_spend:'0.00',platform_fee:'0.00',tax_cost:'0.00',actual_profit:'10.00'},
      {level:'owner',owner_name:'甲',gross_revenue:'10.00',refund_amount:'0.00',net_sales:'10.00',goods_cost:'0.00',freight_cost:'0.00',ad_spend:'0.00',platform_fee:'0.00',tax_cost:'0.00',actual_profit:'10.00'},
      {level:'product',owner_name:'甲',platform_product_id:'p1',product_image_url:'https://img.example.com/p1.jpg',gross_revenue:'10.00',refund_amount:'0.00',net_sales:'10.00',goods_cost:'0.00',freight_cost:'0.00',ad_spend:'0.00',platform_fee:'0.00',tax_cost:'0.00',actual_profit:'10.00'},
    ]};
    if(sql.includes("dataset_key='wujie-subject'")) return {rows:[{covered_days:31,first_date:'2026-07-01',last_date:'2026-07-31',rows:'10',ad_spend:'8.00'}]};
    if(sql.includes('AS orders')) return {rows:[{orders:'2',lines:'3',shipments:'2'}]};
    if(sql.includes('count(*)::bigint refunds')) return {rows:[{refunds:'1',lines:'1'}]};
    throw new Error(`unexpected SQL: ${sql.slice(0,80)}`);
  }};
}

test('actual profit month produces Shanghai cutoff on next month day 15',()=>{
  assert.deepEqual(actualProfitPeriod('2026-07'),{
    month:'2026-07',startDate:'2026-07-01',endDate:'2026-07-31',
    refundCutoffDate:'2026-08-15',refundCutoff:'2026-08-15T23:59:59+08:00',
  });
  assert.equal(actualProfitPeriod('2026-12').refundCutoffDate,'2027-01-15');
  assert.throws(()=>actualProfitPeriod('2026-13'),/YYYY-MM/);
  assert.throws(()=>validateActualCoverageRequest({month:'2026-07'}),/shop-key/);
  assert.equal(validateActualCoverageRequest({shopKey:'demo',month:'2026-07'}).policyVersion,'operating-profit-v5');
  assert.equal(validateActualCoverageRequest({shopKey:'demo',month:'2026-07',policyVersion:'operating-profit-v4'}).policyVersion,'operating-profit-v4');
  assert.equal(validateActualCoverageRequest({shopKey:'demo',month:'2026-07',returnResaleRate:'0.75'}).returnResaleRate,0.75);
  assert.throws(()=>validateActualCoverageRequest({shopKey:'demo',month:'2026-07',returnResaleRate:'1.1'}),/0 到 1/);
  assert.equal(validateActualCoverageRequest({shopKey:'demo',month:'2026-07',policyVersion:'operating-profit-v3'}).policyVersion,'operating-profit-v3');
  assert.equal(validateActualCoverageRequest({shopKey:'demo',month:'2026-07',policyVersion:'operating-profit-v2'}).policyVersion,'operating-profit-v2');
  assert.equal(validateActualCoverageRequest({shopKey:'demo',month:'2026-07',policyVersion:'operating-profit-v1'}).policyVersion,'operating-profit-v1');
  assert.throws(()=>validateActualCoverageRequest({shopKey:'demo',month:'2026-07',policyVersion:'other'}),/仅支持/);
  assert.throws(()=>validateActualCostAuditRequest({shopKey:'demo',month:'2026-07'}),/product-id/);
  assert.equal(validateActualOrderCostAuditRequest({shopKey:'demo',month:'2026-07'}).sampleSize,30);
  assert.deepEqual(validateActualOrderCostAuditRequest({shopKey:'demo',month:'2026-07',orderNos:'T1，T2 T1'}).orderNos,['T1','T2']);
  assert.throws(()=>validateActualOrderCostAuditRequest({shopKey:'demo',month:'2026-07',orderNos:'T1',sampleSize:'2'}),/不能同时使用/);
  assert.equal(validateActualComboCostAuditRequest({shopKey:'demo',month:'2026-07',productId:'P1'}).productId,'P1');
  assert.equal(validateActualReferenceCostAuditRequest({shopKey:'demo',month:'2026-07'}).month,'2026-07');
});

test('actual coverage is read-only and separates blocking from advisory gaps',async()=>{
  const client=reader();
  const result=await getActualProfitCoverage(client,{shopKey:'demo',month:'2026-07'});
  assert.equal(result.calculationPerformed,false);
  assert.equal(result.status,'incomplete');
  assert.equal(result.period.refundCutoffDate,'2026-08-15');
  assert.equal(result.coverage.orderScope.line_revenue_difference,'1.00');
  assert.equal(result.coverage.orderScope.selected_revenue_amount,'100.00');
  assert.ok(result.advisoryGaps.some(g=>g.code==='ORDER_LINES_USED_AS_ALLOCATION_WEIGHTS'));
  assert.equal(result.coverage.freight.estimated_freight_amount,'2.00');
  assert.equal(result.coverage.freight.total_freight_amount,'5.00');
  assert.equal(result.coverage.policy.platformFeeRate,0.06);
  assert.equal(result.coverage.policy.taxRate,0.02);
  assert.equal(result.coverage.policy.missingFreightPerWaybill,2);
  assert.equal(result.coverage.policy.costBasis,'current_approved_sku_cost');
  assert.equal(result.coverage.costs.latestSync.batch_id,'batch-1');
  assert.equal(client.calls.find(call=>call.sql.includes("value_state='actual'")).params[4],true);
  assert.deepEqual(result.coverage.refunds.unmapped_refund_details,[{wdtTradeNo:'T1',platformTradeId:'P1'}]);
  assert.deepEqual(result.coverage.costs.missing_items,[{erpSpecNo:'S1'}]);
  assert.ok(result.blockingGaps.some(g=>g.code==='GOODS_COST_MISSING'));
  assert.equal(result.blockingGaps.some(g=>g.code.includes('SNAPSHOT')),false);
  assert.ok(result.advisoryGaps.some(g=>g.code==='FREIGHT_ESTIMATED_BY_CONFIRMED_POLICY'&&g.amount==='2.00'));
  assert.ok(result.advisoryGaps.some(g=>g.code==='REFUND_LINE_UNMAPPED'&&g.amount==='2.00'));
  assert.equal(client.calls.every(call=>call.params.every(value=>value !== undefined)),true);
});

test('actual coverage is routed and advertised as a stable business capability',()=>{
  assert.ok(ROUTED_COMMAND_KEYS.includes('profit actual coverage'));
  assert.ok(ROUTED_COMMAND_KEYS.includes('profit actual query'));
  assert.ok(ROUTED_COMMAND_KEYS.includes('profit actual audit-cost'));
  assert.ok(ROUTED_COMMAND_KEYS.includes('profit actual audit-order-cost'));
  assert.ok(ROUTED_COMMAND_KEYS.includes('profit actual audit-combo-cost'));
  assert.ok(ROUTED_COMMAND_KEYS.includes('profit actual audit-reference-cost'));
  assert.ok(ROUTED_COMMAND_KEYS.includes('profit actual audit-freight-fallback'));
  const definition=COMMAND_DEFINITIONS.find(item=>item.key==='profit actual coverage');
  assert.equal(definition.maturity,'stable');
  assert.equal(definition.audience,'business');
  assert.equal(definition.capability.id,'profit-actual-coverage');
  assert.match(definition.capability.commandTemplate,/--month <YYYY-MM>/);
  assert.equal(ACTUAL_PROFIT_POLICY.version,'operating-profit-v5');
  assert.equal(ACTUAL_PROFIT_POLICY.returnResaleRate,0.5);
  assert.equal(ACTUAL_PROFIT_POLICY.freightAllocationBasis,'platform_sku_gross_weight');
  assert.equal(ACTUAL_PROFIT_POLICY.ignoredPlaceholderSpecNo,'dc99999');
  assert.equal(ACTUAL_PROFIT_POLICY.revenueBasis,'order_header_paid');
  assert.deepEqual(ACTUAL_PROFIT_POLICY.nonMerchandiseProducts['641773251256'],{
    type:'price_adjustment_link',ownerRequired:false,costState:'explicit_zero',
  });
  assert.deepEqual(ACTUAL_PROFIT_POLICY.ownerOptionalProducts['2821074747423457561'],{
    type:'delisted_product',ownerRequired:false,
  });
  const queryDefinition=COMMAND_DEFINITIONS.find(item=>item.key==='profit actual query');
  assert.equal(queryDefinition.maturity,'stable');
  assert.equal(queryDefinition.audience,'business');
  assert.equal(queryDefinition.capability.id,'profit-actual-query');
  assert.match(queryDefinition.capability.commandTemplate,/--group-by shop\|owner\|product\|day\|report/);
  const auditDefinition=COMMAND_DEFINITIONS.find(item=>item.key==='profit actual audit-cost');
  assert.equal(auditDefinition.maturity,'stable');
  assert.equal(auditDefinition.audience,'business');
  assert.equal(auditDefinition.capability.id,'profit-actual-cost-audit');
  assert.match(auditDefinition.capability.commandTemplate,/--product-id <ID>/);
  const orderAuditDefinition=COMMAND_DEFINITIONS.find(item=>item.key==='profit actual audit-order-cost');
  assert.equal(orderAuditDefinition.maturity,'stable');
  assert.equal(orderAuditDefinition.audience,'business');
  assert.equal(orderAuditDefinition.capability.id,'profit-actual-order-cost-audit');
  assert.match(orderAuditDefinition.capability.commandTemplate,/--sample-size <N>/);
  const comboAuditDefinition=COMMAND_DEFINITIONS.find(item=>item.key==='profit actual audit-combo-cost');
  assert.equal(comboAuditDefinition.maturity,'stable');
  assert.equal(comboAuditDefinition.audience,'business');
  assert.equal(comboAuditDefinition.capability.id,'profit-actual-combo-cost-audit');
  assert.match(comboAuditDefinition.capability.commandTemplate,/--platform-sku-id <ID>/);
  const referenceAuditDefinition=COMMAND_DEFINITIONS.find(item=>item.key==='profit actual audit-reference-cost');
  assert.equal(referenceAuditDefinition.maturity,'stable');
  assert.equal(referenceAuditDefinition.audience,'business');
  assert.equal(referenceAuditDefinition.capability.id,'profit-actual-reference-cost-audit');
  const freightAuditDefinition=COMMAND_DEFINITIONS.find(item=>item.key==='profit actual audit-freight-fallback');
  assert.equal(freightAuditDefinition.capability.id,'profit-actual-freight-fallback-audit');
});

test('freight fallback audit classifies all affected orders without changing allocation',async()=>{
  const calls=[];
  const client={query:async(sql,params=[])=>{
    calls.push({sql,params});
    assert.match(sql.trim(),/^(SELECT|WITH)\b/);
    assert.doesNotMatch(sql,/\b(CREATE|INSERT|UPDATE|DELETE|DROP|GRANT|REVOKE)\b/i);
    if(sql.startsWith('SELECT shop_name')) return {rows:[{shop_name:'天猫 Demo'}]};
    return {rows:[
      {wdt_trade_no:'T1',freight_cost:'12.50',missing_sku_count:2,sku_group_count:3,known_weight_sku_groups:1,mapping_issues:1,
        missing_weight_issues:1,unusable_weight_issues:0,operator_count:2,
        unassigned_product_count:0,owners:['甲','乙'],issue_skus:[{platformSkuId:'S1'}]},
      {wdt_trade_no:'T2',freight_cost:'2.00',missing_sku_count:1,sku_group_count:1,known_weight_sku_groups:0,mapping_issues:0,
        missing_weight_issues:1,unusable_weight_issues:0,operator_count:1,
        unassigned_product_count:0,owners:['甲'],issue_skus:[{platformSkuId:'S2'}]},
    ]};
  }};
  const result=await getActualFreightFallbackAudit(client,{shopKey:'demo',month:'2026-07',limit:1});
  assert.equal(result.calculationPerformed,false);
  assert.equal(result.summary.fallbackOrders,2);
  assert.equal(result.summary.fallbackFreightAmount,'14.50');
  assert.deepEqual(result.summary.byOwnerScope.multiple_operators,{orders:1,freightAmount:'12.50'});
  assert.deepEqual(result.summary.byPrimaryReason.component_mapping_or_quantity_mismatch,
    {orders:1,freightAmount:'12.50'});
  assert.equal(result.summary.byIssue.sku_weight_missing.orders,2);
  assert.equal(result.topOrders.length,1);
  assert.equal(result.priorityOrders[0].wdtTradeNo,'T1');
  assert.equal(result.priorityOrders[0].knownWeightSkuGroups,1);
  assert.match(calls[1].sql,/master\.current_platform_sku_components/);
  assert.match(calls[1].sql,/master\.product_owner_versions/);
  assert.deepEqual(calls[1].params.slice(0,4),['demo','2026-07-01','2026-07-31',true]);
  await assert.rejects(getActualFreightFallbackAudit(client,{shopKey:'demo',month:'2026-07',limit:0}),/--limit/);
  await assert.rejects(getActualFreightFallbackAudit(client,{shopKey:'demo',month:'2026-07',policyVersion:'operating-profit-v3'}),/仅支持/);
});

test('pooled shared components recover unique platform SKU units only when all quantities reconcile',()=>{
  const base=[
    {platformSkuId:'A',productIds:['P'],purchasedUnits:null,owners:['甲'],
      expectedComponents:[{erpSpecNo:'main-a',quantityPerUnit:1},{erpSpecNo:'gift',quantityPerUnit:1}],
      observedComponents:[{erpSpecNo:'main-a',quantity:1}],
      unitGrossWeightKg:0.7,weightStatus:'estimated',sampleCount:10,
      sourceRevenueWeight:30,lineCount:1},
    {platformSkuId:'B',productIds:['P'],purchasedUnits:null,owners:['甲'],
      expectedComponents:[{erpSpecNo:'main-b',quantityPerUnit:1},{erpSpecNo:'gift',quantityPerUnit:1}],
      observedComponents:[{erpSpecNo:'main-b',quantity:1},{erpSpecNo:'gift',quantity:2}],
      unitGrossWeightKg:0.9,weightStatus:'estimated',sampleCount:10,
      sourceRevenueWeight:40,lineCount:2},
    {platformSkuId:'C',productIds:['Q'],purchasedUnits:1,owners:['乙'],
      expectedComponents:[{erpSpecNo:'other',quantityPerUnit:1}],
      observedComponents:[{erpSpecNo:'other',quantity:1}],
      unitGrossWeightKg:0.4,weightStatus:'estimated',sampleCount:10,
      sourceRevenueWeight:30,lineCount:1},
  ];
  const candidates=jointPurchaseCandidates(base);
  assert.equal(candidates.length,1);
  assert.deepEqual(candidates[0].skuUnits.map(sku=>sku.purchasedUnits),[1,1]);
  const comparison=candidateWeightComparison({sku_details:base,order_line_count:4,
    order_revenue_weight:'100',paid_amount:'100',freight_cost:'10'},candidates);
  assert.equal(comparison.totalAllocationWeightKg,2);
  assert.equal(comparison.byOwner.find(row=>row.owner==='甲').candidateWeightFreight,'8.0000');
  assert.equal(comparison.byOwner.find(row=>row.owner==='甲').currentRevenueFallbackFreight,'7.0000');
  const inconsistent=structuredClone(base);
  inconsistent[1].observedComponents[1].quantity=3;
  assert.deepEqual(jointPurchaseCandidates(inconsistent),[]);
  const noAnchor=structuredClone(base);
  noAnchor[1].expectedComponents=[{erpSpecNo:'gift',quantityPerUnit:1}];
  assert.deepEqual(jointPurchaseCandidates(noAnchor),[]);
});

test('reference cost audit requires complete matching coverage before policy readiness',async()=>{
  const calls=[];
  const client={query:async(sql,params=[])=>{
    calls.push({sql,params});
    if(sql.startsWith('SELECT shop_name')) return {rows:[{shop_name:'天猫 Demo'}]};
    return {rows:[{
      line_count:'101',explicit_zero_lines:'1',merchandise_lines:'100',reference_present_lines:'100',
      reference_missing_lines:'0',reference_zero_lines:'0',reference_false_zero_lines:'0',master_present_lines:'100',
      master_missing_lines:'0',comparable_lines:'100',matching_lines:'99',mismatch_lines:'1',
      reference_cost_total:'500.00',master_cost_total:'499.00',comparable_difference:'1.00',
      mismatch_examples:[{erpSpecNo:'S1',difference:'1.00'}],missing_reference_items:[],
    }]};
  }};
  const result=await getActualReferenceCostAudit(client,{shopKey:'demo',month:'2026-07'});
  assert.equal(result.calculationPerformed,false);
  assert.equal(result.summary.referenceCoverageRate,1);
  assert.equal(result.summary.comparableRate,1);
  assert.equal(result.summary.readyForReferenceFirstPolicy,false);
  assert.equal(result.summary.mismatchLines,1);
  assert.deepEqual(result.mismatchExamples,[{erpSpecNo:'S1',difference:'1.00'}]);
  assert.deepEqual(calls[1].params[3],['641773251256']);
  assert.match(calls[1].sql,/source_ref_unit_cost/);
  assert.match(calls[1].sql,/readyForReferenceFirstPolicy|reference_present_lines/);
});

test('actual cost audit compares goodsCost with both SKU unit-cost sources per order line',async()=>{
  const calls=[];
  const client={query:async(sql,params=[])=>{
    calls.push({sql,params});
    if(sql.startsWith('SELECT shop_name')) return {rows:[{shop_name:'天猫 Demo'}]};
    return {rows:[
      {paid_date:'2026-07-01',wdt_trade_no:'T1',order_line_key:'L1',platform_product_id:'P1',platform_sku_id:'PS1',erp_spec_no:'S1',product_name:'商品',sku_name:'规格1',quantity:'2',source_goods_cost:'6',source_ref_unit_cost:'3',master_unit_cost:'3'},
      {paid_date:'2026-07-02',wdt_trade_no:'T2',order_line_key:'L2',platform_product_id:'P1',platform_sku_id:'PS2',erp_spec_no:'S2',product_name:'商品',sku_name:'规格2',quantity:'3',source_goods_cost:'10',source_ref_unit_cost:'3',master_unit_cost:null},
    ]};
  }};
  const result=await getActualCostAudit(client,{shopKey:'demo',month:'2026-07',productId:'P1'});
  assert.equal(result.calculationPerformed,false);
  assert.equal(result.summary.lineCount,2);
  assert.equal(result.summary.orderCount,2);
  assert.equal(result.summary.quantityTotal,5);
  assert.equal(result.summary.sourceGoodsCostTotal,16);
  assert.equal(result.summary.sourceRefCalculatedCostTotal,15);
  assert.equal(result.summary.masterCalculatedCostTotal,6);
  assert.equal(result.summary.goodsVsSourceRef.matchLineCount,1);
  assert.equal(result.summary.goodsVsSourceRef.mismatchLineCount,1);
  assert.equal(result.summary.goodsVsSourceRef.absoluteDifferenceTotal,1);
  assert.equal(result.summary.goodsVsMaster.unavailableLineCount,1);
  assert.equal(result.summary.fullyComparable,false);
  assert.equal(result.rows[1].goodsVsSourceRef.difference,1);
  assert.equal(calls[1].params[3],'P1');
  assert.match(calls[1].sql,/source_ref_unit_cost/);
  assert.match(calls[1].sql,/master\.sku_cost_versions/);
});

test('whole-order cost audit compares sums only when every line is covered',async()=>{
  const calls=[];
  const client={query:async(sql,params=[])=>{
    calls.push({sql,params});
    if(sql.startsWith('SELECT shop_name')) return {rows:[{shop_name:'天猫 Demo'}]};
    return {rows:[
      {paid_date:'2026-07-01',wdt_trade_no:'T1',line_count:'2',product_count:'1',sku_count:'2',quantity_total:'3',source_goods_missing_lines:'0',source_goods_zero_lines:'1',source_goods_cost_total:'10',source_ref_missing_lines:'0',source_ref_calculated_cost_total:'10',master_missing_lines:'0',master_calculated_cost_total:'10',eligible_order_count:'100',detail_lines:[
        {orderLineKey:'L1',platformProductId:'P1',platformSkuId:'PS1',erpSpecNo:'S1',productName:'商品',skuName:'规格1',quantity:2,sourceGoodsCost:0,sourceRefUnitCost:3,sourceRefCalculatedCost:6,masterUnitCost:3,masterCalculatedCost:6},
        {orderLineKey:'L2',platformProductId:'P1',platformSkuId:'PS2',erpSpecNo:'S2',productName:'商品',skuName:'规格2',quantity:1,sourceGoodsCost:10,sourceRefUnitCost:4,sourceRefCalculatedCost:4,masterUnitCost:4,masterCalculatedCost:4},
      ]},
      {paid_date:'2026-07-02',wdt_trade_no:'T2',line_count:'1',product_count:'1',sku_count:'1',quantity_total:'1',source_goods_missing_lines:'0',source_goods_zero_lines:'1',source_goods_cost_total:'0',source_ref_missing_lines:'0',source_ref_calculated_cost_total:'5',master_missing_lines:'1',master_calculated_cost_total:null,eligible_order_count:'100'},
    ]};
  }};
  const result=await getActualOrderCostAudit(client,{shopKey:'demo',month:'2026-07',orderNos:'T1,T2,T3'});
  assert.equal(result.selection.mode,'explicit-orders');
  assert.equal(result.selection.eligibleOrderCount,100);
  assert.deepEqual(result.selection.missingRequestedOrderNos,['T3']);
  assert.equal(result.summary.orderCount,2);
  assert.equal(result.summary.ordersWithZeroGoodsCostLines,2);
  assert.equal(result.summary.goodsVsSourceRef.matchOrderCount,1);
  assert.equal(result.summary.goodsVsSourceRef.mismatchOrderCount,1);
  assert.equal(result.summary.goodsVsMaster.unavailableOrderCount,1);
  assert.equal(result.rows[0].goodsVsSourceRef.matches,true);
  assert.equal(result.rows[0].detailLines.length,2);
  assert.equal(result.rows[0].detailLines[0].goodsVsSourceRef.difference,-6);
  assert.equal(result.rows[0].detailLines[1].sourceRefCalculatedCost,4);
  assert.equal(result.rows[1].goodsVsSourceRef.difference,-5);
  assert.deepEqual(calls[1].params[3],['T1','T2','T3']);
  assert.match(calls[1].sql,/GROUP BY wdt_trade_no/);
});

test('combo cost audit finds affected combination SKUs and preserves component evidence',async()=>{
  const calls=[];
  const client={query:async(sql,params=[])=>{
    calls.push({sql,params});
    if(sql.startsWith('SELECT shop_name')) return {rows:[{shop_name:'天猫 Demo'}]};
    return {rows:[{
      platform_product_id:'P1',platform_sku_id:'PS1',product_name:'组合商品',erp_spec_nos:['S1','S2'],
      first_paid_date:'2026-07-01',last_paid_date:'2026-07-31',order_count:'10',line_count:'20',quantity_total:'30',
      goods_zero_lines:'12',positive_cost_zero_lines:'12',goods_missing_lines:'0',ref_missing_lines:'0',master_missing_lines:'0',
      goods_ref_match_orders:'2',goods_ref_mismatch_orders:'8',goods_ref_unavailable_orders:'0',all_goods_zero_orders:'5',
      goods_cost_total:'20',ref_cost_total:'100',master_cost_total:'100',mismatch_order_examples:['T1','T2'],
    }]};
  }};
  const result=await getActualComboCostAudit(client,{shopKey:'demo',month:'2026-07',productId:'P1'});
  assert.equal(result.calculationPerformed,false);
  assert.equal(result.summary.comboSkuCount,1);
  assert.equal(result.summary.affectedComboSkuCount,1);
  assert.equal(result.summary.costDifference,-80);
  assert.deepEqual(result.rows[0].erpSpecNos,['S1','S2']);
  assert.equal(result.rows[0].goodsVsRef.difference,-80);
  assert.equal(result.rows[0].refVsMaster.matches,true);
  assert.equal(calls[1].params[3],'P1');
  assert.match(calls[1].sql,/HAVING count\(DISTINCT erp_spec_no\)>1/);
});

test('confirmed freight fallback makes a complete calculation provisional, not incomplete',async()=>{
  const result=await getActualProfitCoverage(reader({allocatedLineRevenue:'100.00',missingCostLines:'0'}),{shopKey:'demo',month:'2026-07'});
  assert.equal(result.blockingGaps.length,0);
  assert.equal(result.status,'provisional');
  assert.equal(result.coverage.freight.value_states.estimated.amount,'2.00');
});

test('legacy profit policy remains explicitly selectable with paid-date cost logic',async()=>{
  const client=reader({allocatedLineRevenue:'100.00',missingCostLines:'0'});
  const result=await getActualProfitCoverage(client,{shopKey:'demo',month:'2026-07',policyVersion:'operating-profit-v1'});
  assert.equal(result.coverage.policy.version,'operating-profit-v1');
  assert.equal(result.coverage.policy.costBasis,'order_goods_cost_then_paid_date_sku_cost');
  assert.equal(client.calls.find(call=>call.sql.includes("value_state='actual'")).params[4],false);
  assert.equal(client.calls.some(call=>call.sql.includes("data_type='sku-cost-sync'")),false);
  assert.equal(client.calls.find(call=>call.sql.includes('AS eligible_orders')).params[3],false);
});

test('v3 retains revenue allocation and zero-value placeholder exclusion',async()=>{
  const client=reader({allocatedLineRevenue:'100.00',missingCostLines:'0'});
  const result=await getActualProfitQuery(client,{shopKey:'demo',month:'2026-07',groupBy:'report',policyVersion:'operating-profit-v3'});
  assert.equal(result.policy.version,'operating-profit-v3');
  const orderCall=client.calls.find(call=>call.sql.includes('AS eligible_orders'));
  const refundCall=client.calls.find(call=>call.sql.includes('AS settled_refunds'));
  const freightCall=client.calls.find(call=>call.sql.includes('AS shipment_waybills'));
  const costCall=client.calls.find(call=>call.sql.includes("value_state='actual'"));
  const ownerCall=client.calls.find(call=>call.sql.includes('AS assigned_product_days'));
  const profitCall=client.calls.find(call=>call.sql.includes('freight_targets AS MATERIALIZED'));
  assert.equal(orderCall.params[3],true);
  assert.equal(refundCall.params[4],true);
  assert.equal(freightCall.params[3],true);
  assert.equal(costCall.params[5],true);
  assert.equal(ownerCall.params[5],true);
  assert.equal(profitCall.params[11],true);
  assert.equal(profitCall.params[12],true);
  for(const call of [orderCall,refundCall,freightCall,costCall,ownerCall,profitCall]) {
    assert.match(call.sql,/p\.erp_spec_no='dc99999'/);
    assert.match(call.sql,/h\.paid_amount=0/);
    assert.match(call.sql,/p\.erp_spec_no IS DISTINCT FROM 'dc99999'/);
    assert.match(call.sql,/coalesce\(p\.source_line_paid,0\)<>0/);
  }
  assert.equal(result.reconciliation.ownerToShop.passed,true);
  assert.equal(result.reconciliation.productToShop.passed,true);
});

test('v2 preserves previous scope while retaining current SKU cost',async()=>{
  const client=reader({allocatedLineRevenue:'100.00',missingCostLines:'0'});
  const result=await getActualProfitQuery(client,{shopKey:'demo',month:'2026-07',groupBy:'shop',policyVersion:'operating-profit-v2'});
  assert.equal(result.policy.version,'operating-profit-v2');
  assert.equal(client.calls.find(call=>call.sql.includes('AS eligible_orders')).params[3],false);
  const profitCall=client.calls.find(call=>call.sql.includes('freight_targets AS MATERIALIZED'));
  assert.equal(profitCall.params[11],true);
  assert.equal(profitCall.params[12],false);
});

test('actual report query returns shop, owner and product sections from one read-only calculation',async()=>{
  const sql=buildActualProfitQuery('report');
  assert.match(sql,/GROUP BY GROUPING SETS/);
  assert.match(sql,/GROUPING SETS \(\(\),\(owner_name\),\(platform_product_id\)\)/);
  assert.doesNotMatch(sql,/platform_product_id,product_name,owner_name/);
  assert.match(sql,/array_agg\(product_name ORDER BY stat_date DESC\)/);
  assert.match(sql,/coalesce\(i\.product_title,l\.product_name\)/);
  assert.match(sql,/product_image_url/);
  assert.match(sql,/master\.product_image_mappings/);
  assert.match(sql,/master\.current_sku_costs current_cost/);
  assert.match(sql,/\$12::boolean/);
  assert.match(sql,/master\.current_platform_sku_components/);
  assert.match(sql,/master\.current_platform_sku_gross_weights/);
  assert.match(sql,/sw\.allocation_weight_kg\/ow\.order_weight_kg\*coalesce\(l\.shipped_quantity/);
  assert.match(sql,/refund_cost_quantities/);
  assert.match(sql,/\$14::numeric/);
  assert.match(buildActualProfitQuery('shop','operating-profit-v4'),/sw\.allocation_weight_kg\/ow\.order_weight_kg\/sc\.line_count/);
  assert.match(sql,/paid_amount\*allocation_weight\/order_weight/);
  assert.match(sql,/round\(sum\(charge_amount\),2\)/);
  assert.doesNotMatch(sql,/\b(CREATE|INSERT|UPDATE|DELETE|DROP|GRANT|REVOKE)\b/i);
  assert.equal(validateActualProfitQueryRequest({shopKey:'demo',month:'2026-07',groupBy:'report'}).groupBy,'report');
  assert.throws(()=>validateActualProfitQueryRequest({shopKey:'demo',month:'2026-07',groupBy:'sku'}),/仅支持/);
  const result=await getActualProfitQuery(reader({allocatedLineRevenue:'100.00',missingCostLines:'0'}),{shopKey:'demo',month:'2026-07',groupBy:'report'});
  assert.equal(result.calculationPerformed,true);
  assert.equal(result.sections.shop.length,1);
  assert.equal(result.sections.owners[0].owner_name,'甲');
  assert.equal(result.sections.products[0].platform_product_id,'p1');
  assert.equal(result.sections.products[0].product_image_url,'https://img.example.com/p1.jpg');
  assert.equal(result.reconciliation.ownerToShop.passed,true);
  assert.equal(result.reconciliation.productToShop.passed,true);
  assert.equal(result.quality.freightAllocation.method,'platform_sku_gross_weight');
});

test('v5 passes the adjustable resale assumption and preserves v4 parameter contract',async()=>{
  const current=reader({allocatedLineRevenue:'100.00',missingCostLines:'0'});
  const result=await getActualProfitQuery(current,{shopKey:'demo',month:'2026-07',returnResaleRate:'0.75'});
  const currentQuery=current.calls.find(call=>call.sql.includes('refund_cost_quantities'));
  assert.equal(currentQuery.params.length,14);
  assert.equal(currentQuery.params[13],0.75);
  assert.equal(result.policy.returnResaleRate,0.75);
  const previous=reader({allocatedLineRevenue:'100.00',missingCostLines:'0'});
  await getActualProfitQuery(previous,{shopKey:'demo',month:'2026-07',policyVersion:'operating-profit-v4'});
  const previousQuery=previous.calls.find(call=>call.sql.includes('freight_targets AS MATERIALIZED'));
  assert.equal(previousQuery.params.length,13);
  assert.doesNotMatch(previousQuery.sql,/refund_cost_quantities/);
});

test('v4 exposes revenue fallback for orders still missing a gross weight',async()=>{
  const client=reader({allocatedLineRevenue:'100.00',missingCostLines:'0',missingWeightOrders:1});
  const coverage=await getActualProfitCoverage(client,{shopKey:'demo',month:'2026-07'});
  assert.equal(coverage.status,'provisional');
  assert.ok(coverage.advisoryGaps.some(gap=>gap.code==='SKU_GROSS_WEIGHT_REVENUE_FALLBACK'&&gap.freightAmount==='1.20'));
  const result=await getActualProfitQuery(client,{shopKey:'demo',month:'2026-07',groupBy:'owner'});
  assert.equal(result.quality.freightAllocation.fallbackFreightAmount,'1.20');
  assert.equal(result.quality.freightAllocation.inferredSkuGroups,1);
  assert.equal(result.quality.freightAllocation.sharedInferredSkuGroups,1);
  assert.equal(client.calls.filter(call=>call.sql.includes('freight_targets AS MATERIALIZED')).length,1);
});
