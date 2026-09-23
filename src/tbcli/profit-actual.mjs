import {getProfitOrderCoverage} from './profit-orders.mjs';
import {getProfitRefundCoverage} from './profit-refunds.mjs';

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;
export const ACTUAL_PROFIT_POLICY = Object.freeze({
  version: 'operating-profit-v1',
  platformFeeRate: 0.06,
  taxRate: 0.02,
  missingFreightPerWaybill: 2,
  revenueBasis: 'order_header_paid',
  ownerOptionalProducts: Object.freeze({
    '2821074747423457561': Object.freeze({type:'delisted_product',ownerRequired:false}),
    '2825068038544425323': Object.freeze({type:'delisted_product',ownerRequired:false}),
    '2825699043848487166': Object.freeze({type:'delisted_product',ownerRequired:false}),
    '2830808569970950560': Object.freeze({type:'delisted_product',ownerRequired:false}),
  }),
  nonMerchandiseProducts: Object.freeze({
    '641773251256': Object.freeze({type:'price_adjustment_link',ownerRequired:false,costState:'explicit_zero'}),
  }),
});

function integer(value) { return Number(value || 0); }
function decimal(value) { return value == null ? null : String(value); }
function rowNumbers(row, integerKeys = []) {
  const integerSet = new Set(integerKeys);
  return Object.fromEntries(Object.entries(row || {}).map(([key, value]) => [key, integerSet.has(key) ? integer(value) : value]));
}

export function actualProfitPeriod(month) {
  const match = String(month || '').match(MONTH);
  if (!match) throw new Error('--month 必须是有效的 YYYY-MM');
  const year = Number(match[1]);
  const monthIndex = Number(match[2]);
  const startDate = `${match[1]}-${match[2]}-01`;
  const endDate = new Date(Date.UTC(year, monthIndex, 0)).toISOString().slice(0, 10);
  const nextMonth = new Date(Date.UTC(year, monthIndex, 1));
  const cutoffDate = `${nextMonth.getUTCFullYear()}-${String(nextMonth.getUTCMonth() + 1).padStart(2, '0')}-15`;
  return {month, startDate, endDate, refundCutoffDate: cutoffDate, refundCutoff: `${cutoffDate}T23:59:59+08:00`};
}

export function validateActualCoverageRequest(args = {}) {
  if (!args.shopKey) throw new Error('缺少 --shop-key');
  const period = actualProfitPeriod(args.month);
  if (args.policyVersion != null && !String(args.policyVersion).trim()) throw new Error('--policy-version 不能为空');
  if (args.policyVersion && String(args.policyVersion).trim() !== ACTUAL_PROFIT_POLICY.version) {
    throw new Error(`--policy-version 当前仅支持 ${ACTUAL_PROFIT_POLICY.version}`);
  }
  return {...period, policyVersion: ACTUAL_PROFIT_POLICY.version};
}

const ORDER_SCOPE_SQL = `
  WITH scoped AS MATERIALIZED (
    SELECT wdt_trade_no,paid_amount FROM raw.wdt_order_headers
    WHERE shop_key=$1 AND order_status_code=95
      AND (paid_at AT TIME ZONE 'Asia/Shanghai')::date BETWEEN $2::date AND $3::date
  )
  SELECT (SELECT count(*)::bigint FROM scoped) AS eligible_orders,
    (SELECT count(*)::bigint FROM raw.wdt_order_lines l JOIN scoped s USING(wdt_trade_no) WHERE l.shop_key=$1) AS order_lines,
    (SELECT count(*)::bigint FROM raw.shipments x JOIN scoped s USING(wdt_trade_no) WHERE x.shop_key=$1) AS shipments,
    (SELECT round(coalesce(sum(paid_amount),0),2)::text FROM scoped) AS paid_amount,
    (SELECT round(coalesce(sum(coalesce(l.source_share_amount,l.source_line_paid,0)),0),2)::text
       FROM raw.wdt_order_lines l JOIN scoped s USING(wdt_trade_no) WHERE l.shop_key=$1) AS allocated_line_revenue`;

const REFUND_SQL = `
  WITH scoped_orders AS MATERIALIZED (
    SELECT wdt_trade_no,platform_trade_id FROM raw.wdt_order_headers
    WHERE shop_key=$1 AND order_status_code=95
      AND (paid_at AT TIME ZONE 'Asia/Shanghai')::date BETWEEN $2::date AND $3::date
  ), scoped_refunds AS MATERIALIZED (
    SELECT h.*,o.platform_trade_id AS original_platform_trade_id
    FROM raw.wdt_refund_headers h JOIN scoped_orders o USING(wdt_trade_no)
    WHERE h.shop_key=$1 AND h.is_financially_refunded AND h.settled_at <= $4::timestamptz
  ), scoped_lines AS MATERIALIZED (
    SELECT l.*,h.wdt_trade_no,h.original_platform_trade_id
    FROM raw.wdt_refund_lines l JOIN scoped_refunds h USING(shop_key,refund_no)
  ), order_lookup AS MATERIALIZED (
    SELECT order_line_key,wdt_order_line_id,source_order_line_id,wdt_trade_no
    FROM raw.wdt_order_lines WHERE shop_key=$1
  ), order_by_id AS MATERIALIZED (
    SELECT DISTINCT ON (wdt_order_line_id) order_line_key,wdt_order_line_id
    FROM order_lookup WHERE wdt_order_line_id IS NOT NULL
    ORDER BY wdt_order_line_id,order_line_key
  ), order_by_source AS MATERIALIZED (
    SELECT DISTINCT ON (wdt_trade_no,source_order_line_id) order_line_key,wdt_trade_no,source_order_line_id
    FROM order_lookup WHERE source_order_line_id IS NOT NULL
    ORDER BY wdt_trade_no,source_order_line_id,order_line_key
  ), classified_lines AS MATERIALIZED (
    SELECT l.*,(oi.order_line_key IS NOT NULL OR os.order_line_key IS NOT NULL) AS is_mapped
    FROM scoped_lines l
    LEFT JOIN order_by_id oi ON oi.wdt_order_line_id=l.wdt_order_line_id
    LEFT JOIN order_by_source os ON os.wdt_trade_no=l.wdt_trade_no AND os.source_order_line_id=l.source_order_line_id
  )
  SELECT (SELECT count(*)::bigint FROM scoped_refunds) AS settled_refunds,
    (SELECT round(coalesce(sum(coalesce(actual_refund_amount,refunded_amount,return_amount,0)),0),2)::text FROM scoped_refunds) AS header_refund_amount,
    count(*)::bigint AS refund_lines,
    round(coalesce(sum(coalesce(actual_refund_amount,refunded_amount,refund_amount,0)),0),2)::text AS line_refund_amount,
    0::bigint AS unmatched_refund_headers,
    count(*) FILTER(WHERE NOT is_mapped)::bigint AS unmapped_refund_lines,
    round(coalesce(sum(coalesce(actual_refund_amount,refunded_amount,refund_amount,0)) FILTER(WHERE NOT is_mapped),0),2)::text AS unmapped_refund_amount,
    coalesce(jsonb_agg(jsonb_build_object(
      'refundNo',l.refund_no,'wdtTradeNo',l.wdt_trade_no,'platformTradeId',l.original_platform_trade_id,
      'refundLineKey',l.refund_line_key,'wdtOrderLineId',l.wdt_order_line_id,
      'sourceOrderLineId',l.source_order_line_id,'platformProductId',l.platform_product_id,
      'platformSkuId',l.platform_sku_id,'erpSpecNo',l.erp_spec_no,
      'refundAmount',coalesce(l.actual_refund_amount,l.refunded_amount,l.refund_amount,0))
      ORDER BY l.refund_no,l.refund_line_key) FILTER(WHERE NOT is_mapped),'[]'::jsonb) AS unmapped_refund_details
  FROM classified_lines l`;

