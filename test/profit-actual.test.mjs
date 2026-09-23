import assert from 'node:assert/strict';
import test from 'node:test';
import {ACTUAL_PROFIT_POLICY,actualProfitPeriod,buildActualProfitQuery,getActualCostAudit,getActualProfitCoverage,getActualProfitQuery,validateActualCostAuditRequest,validateActualCoverageRequest,validateActualProfitQueryRequest} from '../src/tbcli/profit-actual.mjs';
import {COMMAND_DEFINITIONS} from '../src/tbcli/command-registry.mjs';
import {ROUTED_COMMAND_KEYS} from '../src/tbcli/cli.mjs';

function reader({allocatedLineRevenue='101.00',missingCostLines='1'}={}) {
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
  assert.equal(validateActualCoverageRequest({shopKey:'demo',month:'2026-07'}).policyVersion,'operating-profit-v1');
  assert.throws(()=>validateActualCoverageRequest({shopKey:'demo',month:'2026-07',policyVersion:'other'}),/仅支持/);
  assert.throws(()=>validateActualCostAuditRequest({shopKey:'demo',month:'2026-07'}),/product-id/);
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
  const definition=COMMAND_DEFINITIONS.find(item=>item.key==='profit actual coverage');
  assert.equal(definition.maturity,'stable');
  assert.equal(definition.audience,'business');
  assert.equal(definition.capability.id,'profit-actual-coverage');
  assert.match(definition.capability.commandTemplate,/--month <YYYY-MM>/);
  assert.equal(ACTUAL_PROFIT_POLICY.version,'operating-profit-v1');
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

test('confirmed freight fallback makes a complete calculation provisional, not incomplete',async()=>{
  const result=await getActualProfitCoverage(reader({allocatedLineRevenue:'100.00',missingCostLines:'0'}),{shopKey:'demo',month:'2026-07'});
  assert.equal(result.blockingGaps.length,0);
  assert.equal(result.status,'provisional');
  assert.equal(result.coverage.freight.value_states.estimated.amount,'2.00');
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
  assert.doesNotMatch(sql,/master\.current_platform_sku_components/);
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
});
