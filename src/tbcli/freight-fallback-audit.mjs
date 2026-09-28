import {
  ACTUAL_PROFIT_POLICY,SKU_GROSS_WEIGHT_CTES,excludePlaceholderOrder,
  validateActualCoverageRequest,
} from './profit-actual.mjs';

const FALLBACK_AUDIT_SQL = `WITH scoped_orders AS MATERIALIZED (
    SELECT h.wdt_trade_no,(h.paid_at AT TIME ZONE 'Asia/Shanghai')::date AS paid_date,
      h.paid_amount
    FROM raw.wdt_order_headers h
    WHERE h.shop_key=$1 AND h.order_status_code=95
      AND (h.paid_at AT TIME ZONE 'Asia/Shanghai')::date BETWEEN $2::date AND $3::date
      AND ($7::text[] IS NULL OR h.wdt_trade_no=ANY($7::text[]))
      ${excludePlaceholderOrder(4)}
      AND EXISTS (SELECT 1 FROM raw.shipments s WHERE s.shop_key=h.shop_key
        AND s.wdt_trade_no=h.wdt_trade_no AND nullif(trim(s.tracking_no),'') IS NOT NULL)
  ), valued_lines AS MATERIALIZED (
    SELECT l.wdt_trade_no,l.platform_product_id,l.platform_sku_id,l.erp_spec_no,
      coalesce(l.quantity,0) AS quantity,
      coalesce(l.source_share_amount,l.source_line_paid,0) AS revenue_weight
    FROM raw.wdt_order_lines l JOIN scoped_orders o USING(wdt_trade_no)
    WHERE l.shop_key=$1
  )${SKU_GROSS_WEIGHT_CTES.replaceAll('__NON_MERCH_PARAM__','$5')}, scoped_tracking AS MATERIALIZED (
    SELECT DISTINCT s.wdt_trade_no,s.tracking_no FROM raw.shipments s
    JOIN scoped_orders o USING(wdt_trade_no) WHERE s.shop_key=$1
      AND nullif(trim(s.tracking_no),'') IS NOT NULL
  ), tracking_order_counts AS MATERIALIZED (
    SELECT tracking_no,count(DISTINCT wdt_trade_no)::numeric AS order_count
    FROM scoped_tracking GROUP BY tracking_no
  ), tracking_charges AS MATERIALIZED (
    SELECT tracking_no,round(sum(charge_amount),2) AS charge_amount
    FROM raw.courier_bill_charges WHERE tracking_no IN (SELECT tracking_no FROM scoped_tracking)
    GROUP BY tracking_no
  ), order_freight AS MATERIALIZED (
    SELECT t.wdt_trade_no,sum(coalesce(c.charge_amount,$6::numeric)/n.order_count) AS freight_cost
    FROM scoped_tracking t JOIN tracking_order_counts n USING(tracking_no)
    LEFT JOIN tracking_charges c USING(tracking_no)
    GROUP BY t.wdt_trade_no
  ), fallback_orders AS MATERIALIZED (
    SELECT o.wdt_trade_no,o.missing_sku_count,o.order_weight_kg,
      f.freight_cost,s.paid_date,s.paid_amount
    FROM order_weight_totals o JOIN order_freight f USING(wdt_trade_no)
    JOIN scoped_orders s USING(wdt_trade_no)
    WHERE o.missing_sku_count>0 OR coalesce(o.order_weight_kg,0)<=0
  ), issue_skus AS MATERIALIZED (
    SELECT w.wdt_trade_no,w.platform_sku_id,w.purchased_units,
      w.unit_gross_weight_kg,w.confidence_score,w.observed_count,w.matched_count,
      w.expected_count,w.product_count,
      CASE WHEN w.purchased_units IS NULL THEN 'component_mapping_or_quantity_mismatch'
        WHEN w.unit_gross_weight_kg IS NULL THEN 'sku_weight_missing'
        ELSE 'sku_weight_unusable' END AS reason
    FROM order_sku_weights w JOIN fallback_orders f USING(wdt_trade_no)
    WHERE w.allocation_weight_kg IS NULL
  ), issue_counts AS MATERIALIZED (
    SELECT wdt_trade_no,
      count(*) FILTER(WHERE reason='component_mapping_or_quantity_mismatch')::integer AS mapping_issues,
      count(*) FILTER(WHERE reason='sku_weight_missing')::integer AS missing_weight_issues,
      count(*) FILTER(WHERE reason='sku_weight_unusable')::integer AS unusable_weight_issues
    FROM issue_skus GROUP BY wdt_trade_no
  ), group_counts AS MATERIALIZED (
    SELECT w.wdt_trade_no,count(*)::integer AS sku_group_count,
      count(*) FILTER(WHERE w.allocation_weight_kg>0)::integer AS known_weight_sku_groups
    FROM order_sku_weights w JOIN fallback_orders f USING(wdt_trade_no)
    GROUP BY w.wdt_trade_no
  ), fallback_products AS MATERIALIZED (
    SELECT DISTINCT f.wdt_trade_no,f.paid_date,l.platform_product_id
    FROM fallback_orders f JOIN valued_lines l USING(wdt_trade_no)
  ), assigned_products AS MATERIALIZED (
    SELECT p.*,CASE WHEN nullif(trim(o.owner_name),'') IS NOT NULL
        AND o.owner_name NOT IN ('未分配','未分配负责人') THEN o.owner_name END AS owner_name
    FROM fallback_products p LEFT JOIN LATERAL (
      SELECT owner_name FROM master.product_owner_versions o WHERE o.shop_key=$1
        AND o.platform_product_id=p.platform_product_id AND o.status='approved'
        AND p.paid_date>=o.effective_from
        AND (o.effective_to IS NULL OR p.paid_date<=o.effective_to)
      ORDER BY o.effective_from DESC LIMIT 1
    ) o ON true
  ), owner_counts AS MATERIALIZED (
    SELECT wdt_trade_no,count(DISTINCT owner_name)::integer AS operator_count,
      count(*) FILTER(WHERE owner_name IS NULL)::integer AS unassigned_product_count,
      array_remove(array_agg(DISTINCT owner_name),NULL) AS owners
    FROM assigned_products GROUP BY wdt_trade_no
  )
  SELECT f.wdt_trade_no,f.freight_cost::text AS freight_cost,f.missing_sku_count,
    f.paid_amount::text AS paid_amount,
    (SELECT sum(revenue_weight)::text FROM valued_lines v
      WHERE v.wdt_trade_no=f.wdt_trade_no) AS order_revenue_weight,
    (SELECT count(*)::integer FROM valued_lines v
      WHERE v.wdt_trade_no=f.wdt_trade_no) AS order_line_count,
    CASE WHEN $7::text[] IS NOT NULL THEN (SELECT array_agg(DISTINCT t.tracking_no)
      FROM scoped_tracking t WHERE t.wdt_trade_no=f.wdt_trade_no)
      ELSE NULL END AS tracking_nos,
    CASE WHEN $7::text[] IS NOT NULL THEN (SELECT coalesce(jsonb_agg(jsonb_build_object(
      'trackingNo',x.tracking_no,'chargeAmount',x.charge_amount,
      'billableWeightKg',x.billable_weight_kg,'weightValueCount',x.weight_value_count)
      ORDER BY x.tracking_no),'[]'::jsonb) FROM (
        SELECT t.tracking_no,sum(c.charge_amount) AS charge_amount,
          max(c.billable_weight_kg) AS billable_weight_kg,
          count(DISTINCT c.billable_weight_kg)::integer AS weight_value_count
        FROM scoped_tracking t LEFT JOIN raw.courier_bill_charges c USING(tracking_no)
        WHERE t.wdt_trade_no=f.wdt_trade_no GROUP BY t.tracking_no
      ) x) ELSE '[]'::jsonb END AS tracking_details,
    coalesce(g.sku_group_count,0) AS sku_group_count,
    coalesce(g.known_weight_sku_groups,0) AS known_weight_sku_groups,
    coalesce(i.mapping_issues,0) AS mapping_issues,
    coalesce(i.missing_weight_issues,0) AS missing_weight_issues,
    coalesce(i.unusable_weight_issues,0) AS unusable_weight_issues,
    coalesce(o.operator_count,0) AS operator_count,
    coalesce(o.unassigned_product_count,0) AS unassigned_product_count,
    coalesce(o.owners,'{}'::text[]) AS owners,
    (SELECT coalesce(jsonb_agg(jsonb_build_object(
      'platformSkuId',s.platform_sku_id,'reason',s.reason,
      'purchasedUnits',s.purchased_units,'unitGrossWeightKg',s.unit_gross_weight_kg,
      'confidenceScore',s.confidence_score,'observedComponents',s.observed_count,
      'matchedComponents',s.matched_count,'expectedComponents',s.expected_count,
      'productCount',s.product_count) ORDER BY s.platform_sku_id),'[]'::jsonb)
      FROM issue_skus s WHERE s.wdt_trade_no=f.wdt_trade_no) AS issue_skus,
    CASE WHEN $7::text[] IS NOT NULL THEN (SELECT coalesce(jsonb_agg(jsonb_build_object(
      'platformSkuId',w.platform_sku_id,'purchasedUnits',w.purchased_units,
      'unitGrossWeightKg',w.unit_gross_weight_kg,'allocationWeightKg',w.allocation_weight_kg,
      'confidenceScore',w.confidence_score,'weightStatus',w.weight_status,
      'sampleCount',w.sample_count,'nonMerchandise',w.non_merchandise,
      'productIds',(SELECT array_remove(array_agg(DISTINCT v.platform_product_id),NULL)
        FROM valued_lines v WHERE v.wdt_trade_no=w.wdt_trade_no
          AND v.platform_sku_id IS NOT DISTINCT FROM w.platform_sku_id),
      'owners',(SELECT array_remove(array_agg(DISTINCT p.owner_name),NULL)
        FROM assigned_products p JOIN valued_lines v
          ON v.wdt_trade_no=p.wdt_trade_no AND v.platform_product_id IS NOT DISTINCT FROM p.platform_product_id
        WHERE v.wdt_trade_no=w.wdt_trade_no
          AND v.platform_sku_id IS NOT DISTINCT FROM w.platform_sku_id),
      'sourceRevenueWeight',(SELECT sum(v.revenue_weight) FROM valued_lines v
        WHERE v.wdt_trade_no=w.wdt_trade_no
          AND v.platform_sku_id IS NOT DISTINCT FROM w.platform_sku_id),
      'lineCount',(SELECT count(*) FROM valued_lines v
        WHERE v.wdt_trade_no=w.wdt_trade_no
          AND v.platform_sku_id IS NOT DISTINCT FROM w.platform_sku_id),
      'observedComponents',(SELECT coalesce(jsonb_agg(jsonb_build_object(
        'erpSpecNo',c.erp_spec_no,'quantity',c.actual_qty) ORDER BY c.erp_spec_no),'[]'::jsonb)
        FROM order_sku_components c WHERE c.wdt_trade_no=w.wdt_trade_no
          AND c.platform_sku_id IS NOT DISTINCT FROM w.platform_sku_id),
      'expectedComponents',(SELECT coalesce(jsonb_agg(jsonb_build_object(
        'erpSpecNo',m.erp_spec_no,'quantityPerUnit',m.component_qty) ORDER BY m.erp_spec_no),'[]'::jsonb)
        FROM master.current_platform_sku_components m WHERE m.shop_key=$1
          AND m.platform_sku_id IS NOT DISTINCT FROM w.platform_sku_id)
      ) ORDER BY w.platform_sku_id),'[]'::jsonb)
      FROM order_sku_weights w WHERE w.wdt_trade_no=f.wdt_trade_no)
      ELSE '[]'::jsonb END AS sku_details
  FROM fallback_orders f LEFT JOIN issue_counts i USING(wdt_trade_no)
  LEFT JOIN group_counts g USING(wdt_trade_no)
  LEFT JOIN owner_counts o USING(wdt_trade_no)
  ORDER BY abs(f.freight_cost) DESC,f.wdt_trade_no`;