const FREIGHT_SQL = `
  WITH scoped AS MATERIALIZED (
    SELECT s.tracking_no,max(s.carrier_raw_name) AS source_carrier,
      count(DISTINCT s.wdt_trade_no)::bigint AS order_count
    FROM raw.shipments s JOIN raw.wdt_order_headers h USING(shop_key,wdt_trade_no)
    WHERE h.shop_key=$1 AND h.order_status_code=95
      AND (h.paid_at AT TIME ZONE 'Asia/Shanghai')::date BETWEEN $2::date AND $3::date
      AND nullif(trim(s.tracking_no),'') IS NOT NULL
    GROUP BY s.tracking_no
  ), charges AS MATERIALIZED (
    SELECT tracking_no,count(*)::bigint AS detail_count,count(DISTINCT carrier)::integer AS carrier_count,
      string_agg(DISTINCT carrier,',' ORDER BY carrier) AS bill_carriers,
      string_agg(DISTINCT bill_month,',' ORDER BY bill_month) AS bill_months,
      round(sum(charge_amount),2)::text AS charge_amount
    FROM raw.courier_bill_charges WHERE tracking_no IN (SELECT tracking_no FROM scoped) GROUP BY tracking_no
  ), joined AS MATERIALIZED (
    SELECT s.*,c.tracking_no AS matched_tracking_no,c.detail_count,c.carrier_count,c.bill_carriers,c.bill_months,c.charge_amount
    FROM scoped s LEFT JOIN charges c USING(tracking_no)
  )
  SELECT count(*)::bigint AS shipment_waybills,
    count(*) FILTER(WHERE matched_tracking_no IS NOT NULL)::bigint AS matched_waybills,
    count(*) FILTER(WHERE matched_tracking_no IS NULL)::bigint AS unmatched_waybills,
    count(*) FILTER(WHERE order_count>1)::bigint AS shared_tracking_waybills,
    count(*) FILTER(WHERE detail_count>1)::bigint AS multi_charge_waybills,
    count(*) FILTER(WHERE carrier_count>1)::bigint AS multi_carrier_waybills,
    round(coalesce(sum(charge_amount::numeric),0),2)::text AS matched_charge_amount,
    string_agg(DISTINCT bill_months,',' ORDER BY bill_months) FILTER(WHERE bill_months IS NOT NULL) AS matched_bill_months,
    (SELECT coalesce(jsonb_agg(x ORDER BY x->>'source_carrier'),'[]'::jsonb) FROM (
      SELECT jsonb_build_object('source_carrier',coalesce(source_carrier,'未知快递'),
        'waybills',count(*),'matched_waybills',count(*) FILTER(WHERE matched_tracking_no IS NOT NULL),
        'unmatched_waybills',count(*) FILTER(WHERE matched_tracking_no IS NULL),
        'matched_charge_amount',round(coalesce(sum(charge_amount::numeric),0),2)::text) AS x
      FROM joined GROUP BY source_carrier
    ) carrier_groups) AS by_source_carrier
  FROM joined`;

const COST_SQL = `
  WITH lines AS MATERIALIZED (
    SELECT (h.paid_at AT TIME ZONE 'Asia/Shanghai')::date AS paid_date,l.*
    FROM raw.wdt_order_headers h JOIN raw.wdt_order_lines l USING(shop_key,wdt_trade_no)
    WHERE h.shop_key=$1 AND h.order_status_code=95
      AND (h.paid_at AT TIME ZONE 'Asia/Shanghai')::date BETWEEN $2::date AND $3::date
  ), classified AS (
    SELECT l.*,m.unit_cost,
      CASE WHEN l.platform_product_id=ANY($4::text[]) THEN 'explicit_zero'
           WHEN l.source_goods_cost IS NOT NULL THEN 'actual'
           WHEN m.unit_cost IS NOT NULL THEN 'standard_reference' ELSE 'missing' END AS value_state
    FROM lines l LEFT JOIN LATERAL (
      SELECT unit_cost FROM master.sku_cost_versions m WHERE m.shop_key=$1
        AND m.erp_spec_no=l.erp_spec_no AND m.status='approved'
        AND l.paid_date>=m.effective_from AND (m.effective_to IS NULL OR l.paid_date<=m.effective_to)
      ORDER BY m.effective_from DESC LIMIT 1
    ) m ON true
  )
  SELECT count(*)::bigint AS lines,
    count(*) FILTER(WHERE value_state='actual')::bigint AS actual_lines,
    count(*) FILTER(WHERE value_state='standard_reference')::bigint AS standard_reference_lines,
    count(*) FILTER(WHERE value_state='explicit_zero')::bigint AS explicit_zero_lines,
    count(*) FILTER(WHERE value_state='missing')::bigint AS missing_lines,
    round(coalesce(sum(coalesce(source_share_amount,source_line_paid,0)) FILTER(WHERE value_state='missing'),0),2)::text AS missing_revenue,
    round(coalesce(sum(CASE WHEN value_state='actual' THEN source_goods_cost
      WHEN value_state='standard_reference' THEN unit_cost*coalesce(quantity,0) END),0),2)::text AS covered_cost,
    (SELECT coalesce(jsonb_agg(x ORDER BY x->>'erpSpecNo',x->>'platformSkuId'),'[]'::jsonb) FROM (
      SELECT jsonb_build_object('erpSpecNo',erp_spec_no,'erpGoodsNo',max(erp_goods_no),
        'platformProductId',max(platform_product_id),'platformSkuId',max(platform_sku_id),
        'productName',max(product_name),'skuName',max(sku_name),'lineCount',count(*),
        'quantity',round(coalesce(sum(quantity),0),2)::text,
        'affectedRevenue',round(coalesce(sum(coalesce(source_share_amount,source_line_paid,0)),0),2)::text) AS x
      FROM classified WHERE value_state='missing'
      GROUP BY erp_spec_no,platform_sku_id
    ) missing_groups) AS missing_items
  FROM classified`;