function ownerScope(row) {
  const operators=Number(row.operator_count || 0);
  const unassigned=Number(row.unassigned_product_count || 0);
  if (operators>1) return 'multiple_operators';
  if (operators===1 && unassigned>0) return 'operator_and_unassigned';
  if (operators===1) return 'single_operator';
  return 'unassigned_only';
}

function primaryReason(row) {
  if (Number(row.mapping_issues)>0) return 'component_mapping_or_quantity_mismatch';
  if (Number(row.missing_weight_issues)>0) return 'sku_weight_missing';
  if (Number(row.unusable_weight_issues)>0) return 'sku_weight_unusable';
  return 'zero_allocation_weight';
}

function addGroup(groups,key,freightCost) {
  const group=groups[key] ||= {orders:0,freightAmount:0};
  group.orders+=1;
  group.freightAmount+=freightCost;
}

function roundedGroups(groups) {
  return Object.fromEntries(Object.entries(groups).map(([key,value])=>
    [key,{orders:value.orders,freightAmount:value.freightAmount.toFixed(2)}]));
}

export function jointPurchaseCandidates(skuDetails=[]) {
  const byProduct=new Map();
  for(const sku of skuDetails) {
    if(sku.productIds?.length!==1) continue;
    const productId=sku.productIds[0];
    if(!byProduct.has(productId)) byProduct.set(productId,[]);
    byProduct.get(productId).push(sku);
  }
  const candidates=[];
  for(const [platformProductId,skus] of byProduct) {
    if(skus.length<2 || !skus.some(sku=>sku.purchasedUnits==null)) continue;
    const expectedBySpec=new Map(),observedBySpec=new Map();
    let invalid=false;
    for(const sku of skus) {
      if(!sku.expectedComponents?.length) { invalid=true; break; }
      for(const component of sku.expectedComponents) {
        const qty=Number(component.quantityPerUnit);
        if(!Number.isFinite(qty)||qty<=0) {invalid=true;break;}
        if(!expectedBySpec.has(component.erpSpecNo)) expectedBySpec.set(component.erpSpecNo,[]);
        expectedBySpec.get(component.erpSpecNo).push({skuId:sku.platformSkuId,qty});
      }
      for(const component of sku.observedComponents||[]) {
        const qty=Number(component.quantity);
        if(!Number.isFinite(qty)||qty<0) {invalid=true;break;}
        observedBySpec.set(component.erpSpecNo,(observedBySpec.get(component.erpSpecNo)||0)+qty);
      }
      if(invalid) break;
    }
    if(invalid || expectedBySpec.size!==observedBySpec.size) continue;
    const units=new Map();
    for(const sku of skus) {
      const anchors=[...expectedBySpec.entries()]
        .filter(([,entries])=>entries.length===1&&entries[0].skuId===sku.platformSkuId)
        .map(([spec,entries])=>(observedBySpec.get(spec)||0)/entries[0].qty);
      if(!anchors.length || anchors.some(value=>!Number.isInteger(value)||value<=0||value!==anchors[0])) {
        invalid=true;break;
      }
      if(sku.purchasedUnits!=null && Number(sku.purchasedUnits)!==anchors[0]) {invalid=true;break;}
      units.set(sku.platformSkuId,anchors[0]);
    }
    if(invalid) continue;
    for(const [spec,entries] of expectedBySpec) {
      const predicted=entries.reduce((sum,entry)=>sum+units.get(entry.skuId)*entry.qty,0);
      if(Math.abs(predicted-(observedBySpec.get(spec)||0))>0.000001) {invalid=true;break;}
    }
    if(invalid) continue;
    candidates.push({platformProductId,method:'unique_component_anchors_and_pooled_reconciliation',
      skuUnits:skus.map(sku=>({platformSkuId:sku.platformSkuId,purchasedUnits:units.get(sku.platformSkuId),
        existingUnitGrossWeightKg:sku.unitGrossWeightKg,confidenceScore:sku.confidenceScore})),
      missingGrossWeightSkuCount:skus.filter(sku=>sku.unitGrossWeightKg==null||Number(sku.unitGrossWeightKg)<=0).length});
  }
  return candidates;
}