const OWNER_SQL = `
  WITH lines AS MATERIALIZED (
    SELECT (h.paid_at AT TIME ZONE 'Asia/Shanghai')::date AS paid_date,h.wdt_trade_no,
      l.platform_product_id,l.platform_sku_id,l.erp_goods_no,l.erp_spec_no,l.product_name,l.sku_name,
      l.quantity,l.source_share_amount,l.source_line_paid,l.source_line
    FROM raw.wdt_order_headers h JOIN raw.wdt_order_lines l USING(shop_key,wdt_trade_no)
    WHERE h.shop_key=$1 AND h.order_status_code=95
      AND (h.paid_at AT TIME ZONE 'Asia/Shanghai')::date BETWEEN $2::date AND $3::date
      AND l.platform_product_id IS NOT NULL
  ), products AS MATERIALIZED (
    SELECT DISTINCT paid_date,platform_product_id FROM lines
  ), assigned AS (
    SELECT p.*,o.owner_name FROM products p LEFT JOIN LATERAL (
      SELECT owner_name FROM master.product_owner_versions o WHERE o.shop_key=$1
        AND o.platform_product_id=p.platform_product_id AND o.status='approved'
        AND p.paid_date>=o.effective_from AND (o.effective_to IS NULL OR p.paid_date<=o.effective_to)
      ORDER BY o.effective_from DESC LIMIT 1
    ) o ON true
  ), missing_ids AS MATERIALIZED (
    SELECT DISTINCT platform_product_id FROM assigned
    WHERE nullif(trim(owner_name),'') IS NULL OR owner_name IN ('未分配','未分配负责人')
  ), detail_rows AS MATERIALIZED (
    SELECT l.platform_product_id,max(l.product_name) AS product_name,
      count(*)::bigint AS line_count,count(DISTINCT l.wdt_trade_no)::bigint AS order_count,
      round(coalesce(sum(l.quantity),0),2)::text AS quantity,
      round(coalesce(sum(coalesce(l.source_share_amount,l.source_line_paid,0)),0),2)::text AS line_revenue,
      array_remove(array_agg(DISTINCT l.platform_sku_id ORDER BY l.platform_sku_id),NULL) AS platform_sku_ids,
      array_remove(array_agg(DISTINCT l.erp_goods_no ORDER BY l.erp_goods_no),NULL) AS erp_goods_nos,
      array_remove(array_agg(DISTINCT l.erp_spec_no ORDER BY l.erp_spec_no),NULL) AS erp_spec_nos,
      array_remove(array_agg(DISTINCT l.sku_name ORDER BY l.sku_name),NULL) AS sku_names,
      max(i.image_url) AS source_image_url
    FROM lines l JOIN missing_ids m USING(platform_product_id)
    LEFT JOIN master.product_image_mappings i USING(platform_product_id)
    GROUP BY l.platform_product_id
  )
  SELECT count(*)::bigint AS product_days,
    count(*) FILTER(WHERE nullif(trim(owner_name),'') IS NOT NULL AND owner_name NOT IN ('未分配','未分配负责人'))::bigint AS assigned_product_days,
    count(*) FILTER(WHERE nullif(trim(owner_name),'') IS NULL OR owner_name IN ('未分配','未分配负责人'))::bigint AS unassigned_product_days,
    count(DISTINCT platform_product_id) FILTER(WHERE nullif(trim(owner_name),'') IS NULL OR owner_name IN ('未分配','未分配负责人'))::bigint AS unassigned_products,
    count(DISTINCT platform_product_id) FILTER(WHERE (nullif(trim(owner_name),'') IS NULL OR owner_name IN ('未分配','未分配负责人')) AND NOT(platform_product_id=ANY($4::text[])))::bigint AS review_unassigned_products,
    count(DISTINCT platform_product_id) FILTER(WHERE (nullif(trim(owner_name),'') IS NULL OR owner_name IN ('未分配','未分配负责人')) AND platform_product_id=ANY($4::text[]))::bigint AS intentional_unassigned_products,
    array_agg(DISTINCT platform_product_id ORDER BY platform_product_id) FILTER(
      WHERE nullif(trim(owner_name),'') IS NULL OR owner_name IN ('未分配','未分配负责人')) AS unassigned_product_ids,
    (SELECT coalesce(jsonb_agg(jsonb_build_object(
      'platformProductId',d.platform_product_id,'productName',d.product_name,
      'classification',CASE WHEN d.platform_product_id=ANY($5::text[]) THEN 'price_adjustment_link' WHEN d.platform_product_id=ANY($4::text[]) THEN 'delisted_product' ELSE 'owner_review_required' END,
      'ownerRequired',NOT(d.platform_product_id=ANY($4::text[])),
      'lineCount',d.line_count,'orderCount',d.order_count,'quantity',d.quantity,'lineRevenue',d.line_revenue,
      'platformSkuIds',d.platform_sku_ids,'erpGoodsNos',d.erp_goods_nos,'erpSpecNos',d.erp_spec_nos,
      'skuNames',d.sku_names,'sourceImageUrl',d.source_image_url
    ) ORDER BY d.platform_product_id),'[]'::jsonb) FROM detail_rows d) AS unassigned_product_details
  FROM assigned`;

const ADS_SQL = `
  SELECT count(DISTINCT stat_date)::integer AS covered_days,min(stat_date)::text AS first_date,max(stat_date)::text AS last_date,
    count(*)::bigint AS rows,
    round(coalesce(sum(CASE WHEN replace(coalesce(row_data->>'花费','0'),',','') ~ '^-?[0-9]+(\\.[0-9]+)?$'
      THEN replace(row_data->>'花费',',','')::numeric ELSE 0 END),0),2)::text AS ad_spend
  FROM raw.sycm_rows WHERE dataset_key='wujie-subject' AND shop_name=$3
    AND conversion_cycle='15天转化' AND subject_type='商品' AND stat_date BETWEEN $1::date AND $2::date`;

function addGap(gaps, condition, gap) { if (condition) gaps.push(gap); }

export async function getActualProfitCoverage(client, args = {}) {
  const period = validateActualCoverageRequest(args);
  const params = [args.shopKey, period.startDate, period.endDate, period.refundCutoff];
  const monthParams = params.slice(0, 3);
  const nonMerchandiseProductIds = Object.keys(ACTUAL_PROFIT_POLICY.nonMerchandiseProducts);
  const ownerOptionalProductIds = [...nonMerchandiseProductIds, ...Object.keys(ACTUAL_PROFIT_POLICY.ownerOptionalProducts)];
  const name = await client.query('SELECT shop_name FROM raw.wdt_order_headers WHERE shop_key=$1 ORDER BY observed_at DESC LIMIT 1', [args.shopKey]);
  if (!name.rows.length) throw new Error('没有找到该店铺的订单事实');
  const sourceShopName = name.rows[0].shop_name;
  const adShopName = sourceShopName.replace(/^天猫\s*/, '');
  const ordersCoverage = await getProfitOrderCoverage(client, {shopKey: args.shopKey, startDate: period.startDate, endDate: period.endDate});
  const refundSourceCoverage = await getProfitRefundCoverage(client, {shopKey: args.shopKey, startDate: period.startDate, endDate: period.refundCutoffDate});
  const orderResult = await client.query(ORDER_SCOPE_SQL, monthParams);
  const refundResult = await client.query(REFUND_SQL, params);
  const freightResult = await client.query(FREIGHT_SQL, monthParams);
  const costResult = await client.query(COST_SQL, [...monthParams, nonMerchandiseProductIds]);
  const ownerResult = await client.query(OWNER_SQL, [...monthParams, ownerOptionalProductIds, nonMerchandiseProductIds]);
  const adsResult = await client.query(ADS_SQL, [period.startDate, period.endDate, adShopName]);
  const orderScope = rowNumbers(orderResult.rows[0], ['eligible_orders','order_lines','shipments']);
  orderScope.paid_amount = decimal(orderScope.paid_amount);
  orderScope.allocated_line_revenue = decimal(orderScope.allocated_line_revenue);
  orderScope.line_revenue_difference = (Number(orderScope.allocated_line_revenue || 0) - Number(orderScope.paid_amount || 0)).toFixed(2);
  orderScope.selected_revenue_amount = orderScope.paid_amount;
  orderScope.allocation_weight_amount = orderScope.allocated_line_revenue;
  orderScope.allocation_rule = '订单头 paid_amount 作为收入总额；商品明细 shareAmount/paid 仅作为订单内分配权重，并按订单头实付归一化';
  orderScope.sources = {
    headerAmount:{table:'raw.wdt_order_headers',column:'paid_amount',sourceField:'orders[].paid'},
    lineAmount:{table:'raw.wdt_order_lines',column:'source_share_amount',fallbackColumn:'source_line_paid',sourceFields:['orders[].items[].shareAmount','orders[].items[].paid']},
  };
  const refunds = rowNumbers(refundResult.rows[0], ['settled_refunds','refund_lines','unmatched_refund_headers','unmapped_refund_lines']);
  const freight = rowNumbers(freightResult.rows[0], ['shipment_waybills','matched_waybills','unmatched_waybills','shared_tracking_waybills','multi_charge_waybills','multi_carrier_waybills']);
  freight.estimated_waybills = freight.unmatched_waybills;
  freight.estimated_unit_amount = ACTUAL_PROFIT_POLICY.missingFreightPerWaybill.toFixed(2);
  freight.estimated_freight_amount = (freight.estimated_waybills * ACTUAL_PROFIT_POLICY.missingFreightPerWaybill).toFixed(2);
  freight.total_freight_amount = (Number(freight.matched_charge_amount || 0) + Number(freight.estimated_freight_amount)).toFixed(2);
  freight.value_states = {
    actual:{waybills:freight.matched_waybills,amount:freight.matched_charge_amount},
    estimated:{waybills:freight.estimated_waybills,amount:freight.estimated_freight_amount,rule:'每个未匹配运单 2 元'},
  };
  const costs = rowNumbers(costResult.rows[0], ['lines','actual_lines','standard_reference_lines','explicit_zero_lines','missing_lines']);
  const owners = rowNumbers(ownerResult.rows[0], ['product_days','assigned_product_days','unassigned_product_days','unassigned_products','review_unassigned_products','intentional_unassigned_products']);
  const ads = rowNumbers(adsResult.rows[0], ['covered_days','rows']);
  ads.expected_days = Number(period.endDate.slice(8,10));
  ads.missing_days = Math.max(0, ads.expected_days - ads.covered_days);

  const blockingGaps = [];
  const advisoryGaps = [];
  addGap(blockingGaps, !ordersCoverage.complete, {code:'ORDER_SOURCE_COVERAGE_INCOMPLETE', missingPeriods:ordersCoverage.missingPeriods});
  addGap(blockingGaps, !refundSourceCoverage.complete, {code:'REFUND_SOURCE_COVERAGE_INCOMPLETE', missingPeriods:refundSourceCoverage.missingPeriods});
  addGap(advisoryGaps, Math.abs(Number(orderScope.line_revenue_difference)) > 0.01,
    {code:'ORDER_LINES_USED_AS_ALLOCATION_WEIGHTS', difference:orderScope.line_revenue_difference, selectedRevenue:orderScope.selected_revenue_amount, allocationWeightAmount:orderScope.allocation_weight_amount});
  addGap(blockingGaps, costs.missing_lines > 0, {code:'GOODS_COST_MISSING', count:costs.missing_lines, affectedRevenue:costs.missing_revenue});
  addGap(blockingGaps, ads.missing_days > 0, {code:'AD_DAILY_COVERAGE_INCOMPLETE', count:ads.missing_days});
  addGap(blockingGaps, Math.abs(Number(refunds.header_refund_amount || 0) - Number(refunds.line_refund_amount || 0)) > 0.01,
    {code:'REFUND_LINE_AMOUNT_MISMATCH', headerAmount:refunds.header_refund_amount, lineAmount:refunds.line_refund_amount});
  addGap(advisoryGaps, refunds.unmapped_refund_lines > 0, {code:'REFUND_LINE_UNMAPPED', count:refunds.unmapped_refund_lines, amount:refunds.unmapped_refund_amount});
  addGap(advisoryGaps, freight.estimated_waybills > 0, {code:'FREIGHT_ESTIMATED_BY_CONFIRMED_POLICY', count:freight.estimated_waybills, amount:freight.estimated_freight_amount, unitAmount:freight.estimated_unit_amount});
  addGap(advisoryGaps, freight.shared_tracking_waybills > 0, {code:'TRACKING_SHARED_BY_MULTIPLE_ORDERS', count:freight.shared_tracking_waybills});
  addGap(advisoryGaps, freight.multi_carrier_waybills > 0, {code:'TRACKING_MATCHES_MULTIPLE_CARRIERS', count:freight.multi_carrier_waybills});
  addGap(advisoryGaps, owners.review_unassigned_products > 0, {code:'PRODUCT_OWNER_REVIEW_REQUIRED', productDays:owners.unassigned_product_days, products:owners.review_unassigned_products});
  addGap(advisoryGaps, true, {code:'FREIGHT_ALLOCATED_BY_REVENUE_FALLBACK', reason:'商品重量覆盖未作为利润分摊依据，按订单内归一化收入占比分配'});

  return {
    mode:'live-read-only', calculationPerformed:false, shopKey:args.shopKey, shopName:sourceShopName,
    period, targetState:'actual/reconciled', status:blockingGaps.length ? 'incomplete' : freight.estimated_waybills > 0 ? 'provisional' : 'actual/reconciled',
    coverage:{orders:ordersCoverage, refundSource:{...refundSourceCoverage,dateBasis:'退款申请日批次覆盖；退款金额另按原支付月订单与结算截止时间核对'}, orderScope, refunds, freight, costs, owners, ads,
      policy:{...ACTUAL_PROFIT_POLICY,status:'confirmed'}, freightWeightAllocation:{status:'revenue_fallback'}},
    blockingGaps, advisoryGaps,
  };
}

const ACTUAL_QUERY_GROUPS = new Set(['shop','owner','product','day','report']);

export function normalizeActualProfitOwners({owner,owners}={}) {
  if (owner && owners) throw new Error('--owner 与 --owners 不能同时使用');
  const raw = owner ? [owner] : String(owners || '').split(/[,，]/);
  const selected = [...new Set(raw.map(value => String(value).trim()).filter(Boolean))];
  if (owners && !selected.length) throw new Error('--owners 至少需要一个负责人姓名');
  return selected;
}