export function candidateWeightComparison(row,candidates) {
  if(!candidates.length || !row.sku_details?.length) return null;
  const unitsBySku=new Map(candidates.flatMap(candidate=>candidate.skuUnits.map(sku=>
    [sku.platformSkuId,sku.purchasedUnits])));
  const lineCount=Number(row.order_line_count||0);
  const revenueWeight=Number(row.order_revenue_weight||0);
  const paidAmount=Number(row.paid_amount||0);
  const freight=Number(row.freight_cost||0);
  const entries=[];
  for(const sku of row.sku_details) {
    if(sku.owners?.length!==1) return null;
    const units=sku.purchasedUnits==null?unitsBySku.get(sku.platformSkuId):Number(sku.purchasedUnits);
    let weight=0;
    if(!sku.nonMerchandise) {
      if(!Number.isInteger(units)||units<=0||
        !['estimated','inferred'].includes(sku.weightStatus)||Number(sku.sampleCount)<=0||
        Number(sku.unitGrossWeightKg)<=0) return null;
      weight=units*Number(sku.unitGrossWeightKg);
    }
    const revenueShare=paidAmount!==0&&revenueWeight!==0?
      Number(sku.sourceRevenueWeight||0)/revenueWeight:Number(sku.lineCount||0)/lineCount;
    entries.push({owner:sku.owners[0],weight,revenueShare});
  }
  const weightTotal=entries.reduce((sum,entry)=>sum+entry.weight,0);
  if(weightTotal<=0||!Number.isFinite(weightTotal)) return null;
  const byOwner=new Map();
  for(const entry of entries) {
    const current=byOwner.get(entry.owner)||{currentFreight:0,candidateFreight:0};
    current.currentFreight+=freight*entry.revenueShare;
    current.candidateFreight+=freight*entry.weight/weightTotal;
    byOwner.set(entry.owner,current);
  }
  return {status:'read_only_candidate',method:'joint_units_then_existing_sku_gross_weight',
    totalAllocationWeightKg:Number(weightTotal.toFixed(6)),
    byOwner:[...byOwner.entries()].map(([owner,values])=>({owner,
      currentRevenueFallbackFreight:values.currentFreight.toFixed(4),
      candidateWeightFreight:values.candidateFreight.toFixed(4),
      freightCostChange:(values.candidateFreight-values.currentFreight).toFixed(4),
      profitChange:(values.currentFreight-values.candidateFreight).toFixed(4)}))};
}