export function validateActualProfitQueryRequest(args = {}) {
  const period = validateActualCoverageRequest(args);
  const groupBy = args.groupBy || 'shop';
  if (!ACTUAL_QUERY_GROUPS.has(groupBy)) throw new Error('--group-by 仅支持 shop|owner|product|day|report');
  return {...period, groupBy, owners:normalizeActualProfitOwners(args)};
}

export function validateActualCostAuditRequest(args = {}) {
  const period = validateActualCoverageRequest(args);
  const productId = String(args.productId || '').trim();
  if (!productId) throw new Error('缺少 --product-id');
  return {...period, productId};
}

const COST_AUDIT_SQL = `
  SELECT (h.paid_at AT TIME ZONE 'Asia/Shanghai')::date::text AS paid_date,
    h.wdt_trade_no,l.order_line_key,l.platform_product_id,l.platform_sku_id,
    l.erp_spec_no,l.product_name,l.sku_name,
    l.quantity::text AS quantity,l.source_goods_cost::text AS source_goods_cost,
    l.source_ref_unit_cost::text AS source_ref_unit_cost,c.unit_cost::text AS master_unit_cost
  FROM raw.wdt_order_headers h JOIN raw.wdt_order_lines l USING(shop_key,wdt_trade_no)
  LEFT JOIN LATERAL (
    SELECT unit_cost FROM master.sku_cost_versions c
    WHERE c.shop_key=$1 AND c.erp_spec_no=l.erp_spec_no AND c.status='approved'
      AND (h.paid_at AT TIME ZONE 'Asia/Shanghai')::date>=c.effective_from
      AND (c.effective_to IS NULL OR (h.paid_at AT TIME ZONE 'Asia/Shanghai')::date<=c.effective_to)
    ORDER BY c.effective_from DESC LIMIT 1
  ) c ON true
  WHERE h.shop_key=$1 AND h.order_status_code=95
    AND (h.paid_at AT TIME ZONE 'Asia/Shanghai')::date BETWEEN $2::date AND $3::date
    AND l.platform_product_id=$4
  ORDER BY paid_date,h.wdt_trade_no,l.order_line_key`;

function auditNumber(value) {
  if (value == null || value === '') return null;
  const result = Number(value);
  if (!Number.isFinite(result)) throw new Error(`无法审计非数字成本：${value}`);
  return result;
}

function auditAmount(value) { return value == null ? null : Number(value.toFixed(4)); }

function costComparison(actual, expected, tolerance = 0.01) {
  if (actual == null || expected == null) return {comparable:false,matches:null,difference:null};
  const difference = auditAmount(actual - expected);
  return {comparable:true,matches:Math.abs(difference) <= tolerance,difference};
}

function sumAvailable(rows, key) {
  const values = rows.map(row => row[key]).filter(value => value != null);
  return values.length ? auditAmount(values.reduce((sum, value) => sum + value, 0)) : null;
}

function comparisonSummary(rows, key) {
  const comparisons = rows.map(row => row[key]);
  const comparable = comparisons.filter(item => item.comparable);
  const mismatches = comparable.filter(item => !item.matches);
  return {
    comparableLineCount: comparable.length,
    matchLineCount: comparable.length - mismatches.length,
    mismatchLineCount: mismatches.length,
    unavailableLineCount: comparisons.length - comparable.length,
    absoluteDifferenceTotal: auditAmount(mismatches.reduce((sum, item) => sum + Math.abs(item.difference), 0)),
    maximumAbsoluteDifference: auditAmount(mismatches.reduce((max, item) => Math.max(max, Math.abs(item.difference)), 0)),
  };
}

export async function getActualCostAudit(client,args={}) {
  const request = validateActualCostAuditRequest(args);
  const shop = await client.query('SELECT shop_name FROM raw.wdt_order_headers WHERE shop_key=$1 ORDER BY observed_at DESC LIMIT 1',[args.shopKey]);
  if (!shop.rows.length) throw new Error('没有找到该店铺的订单事实');
  const sourceRows = (await client.query(COST_AUDIT_SQL,[args.shopKey,request.startDate,request.endDate,request.productId])).rows;
  const rows = sourceRows.map(row => {
    const quantity = auditNumber(row.quantity) ?? 0;
    const sourceGoodsCost = auditNumber(row.source_goods_cost);
    const sourceRefUnitCost = auditNumber(row.source_ref_unit_cost);
    const masterUnitCost = auditNumber(row.master_unit_cost);
    const sourceRefCalculatedCost = sourceRefUnitCost == null ? null : auditAmount(sourceRefUnitCost * quantity);
    const masterCalculatedCost = masterUnitCost == null ? null : auditAmount(masterUnitCost * quantity);
    return {
      paidDate:row.paid_date,wdtTradeNo:row.wdt_trade_no,orderLineKey:row.order_line_key,
      platformProductId:row.platform_product_id,platformSkuId:row.platform_sku_id,erpSpecNo:row.erp_spec_no,
      productName:row.product_name,skuName:row.sku_name,quantity:auditAmount(quantity),
      sourceGoodsCost:auditAmount(sourceGoodsCost),sourceRefUnitCost:auditAmount(sourceRefUnitCost),
      sourceRefCalculatedCost,masterUnitCost:auditAmount(masterUnitCost),masterCalculatedCost,
      goodsVsSourceRef:costComparison(sourceGoodsCost,sourceRefCalculatedCost),
      goodsVsMaster:costComparison(sourceGoodsCost,masterCalculatedCost),
      sourceRefVsMaster:costComparison(sourceRefCalculatedCost,masterCalculatedCost),
    };
  });
  const goodsVsSourceRef = comparisonSummary(rows,'goodsVsSourceRef');
  const goodsVsMaster = comparisonSummary(rows,'goodsVsMaster');
  const sourceRefVsMaster = comparisonSummary(rows,'sourceRefVsMaster');
  return {
    mode:'live-read-only',calculationPerformed:false,audit:'goods-cost-consistency',tolerance:'0.01',
    shopKey:args.shopKey,shopName:shop.rows[0].shop_name,period:request,productId:request.productId,
    summary:{
      lineCount:rows.length,orderCount:new Set(rows.map(row=>row.wdtTradeNo)).size,
      skuCount:new Set(rows.map(row=>row.erpSpecNo || row.platformSkuId).filter(Boolean)).size,
      quantityTotal:auditAmount(rows.reduce((sum,row)=>sum+(row.quantity||0),0)),
      sourceGoodsCostTotal:sumAvailable(rows,'sourceGoodsCost'),
      sourceRefCalculatedCostTotal:sumAvailable(rows,'sourceRefCalculatedCost'),
      masterCalculatedCostTotal:sumAvailable(rows,'masterCalculatedCost'),
      goodsVsSourceRef,goodsVsMaster,sourceRefVsMaster,
      allComparableCostsMatch:goodsVsSourceRef.mismatchLineCount===0&&goodsVsMaster.mismatchLineCount===0&&sourceRefVsMaster.mismatchLineCount===0,
      fullyComparable:goodsVsSourceRef.unavailableLineCount===0&&goodsVsMaster.unavailableLineCount===0&&sourceRefVsMaster.unavailableLineCount===0,
    },
    rows,
  };
}

function actualProfitGroupSql(groupBy) {
  if (groupBy === 'report') return {
    select:`CASE WHEN grouping(platform_product_id)=0 THEN 'product' WHEN grouping(owner_name)=0 THEN 'owner' ELSE 'shop' END AS level,
      CASE WHEN grouping(platform_product_id)=0 THEN (array_agg(owner_name ORDER BY stat_date DESC) FILTER(WHERE owner_name IS NOT NULL))[1]
           WHEN grouping(owner_name)=0 THEN owner_name END AS owner_name,
      CASE WHEN grouping(platform_product_id)=0 THEN platform_product_id END AS platform_product_id,
      CASE WHEN grouping(platform_product_id)=0 THEN (array_agg(product_name ORDER BY stat_date DESC) FILTER(WHERE product_name IS NOT NULL))[1] END AS product_name,
      CASE WHEN grouping(platform_product_id)=0 THEN max(product_image_url) END AS product_image_url`,
    group:`GROUP BY GROUPING SETS ((),(owner_name),(platform_product_id))`,
    order:`ORDER BY level,actual_profit,owner_name,platform_product_id`,
  };
  const groups = {
    shop:{select:`'shop' AS level`,group:'',order:'ORDER BY actual_profit DESC'},
    owner:{select:`'owner' AS level,owner_name`,group:'GROUP BY owner_name',order:'ORDER BY actual_profit,owner_name'},
    product:{select:`'product' AS level,platform_product_id,(array_agg(product_name ORDER BY stat_date DESC) FILTER(WHERE product_name IS NOT NULL))[1] AS product_name,(array_agg(owner_name ORDER BY stat_date DESC) FILTER(WHERE owner_name IS NOT NULL))[1] AS owner_name,max(product_image_url) AS product_image_url`,group:'GROUP BY platform_product_id',order:'ORDER BY actual_profit,platform_product_id'},
    day:{select:`'day' AS level,stat_date::text AS stat_date`,group:'GROUP BY stat_date',order:'ORDER BY stat_date'},
  };
  return groups[groupBy];
}