export function validateActualFreightFallbackAuditRequest(args={}) {
  const period=validateActualCoverageRequest(args);
  if(period.policyVersion!==ACTUAL_PROFIT_POLICY.version)
    throw new Error('运费回退审计仅支持 operating-profit-v4');
  const limit=args.limit==null?30:Number(args.limit);
  if(!Number.isInteger(limit)||limit<1||limit>1000) throw new Error('--limit 必须是 1–1000 的整数');
  const orderNos=args.orderNos==null?null:[...new Set(String(args.orderNos).split(/[,，\s]+/).map(value=>value.trim()).filter(Boolean))];
  if(orderNos && (!orderNos.length || orderNos.length>100))
    throw new Error('--order-nos 必须包含 1–100 个订单号');
  return {period,limit,orderNos};
}

export async function getActualFreightFallbackAudit(client,args={}) {
  const {period,limit,orderNos}=validateActualFreightFallbackAuditRequest(args);
  const name=await client.query('SELECT shop_name FROM raw.wdt_order_headers WHERE shop_key=$1 ORDER BY observed_at DESC LIMIT 1',[args.shopKey]);
  if(!name.rows.length) throw new Error('没有找到该店铺的订单事实');
  const rows=(await client.query(FALLBACK_AUDIT_SQL,[args.shopKey,period.startDate,period.endDate,true,
    Object.keys(ACTUAL_PROFIT_POLICY.nonMerchandiseProducts),ACTUAL_PROFIT_POLICY.missingFreightPerWaybill,orderNos])).rows;
  const byOwnerScope={},byPrimaryReason={},byIssue={};
  let freightTotal=0;
  const normalized=rows.map(row=>{
    const freightCost=Number(row.freight_cost||0);
    const scope=ownerScope(row),reason=primaryReason(row);
    freightTotal+=freightCost;
    addGroup(byOwnerScope,scope,freightCost);
    addGroup(byPrimaryReason,reason,freightCost);
    for(const [key,column] of [['component_mapping_or_quantity_mismatch','mapping_issues'],
      ['sku_weight_missing','missing_weight_issues'],['sku_weight_unusable','unusable_weight_issues']]) {
      if(Number(row[column])>0) addGroup(byIssue,key,freightCost);
    }
    const skuDetails=row.sku_details||[];
    const candidates=jointPurchaseCandidates(skuDetails);
    return {wdtTradeNo:row.wdt_trade_no,freightAmount:freightCost.toFixed(2),
      orderPaidAmount:row.paid_amount,orderRevenueWeight:row.order_revenue_weight,
      orderLineCount:Number(row.order_line_count||0),
      trackingNos:row.tracking_nos||[],
      trackingDetails:row.tracking_details||[],
      ownerScope:scope,owners:row.owners||[],operatorCount:Number(row.operator_count||0),
      unassignedProductCount:Number(row.unassigned_product_count||0),
      primaryReason:reason,issueSkuCount:Number(row.missing_sku_count||0),
      skuGroupCount:Number(row.sku_group_count||0),
      knownWeightSkuGroups:Number(row.known_weight_sku_groups||0),
      mappingIssues:Number(row.mapping_issues||0),missingWeightIssues:Number(row.missing_weight_issues||0),
      unusableWeightIssues:Number(row.unusable_weight_issues||0),issueSkus:row.issue_skus||[],
      skuDetails,jointPurchaseCandidates:candidates,
      candidateWeightComparison:candidateWeightComparison(row,candidates)};
  });
  return {mode:'live-read-only',calculationPerformed:false,audit:'freight-revenue-fallback',
    shopKey:args.shopKey,shopName:name.rows[0].shop_name,period,
    selection:orderNos?{orderNos,scope:'selected_orders'}:{scope:'full_month'},
    summary:{fallbackOrders:rows.length,fallbackFreightAmount:freightTotal.toFixed(2),
      byOwnerScope:roundedGroups(byOwnerScope),byPrimaryReason:roundedGroups(byPrimaryReason),
      byIssue:roundedGroups(byIssue)},
    topOrders:normalized.slice(0,limit),returnedTopOrders:Math.min(limit,normalized.length),
    priorityOrders:normalized.filter(row=>row.ownerScope==='multiple_operators'||
      row.ownerScope==='operator_and_unassigned').slice(0,limit),
    sorting:'absolute_freight_amount_desc_then_order_no',
    note:'多个缺口原因可能出现在同一订单；byIssue 可重叠，byPrimaryReason 互斥。负责人按订单支付日已批准的商品归属判断。'};
}