export function buildActualProfitQuery(groupBy='shop') {
  if (!ACTUAL_QUERY_GROUPS.has(groupBy)) throw new Error('--group-by 仅支持 shop|owner|product|day|report');
  const group = actualProfitGroupSql(groupBy);
  const precision = groupBy==='report' ? 4 : 2;
  return `WITH scoped_orders AS MATERIALIZED (
    SELECT wdt_trade_no,(paid_at AT TIME ZONE 'Asia/Shanghai')::date AS paid_date,paid_amount
    FROM raw.wdt_order_headers
    WHERE shop_key=$1 AND order_status_code=95
      AND (paid_at AT TIME ZONE 'Asia/Shanghai')::date BETWEEN $2::date AND $3::date
  ), raw_lines AS MATERIALIZED (
    SELECT o.paid_date,o.paid_amount,l.order_line_key,l.wdt_order_line_id,l.source_order_line_id,l.wdt_trade_no,
      l.platform_product_id,l.platform_sku_id,l.erp_spec_no,coalesce(i.product_title,l.product_name) AS product_name,l.sku_name,
      i.image_url AS product_image_url,
      coalesce(l.quantity,0) AS quantity,coalesce(l.source_share_amount,l.source_line_paid,0) AS allocation_weight,
      l.source_goods_cost
    FROM scoped_orders o JOIN raw.wdt_order_lines l USING(wdt_trade_no)
    LEFT JOIN master.product_image_mappings i USING(platform_product_id)
    WHERE l.shop_key=$1
  ), weighted_lines AS MATERIALIZED (
    SELECT l.*,sum(allocation_weight) OVER(PARTITION BY wdt_trade_no) AS order_weight,
      count(*) OVER(PARTITION BY wdt_trade_no) AS order_line_count
    FROM raw_lines l
  ), valued_lines AS MATERIALIZED (
    SELECT l.*,
      CASE WHEN order_weight<>0 THEN paid_amount*allocation_weight/order_weight ELSE paid_amount/order_line_count END AS line_revenue,
      CASE WHEN platform_product_id=ANY($9::text[]) THEN 0
           WHEN source_goods_cost IS NOT NULL THEN source_goods_cost
           WHEN c.unit_cost IS NOT NULL THEN c.unit_cost*quantity END AS goods_cost,
      CASE WHEN platform_product_id=ANY($9::text[]) THEN 'explicit_zero'
           WHEN source_goods_cost IS NOT NULL THEN 'actual'
           WHEN c.unit_cost IS NOT NULL THEN 'standard_reference' ELSE 'missing' END AS cost_state
    FROM weighted_lines l LEFT JOIN LATERAL (
      SELECT unit_cost FROM master.sku_cost_versions c WHERE c.shop_key=$1 AND c.erp_spec_no=l.erp_spec_no
        AND c.status='approved' AND l.paid_date>=c.effective_from
        AND (c.effective_to IS NULL OR l.paid_date<=c.effective_to)
      ORDER BY c.effective_from DESC LIMIT 1
    ) c ON true
  ), scoped_tracking AS MATERIALIZED (
    SELECT DISTINCT s.wdt_trade_no,s.tracking_no
    FROM raw.shipments s JOIN scoped_orders o USING(wdt_trade_no)
    WHERE s.shop_key=$1 AND nullif(trim(s.tracking_no),'') IS NOT NULL
  ), tracking_order_counts AS MATERIALIZED (
    SELECT tracking_no,count(DISTINCT wdt_trade_no)::numeric AS order_count FROM scoped_tracking GROUP BY tracking_no
  ), tracking_charges AS MATERIALIZED (
    SELECT tracking_no,round(sum(charge_amount),2) AS charge_amount FROM raw.courier_bill_charges
    WHERE tracking_no IN (SELECT tracking_no FROM scoped_tracking) GROUP BY tracking_no
  ), order_freight AS MATERIALIZED (
    SELECT t.wdt_trade_no,
      sum(coalesce(c.charge_amount,$8::numeric)/n.order_count) AS freight_cost,
      sum(CASE WHEN c.tracking_no IS NOT NULL THEN c.charge_amount/n.order_count ELSE 0 END) AS actual_freight,
      sum(CASE WHEN c.tracking_no IS NULL THEN $8::numeric/n.order_count ELSE 0 END) AS estimated_freight
    FROM scoped_tracking t JOIN tracking_order_counts n USING(tracking_no)
    LEFT JOIN tracking_charges c USING(tracking_no) GROUP BY t.wdt_trade_no
  ), freight_targets AS MATERIALIZED (
    SELECT sum(CASE WHEN c.tracking_no IS NOT NULL THEN c.charge_amount ELSE 0 END) AS actual_freight,
      sum(CASE WHEN c.tracking_no IS NULL THEN $8::numeric ELSE 0 END) AS estimated_freight
    FROM (SELECT DISTINCT tracking_no FROM scoped_tracking) t LEFT JOIN tracking_charges c USING(tracking_no)
  ), line_facts_raw AS MATERIALIZED (
    SELECT l.*,
      CASE WHEN l.paid_amount<>0 THEN coalesce(f.freight_cost,0)*l.line_revenue/l.paid_amount ELSE coalesce(f.freight_cost,0)/l.order_line_count END AS raw_freight_cost,
      CASE WHEN l.paid_amount<>0 THEN coalesce(f.actual_freight,0)*l.line_revenue/l.paid_amount ELSE coalesce(f.actual_freight,0)/l.order_line_count END AS raw_actual_freight,
      CASE WHEN l.paid_amount<>0 THEN coalesce(f.estimated_freight,0)*l.line_revenue/l.paid_amount ELSE coalesce(f.estimated_freight,0)/l.order_line_count END AS raw_estimated_freight
    FROM valued_lines l LEFT JOIN order_freight f USING(wdt_trade_no)
  ), freight_allocated AS MATERIALIZED (
    SELECT sum(raw_actual_freight) AS actual_freight,sum(raw_estimated_freight) AS estimated_freight FROM line_facts_raw
  ), line_facts AS MATERIALIZED (
    SELECT l.*,
      CASE WHEN a.actual_freight=0 THEN 0 ELSE l.raw_actual_freight*t.actual_freight/a.actual_freight END AS actual_freight,
      CASE WHEN a.estimated_freight=0 THEN 0 ELSE l.raw_estimated_freight*t.estimated_freight/a.estimated_freight END AS estimated_freight,
      (CASE WHEN a.actual_freight=0 THEN 0 ELSE l.raw_actual_freight*t.actual_freight/a.actual_freight END)
        +(CASE WHEN a.estimated_freight=0 THEN 0 ELSE l.raw_estimated_freight*t.estimated_freight/a.estimated_freight END) AS freight_cost
    FROM line_facts_raw l CROSS JOIN freight_targets t CROSS JOIN freight_allocated a
  ), sales AS MATERIALIZED (
    SELECT paid_date AS stat_date,coalesce(platform_product_id,'__UNMAPPED_ORDER_LINE__') AS platform_product_id,
      max(coalesce(product_name,'无法归属商品的订单明细')) AS product_name,
      max(product_image_url) AS product_image_url,
      sum(line_revenue) AS gross_revenue,sum(goods_cost) AS goods_cost,sum(freight_cost) AS freight_cost,
      sum(actual_freight) AS actual_freight,sum(estimated_freight) AS estimated_freight,
      sum(goods_cost) FILTER(WHERE cost_state='actual') AS actual_cost,
      sum(goods_cost) FILTER(WHERE cost_state='standard_reference') AS reference_cost,
      sum(goods_cost) FILTER(WHERE cost_state='explicit_zero') AS explicit_zero_cost,
      count(DISTINCT wdt_trade_no)::bigint AS order_count,sum(quantity) AS quantity
    FROM line_facts GROUP BY paid_date,coalesce(platform_product_id,'__UNMAPPED_ORDER_LINE__')
  ), scoped_refund_headers AS MATERIALIZED (
    SELECT h.shop_key,h.refund_no,h.wdt_trade_no,o.paid_date
    FROM raw.wdt_refund_headers h JOIN scoped_orders o USING(wdt_trade_no)
    WHERE h.shop_key=$1 AND h.is_financially_refunded AND h.settled_at<=$4::timestamptz
  ), order_by_id AS MATERIALIZED (
    SELECT DISTINCT ON (wdt_order_line_id) wdt_order_line_id,platform_product_id,product_name
    FROM raw_lines WHERE wdt_order_line_id IS NOT NULL ORDER BY wdt_order_line_id,order_line_key
  ), order_by_source AS MATERIALIZED (
    SELECT DISTINCT ON (wdt_trade_no,source_order_line_id) wdt_trade_no,source_order_line_id,platform_product_id,product_name
    FROM raw_lines WHERE source_order_line_id IS NOT NULL ORDER BY wdt_trade_no,source_order_line_id,order_line_key
  ), refund_facts AS MATERIALIZED (
    SELECT h.paid_date,
      CASE WHEN oi.wdt_order_line_id IS NOT NULL THEN coalesce(oi.platform_product_id,'__UNMAPPED_REFUND__')
           WHEN os.source_order_line_id IS NOT NULL THEN coalesce(os.platform_product_id,'__UNMAPPED_REFUND__')
           ELSE '__UNMAPPED_REFUND__' END AS platform_product_id,
      CASE WHEN oi.wdt_order_line_id IS NOT NULL THEN coalesce(oi.product_name,'无法归属商品的退款')
           WHEN os.source_order_line_id IS NOT NULL THEN coalesce(os.product_name,'无法归属商品的退款')
           ELSE '无法归属商品的退款' END AS product_name,
      coalesce(l.actual_refund_amount,l.refunded_amount,l.refund_amount,0) AS refund_amount
    FROM scoped_refund_headers h JOIN raw.wdt_refund_lines l USING(shop_key,refund_no)
    LEFT JOIN order_by_id oi ON oi.wdt_order_line_id=l.wdt_order_line_id
    LEFT JOIN order_by_source os ON os.wdt_trade_no=h.wdt_trade_no AND os.source_order_line_id=l.source_order_line_id
  ), refunds AS MATERIALIZED (
    SELECT paid_date AS stat_date,platform_product_id,max(product_name) AS product_name,sum(refund_amount) AS refund_amount
    FROM refund_facts GROUP BY paid_date,platform_product_id
  ), ads AS MATERIALIZED (
    SELECT stat_date,subject_id AS platform_product_id,max(subject_name) AS product_name,
      sum(CASE WHEN replace(coalesce(row_data->>'花费','0'),',','') ~ '^-?[0-9]+(\\.[0-9]+)?$'
        THEN replace(row_data->>'花费',',','')::numeric ELSE 0 END) AS ad_spend
    FROM raw.sycm_rows WHERE dataset_key='wujie-subject' AND shop_name=$5
      AND conversion_cycle='15天转化' AND subject_type='商品' AND stat_date BETWEEN $2::date AND $3::date
    GROUP BY stat_date,subject_id
  ), keys AS MATERIALIZED (
    SELECT stat_date,platform_product_id FROM sales UNION SELECT stat_date,platform_product_id FROM refunds
    UNION SELECT stat_date,platform_product_id FROM ads
  ), joined AS MATERIALIZED (
    SELECT k.stat_date,k.platform_product_id,coalesce(s.product_name,r.product_name,a.product_name,'未知商品') AS product_name,
      s.product_image_url,
      coalesce(s.gross_revenue,0) AS gross_revenue,coalesce(r.refund_amount,0) AS refund_amount,
      coalesce(s.goods_cost,0) AS goods_cost,coalesce(s.freight_cost,0) AS freight_cost,
      coalesce(s.actual_freight,0) AS actual_freight,coalesce(s.estimated_freight,0) AS estimated_freight,
      coalesce(s.actual_cost,0) AS actual_cost,coalesce(s.reference_cost,0) AS reference_cost,
      coalesce(s.explicit_zero_cost,0) AS explicit_zero_cost,coalesce(a.ad_spend,0) AS ad_spend,
      coalesce(s.order_count,0) AS order_count,coalesce(s.quantity,0) AS quantity
    FROM keys k LEFT JOIN sales s USING(stat_date,platform_product_id)
    LEFT JOIN refunds r USING(stat_date,platform_product_id) LEFT JOIN ads a USING(stat_date,platform_product_id)
  ), daily AS MATERIALIZED (
    SELECT j.*,
      CASE WHEN j.platform_product_id IN ('__UNMAPPED_REFUND__','__UNMAPPED_ORDER_LINE__') THEN '无法归属'
           WHEN nullif(trim(o.owner_name),'') IS NOT NULL AND o.owner_name NOT IN ('未分配','未分配负责人') THEN o.owner_name
           WHEN j.platform_product_id=ANY($9::text[]) THEN '不归属负责人'
           WHEN j.platform_product_id=ANY($10::text[]) THEN '已下架未分配'
           ELSE '未分配负责人' END AS owner_name,
      j.gross_revenue-j.refund_amount AS net_sales,
      (j.gross_revenue-j.refund_amount)*$6::numeric AS platform_fee,
      (j.gross_revenue-j.refund_amount)*$7::numeric AS tax_cost,
      (j.gross_revenue-j.refund_amount)-j.goods_cost-j.freight_cost-j.ad_spend
        -(j.gross_revenue-j.refund_amount)*$6::numeric-(j.gross_revenue-j.refund_amount)*$7::numeric AS actual_profit
    FROM joined j LEFT JOIN LATERAL (
      SELECT owner_name FROM master.product_owner_versions o WHERE o.shop_key=$1
        AND o.platform_product_id=j.platform_product_id AND o.status='approved'
        AND j.stat_date>=o.effective_from AND (o.effective_to IS NULL OR j.stat_date<=o.effective_to)
      ORDER BY o.effective_from DESC LIMIT 1
    ) o ON true
  ), filtered AS MATERIALIZED (
    SELECT * FROM daily WHERE cardinality($11::text[])=0 OR owner_name=ANY($11::text[])
  )
  SELECT ${group.select},count(DISTINCT stat_date)::integer AS available_days,
    min(stat_date)::text AS first_date,max(stat_date)::text AS last_date,
    round(sum(gross_revenue),${precision}) AS gross_revenue,round(sum(refund_amount),${precision}) AS refund_amount,
    round(sum(net_sales),${precision}) AS net_sales,round(sum(goods_cost),${precision}) AS goods_cost,
    round(sum(actual_cost),${precision}) AS actual_cost_amount,round(sum(reference_cost),${precision}) AS reference_cost_amount,
    round(sum(explicit_zero_cost),${precision}) AS explicit_zero_cost_amount,
    round(sum(freight_cost),${precision}) AS freight_cost,round(sum(actual_freight),${precision}) AS actual_freight_amount,
    round(sum(estimated_freight),${precision}) AS estimated_freight_amount,round(sum(ad_spend),${precision}) AS ad_spend,
    round(sum(platform_fee),${precision}) AS platform_fee,round(sum(tax_cost),${precision}) AS tax_cost,
    round(sum(actual_profit),${precision}) AS actual_profit,
    CASE WHEN sum(net_sales)=0 THEN NULL ELSE round(sum(actual_profit)/sum(net_sales),4) END AS profit_margin,
    sum(order_count)::bigint AS product_order_count,round(sum(quantity),2) AS quantity,
    round(sum(refund_amount) FILTER(WHERE platform_product_id='__UNMAPPED_REFUND__'),${precision}) AS unmapped_refund_amount
  FROM filtered ${group.group} HAVING count(*)>0 ${group.order}`;
}

const ACTUAL_RECONCILIATION_FIELDS = Object.freeze(['gross_revenue','refund_amount','net_sales','goods_cost','freight_cost','ad_spend','platform_fee','tax_cost','actual_profit']);
function amountUnits(value) {
  const match=String(value??'0').match(/^(-?)(\d+)(?:\.(\d{1,4}))?$/);
  if(!match) throw new Error(`无法回勾金额：${value}`);
  return BigInt(match[1]?'-1':'1')*(BigInt(match[2])*10000n+BigInt((match[3]||'').padEnd(4,'0')));
}
function unitsText(value) {
  const negative=value<0n,absolute=negative?-value:value;
  return `${negative?'-':''}${absolute/10000n}.${String(absolute%10000n).padStart(4,'0')}`;
}
function reconcileSection(shopRow,rows) {
  const differences=Object.fromEntries(ACTUAL_RECONCILIATION_FIELDS.map(field=>{
    const total=rows.reduce((sum,row)=>sum+amountUnits(row[field]),0n);
    return [field,unitsText(total-amountUnits(shopRow[field]))];
  }));
  return {passed:Object.values(differences).every(value=>Math.abs(Number(value))<=0.01),tolerance:'0.01',differences};
}

export async function getActualProfitQuery(client,args={}) {
  const request = validateActualProfitQueryRequest(args);
  const coverage = await getActualProfitCoverage(client,args);
  const adShopName = coverage.shopName.replace(/^天猫\s*/, '');
  const nonMerchandiseProductIds = Object.keys(ACTUAL_PROFIT_POLICY.nonMerchandiseProducts);
  const ownerOptionalProductIds = Object.keys(ACTUAL_PROFIT_POLICY.ownerOptionalProducts);
  const params = [args.shopKey,request.startDate,request.endDate,request.refundCutoff,adShopName,
    ACTUAL_PROFIT_POLICY.platformFeeRate,ACTUAL_PROFIT_POLICY.taxRate,ACTUAL_PROFIT_POLICY.missingFreightPerWaybill,
    nonMerchandiseProductIds,ownerOptionalProductIds,request.owners];
  const rows = (await client.query(buildActualProfitQuery(request.groupBy),params)).rows;
  const sections = request.groupBy==='report' ? {
    shop:rows.filter(row=>row.level==='shop'),owners:rows.filter(row=>row.level==='owner'),products:rows.filter(row=>row.level==='product'),
  } : undefined;
  const reconciliation = sections ? {
    ownerToShop:reconcileSection(sections.shop[0],sections.owners),
    productToShop:reconcileSection(sections.shop[0],sections.products),
  } : undefined;
  return {
    mode:'live-read-only',calculationPerformed:true,shopKey:args.shopKey,shopName:coverage.shopName,
    period:coverage.period,policy:coverage.coverage.policy,status:coverage.status,groupBy:request.groupBy,owners:request.owners,
    quality:{blockingGaps:coverage.blockingGaps,advisoryGaps:coverage.advisoryGaps,
      orderCoverageComplete:coverage.coverage.orders.complete,refundCoverageComplete:coverage.coverage.refundSource.complete,
      missingCostLines:coverage.coverage.costs.missing_lines,estimatedFreightAmount:coverage.coverage.freight.estimated_freight_amount,
      unmappedRefundAmount:coverage.coverage.refunds.unmapped_refund_amount,unassignedOwnerProducts:coverage.coverage.owners.review_unassigned_products},
    ...(sections?{sections,reconciliation}:{rows}),
  };
}
