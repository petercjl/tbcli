import {getProfitOrderCoverage} from './profit-orders.mjs';
import {getProfitRefundCoverage} from './profit-refunds.mjs';

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;
export const ACTUAL_PROFIT_POLICY = Object.freeze({
  version: 'operating-profit-v6',
  costBasis: 'current_approved_sku_cost',
  freightAllocationBasis: 'platform_sku_gross_weight',
  missingWeightFallback: 'order_revenue_share',
  residualPackagingAssumptionKg: 0.2,
  ignoredPlaceholderSpecNo: 'dc99999',
  platformFeeRate: 0.06,
  taxRate: 0.02,
  missingFreightPerWaybill: 2,
  returnResaleRate: 0.5,
  refundCostRule: 'pre_shipment_full_credit_return_refund_resale_rate_credit',
  revenueBasis: 'order_header_real_plus_refund',
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
const REFUND_CREDIT_ACTUAL_PROFIT_POLICY = Object.freeze({...ACTUAL_PROFIT_POLICY,
  version:'operating-profit-v5',revenueBasis:'order_header_paid'});
const WEIGHT_ACTUAL_PROFIT_POLICY = Object.freeze({...REFUND_CREDIT_ACTUAL_PROFIT_POLICY,
  version:'operating-profit-v4',returnResaleRate:null,refundCostRule:null});
const REVENUE_ACTUAL_PROFIT_POLICY = Object.freeze({...ACTUAL_PROFIT_POLICY,
  version:'operating-profit-v3',freightAllocationBasis:'order_revenue_share',
  missingWeightFallback:null,residualPackagingAssumptionKg:null,returnResaleRate:null,refundCostRule:null});
const PREVIOUS_ACTUAL_PROFIT_POLICY = Object.freeze({...REVENUE_ACTUAL_PROFIT_POLICY,
  version:'operating-profit-v2',ignoredPlaceholderSpecNo:null});
const LEGACY_ACTUAL_PROFIT_POLICY = Object.freeze({...PREVIOUS_ACTUAL_PROFIT_POLICY,
  version:'operating-profit-v1',costBasis:'order_goods_cost_then_paid_date_sku_cost'});

function actualPolicy(version) {
  if(version===LEGACY_ACTUAL_PROFIT_POLICY.version) return LEGACY_ACTUAL_PROFIT_POLICY;
  if(version===PREVIOUS_ACTUAL_PROFIT_POLICY.version) return PREVIOUS_ACTUAL_PROFIT_POLICY;
  if(version===REVENUE_ACTUAL_PROFIT_POLICY.version) return REVENUE_ACTUAL_PROFIT_POLICY;
  if(version===WEIGHT_ACTUAL_PROFIT_POLICY.version) return WEIGHT_ACTUAL_PROFIT_POLICY;
  if(version===REFUND_CREDIT_ACTUAL_PROFIT_POLICY.version) return REFUND_CREDIT_ACTUAL_PROFIT_POLICY;
  return ACTUAL_PROFIT_POLICY;
}

function hasReturnCostCredit(version) {
  return [ACTUAL_PROFIT_POLICY.version,REFUND_CREDIT_ACTUAL_PROFIT_POLICY.version].includes(version);
}

// Only an entire zero-value, single-spec placeholder order is outside the v3 profit scope.
// Keep this at the order boundary so its shipment charges cannot leak into freight.
const PLACEHOLDER_ORDER_EXPR = `h.paid_amount=0
  AND EXISTS (SELECT 1 FROM raw.wdt_order_lines p WHERE p.shop_key=h.shop_key
    AND p.wdt_trade_no=h.wdt_trade_no AND p.erp_spec_no='dc99999')
  AND NOT EXISTS (SELECT 1 FROM raw.wdt_order_lines p WHERE p.shop_key=h.shop_key
    AND p.wdt_trade_no=h.wdt_trade_no AND (
      p.erp_spec_no IS DISTINCT FROM 'dc99999' OR coalesce(p.source_share_amount,0)<>0
      OR coalesce(p.source_line_paid,0)<>0 OR coalesce(p.source_goods_cost,0)<>0
      OR coalesce(p.source_ref_unit_cost,0)<>0))`;
export function excludePlaceholderOrder(param) {
  return `AND NOT ($${param}::boolean AND (${PLACEHOLDER_ORDER_EXPR}))`;
}

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
  if (args.policyVersion && ![ACTUAL_PROFIT_POLICY.version,REFUND_CREDIT_ACTUAL_PROFIT_POLICY.version,WEIGHT_ACTUAL_PROFIT_POLICY.version,REVENUE_ACTUAL_PROFIT_POLICY.version,PREVIOUS_ACTUAL_PROFIT_POLICY.version,LEGACY_ACTUAL_PROFIT_POLICY.version].includes(String(args.policyVersion).trim())) {
    throw new Error(`--policy-version 当前仅支持 ${ACTUAL_PROFIT_POLICY.version}、${REFUND_CREDIT_ACTUAL_PROFIT_POLICY.version}、${WEIGHT_ACTUAL_PROFIT_POLICY.version}、${REVENUE_ACTUAL_PROFIT_POLICY.version}、${PREVIOUS_ACTUAL_PROFIT_POLICY.version} 或 ${LEGACY_ACTUAL_PROFIT_POLICY.version}`);
  }
  const returnResaleRate=Number(args.returnResaleRate ?? ACTUAL_PROFIT_POLICY.returnResaleRate);
  if (!Number.isFinite(returnResaleRate) || returnResaleRate<0 || returnResaleRate>1)
    throw new Error('--return-resale-rate 必须是 0 到 1 之间的比例');
  return {...period, policyVersion: args.policyVersion || ACTUAL_PROFIT_POLICY.version,returnResaleRate};
}

const ORDER_SCOPE_SQL = `
  WITH all_scoped AS MATERIALIZED (
    SELECT h.wdt_trade_no,h.paid_amount,h.real_amount,h.refund_amount,
      (${PLACEHOLDER_ORDER_EXPR}) AS is_placeholder
    FROM raw.wdt_order_headers h WHERE h.shop_key=$1 AND h.order_status_code=95
      AND (h.paid_at AT TIME ZONE 'Asia/Shanghai')::date BETWEEN $2::date AND $3::date
  ), scoped AS MATERIALIZED (
    SELECT wdt_trade_no,paid_amount,real_amount,refund_amount
    FROM all_scoped WHERE NOT ($4::boolean AND is_placeholder)
  )
  SELECT (SELECT count(*)::bigint FROM scoped) AS eligible_orders,
    (SELECT count(*)::bigint FROM all_scoped WHERE $4::boolean AND is_placeholder) AS ignored_placeholder_orders,
    (SELECT count(*)::bigint FROM raw.wdt_order_lines l JOIN scoped s USING(wdt_trade_no) WHERE l.shop_key=$1) AS order_lines,
    (SELECT count(*)::bigint FROM raw.shipments x JOIN scoped s USING(wdt_trade_no) WHERE x.shop_key=$1) AS shipments,
    (SELECT round(coalesce(sum(CASE WHEN $5::boolean THEN real_amount+coalesce(refund_amount,0)
      ELSE paid_amount END),0),2)::text FROM scoped) AS paid_amount,
    (SELECT round(coalesce(sum(paid_amount),0),2)::text FROM scoped) AS header_paid_amount,
    (SELECT round(coalesce(sum(real_amount),0),2)::text FROM scoped) AS header_real_amount,
    (SELECT round(coalesce(sum(coalesce(refund_amount,0)),0),2)::text FROM scoped) AS header_refund_amount,
    (SELECT count(*)::bigint FROM scoped WHERE $5::boolean AND real_amount IS NULL) AS missing_real_amount_orders,
    (SELECT round(coalesce(sum(coalesce(l.source_share_amount,l.source_line_paid,0)),0),2)::text
       FROM raw.wdt_order_lines l JOIN scoped s USING(wdt_trade_no) WHERE l.shop_key=$1) AS allocated_line_revenue`;

const PAYMENT_BRIDGE_SQL = `
  WITH month_orders AS MATERIALIZED (
    SELECT h.shop_key,h.wdt_trade_no,h.order_status_code,
      h.real_amount+coalesce(h.refund_amount,0) AS original_payment
    FROM raw.wdt_order_headers h
    WHERE h.shop_key=$1 AND h.order_status_code IN (4,5,95)
      AND (h.paid_at AT TIME ZONE 'Asia/Shanghai')::date BETWEEN $2::date AND $3::date
  ), cancelled AS MATERIALIZED (
    SELECT * FROM month_orders WHERE order_status_code IN (4,5)
  ), cancelled_refunds AS MATERIALIZED (
    SELECT r.shop_key,r.wdt_trade_no,
      sum(coalesce(r.actual_refund_amount,r.refunded_amount,r.return_amount,0)) AS settled_amount
    FROM raw.wdt_refund_headers r JOIN cancelled c USING(shop_key,wdt_trade_no)
    WHERE r.is_financially_refunded AND r.settled_at<=$4::timestamptz
    GROUP BY 1,2
  )
  SELECT (SELECT count(*)::bigint FROM month_orders) AS all_order_count,
    (SELECT round(coalesce(sum(original_payment),0),2)::text FROM month_orders) AS all_order_original_payment,
    (SELECT count(*)::bigint FROM cancelled) AS cancelled_order_count,
    (SELECT round(coalesce(sum(original_payment),0),2)::text FROM cancelled) AS cancelled_original_payment,
    (SELECT round(coalesce(sum(settled_amount),0),2)::text FROM cancelled_refunds) AS cancelled_settled_refund,
    (SELECT count(*)::bigint FROM cancelled c LEFT JOIN cancelled_refunds r USING(shop_key,wdt_trade_no)
      WHERE r.wdt_trade_no IS NULL AND c.original_payment>0) AS cancelled_positive_orders_without_settled_refund,
    (SELECT round(coalesce(sum(c.original_payment),0),2)::text
      FROM cancelled c LEFT JOIN cancelled_refunds r USING(shop_key,wdt_trade_no)
      WHERE r.wdt_trade_no IS NULL AND c.original_payment>0) AS cancelled_positive_payment_without_settled_refund`;

export const OWNER_CANCELLED_PAYMENT_SQL = `
  WITH cancelled AS MATERIALIZED (
    SELECT h.shop_key,h.wdt_trade_no,(h.paid_at AT TIME ZONE 'Asia/Shanghai')::date AS paid_date,
      h.real_amount+coalesce(h.refund_amount,0) AS original_payment
    FROM raw.wdt_order_headers h
    WHERE h.shop_key=$1 AND h.order_status_code IN (4,5)
      AND (h.paid_at AT TIME ZONE 'Asia/Shanghai')::date BETWEEN $2::date AND $3::date
  ), settled AS MATERIALIZED (
    SELECT r.shop_key,r.wdt_trade_no,
      sum(coalesce(r.actual_refund_amount,r.refunded_amount,r.return_amount,0)) AS settled_refund
    FROM raw.wdt_refund_headers r JOIN cancelled c USING(shop_key,wdt_trade_no)
    WHERE r.is_financially_refunded AND r.settled_at<=$4::timestamptz
    GROUP BY 1,2
  ), lines AS MATERIALIZED (
    SELECT c.wdt_trade_no,c.paid_date,c.original_payment,coalesce(s.settled_refund,0) AS settled_refund,
      l.platform_product_id,coalesce(i.product_title,l.product_name) AS product_name,
      i.image_url AS product_image_url,
      coalesce(l.source_share_amount,l.source_line_paid,0) AS allocation_weight,
      sum(coalesce(l.source_share_amount,l.source_line_paid,0)) OVER(PARTITION BY c.wdt_trade_no) AS order_weight,
      count(*) OVER(PARTITION BY c.wdt_trade_no) AS order_line_count
    FROM cancelled c JOIN raw.wdt_order_lines l USING(shop_key,wdt_trade_no)
    LEFT JOIN settled s USING(shop_key,wdt_trade_no)
    LEFT JOIN master.product_image_mappings i USING(platform_product_id)
  ), assigned AS MATERIALIZED (
    SELECT l.paid_date,coalesce(l.platform_product_id,'__UNMAPPED_ORDER_LINE__') AS platform_product_id,
      l.product_name,l.product_image_url,
      CASE WHEN l.platform_product_id IS NULL THEN '无法归属'
      WHEN nullif(trim(o.owner_name),'') IS NOT NULL AND o.owner_name NOT IN ('未分配','未分配负责人') THEN o.owner_name
      WHEN l.platform_product_id=ANY($5::text[]) THEN '不归属负责人'
      WHEN l.platform_product_id=ANY($6::text[]) THEN '已下架未分配'
      ELSE '未分配负责人' END AS owner_name,
      l.original_payment*CASE WHEN l.order_weight<>0 THEN l.allocation_weight/l.order_weight
        ELSE 1::numeric/l.order_line_count END AS allocated_payment,
      l.settled_refund*CASE WHEN l.order_weight<>0 THEN l.allocation_weight/l.order_weight
        ELSE 1::numeric/l.order_line_count END AS allocated_refund
    FROM lines l LEFT JOIN LATERAL (
      SELECT owner_name FROM master.product_owner_versions o WHERE o.shop_key=$1
        AND o.platform_product_id=l.platform_product_id AND o.status='approved'
        AND l.paid_date>=o.effective_from AND (o.effective_to IS NULL OR l.paid_date<=o.effective_to)
      ORDER BY o.effective_from DESC LIMIT 1
    ) o ON true
  )
  SELECT CASE WHEN grouping(platform_product_id)=0 THEN 'product' ELSE 'owner' END AS level,
    CASE WHEN grouping(platform_product_id)=0 THEN (array_agg(owner_name ORDER BY paid_date DESC))[1]
      ELSE owner_name END AS owner_name,
    CASE WHEN grouping(platform_product_id)=0 THEN platform_product_id END AS platform_product_id,
    CASE WHEN grouping(platform_product_id)=0 THEN (array_agg(product_name ORDER BY paid_date DESC)
      FILTER(WHERE product_name IS NOT NULL))[1] END AS product_name,
    CASE WHEN grouping(platform_product_id)=0 THEN max(product_image_url) END AS product_image_url,
    round(sum(allocated_payment),4)::text AS cancelled_order_original_payment,
    round(sum(allocated_refund),4)::text AS cancelled_order_settled_refund
  FROM assigned GROUP BY GROUPING SETS ((owner_name),(platform_product_id))
  ORDER BY level,owner_name,platform_product_id`;

const REFUND_SQL = `
  WITH scoped_orders AS MATERIALIZED (
    SELECT h.wdt_trade_no,h.platform_trade_id FROM raw.wdt_order_headers h
    WHERE h.shop_key=$1 AND h.order_status_code=95
      AND (h.paid_at AT TIME ZONE 'Asia/Shanghai')::date BETWEEN $2::date AND $3::date
      ${excludePlaceholderOrder(5)}
  ), scoped_refunds AS MATERIALIZED (
    SELECT h.*,o.platform_trade_id AS original_platform_trade_id
    FROM raw.wdt_refund_headers h JOIN scoped_orders o USING(wdt_trade_no)
    WHERE h.shop_key=$1 AND h.is_financially_refunded AND h.settled_at <= $4::timestamptz
  ), scoped_lines AS MATERIALIZED (
    SELECT l.*,h.wdt_trade_no,h.original_platform_trade_id,h.refund_type,h.refund_status_text
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
    count(*) FILTER(WHERE refund_type=1)::bigint AS pre_ship_refund_lines,
    count(*) FILTER(WHERE refund_type=2)::bigint AS return_refund_lines,
    count(*) FILTER(WHERE refund_type=2 AND refund_status_text='待入库')::bigint AS pending_stockin_return_lines,
    count(*) FILTER(WHERE refund_type IN (1,2) AND NOT is_mapped)::bigint AS unmapped_cost_refund_lines,
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
      ${excludePlaceholderOrder(4)}
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
      ${excludePlaceholderOrder(6)}
  ), classified AS (
    SELECT l.*,CASE WHEN $5::boolean THEN c.unit_cost ELSE m.unit_cost END AS unit_cost,
      CASE WHEN l.platform_product_id=ANY($4::text[]) THEN 'explicit_zero'
           WHEN $5::boolean AND c.cost_status='available' AND c.unit_cost>0 THEN 'standard_reference'
           WHEN $5::boolean THEN 'missing'
           WHEN l.source_goods_cost IS NOT NULL THEN 'actual'
           WHEN m.unit_cost IS NOT NULL THEN 'standard_reference' ELSE 'missing' END AS value_state
    FROM lines l LEFT JOIN LATERAL (
      SELECT unit_cost FROM master.sku_cost_versions m WHERE m.shop_key=$1
        AND m.erp_spec_no=l.erp_spec_no AND m.status='approved'
        AND l.paid_date>=m.effective_from AND (m.effective_to IS NULL OR l.paid_date<=m.effective_to)
      ORDER BY m.effective_from DESC LIMIT 1
    ) m ON true
    LEFT JOIN master.current_sku_costs c ON c.shop_key=$1 AND c.erp_spec_no=l.erp_spec_no
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
      ${excludePlaceholderOrder(6)}
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
  const currentCostPolicy=period.policyVersion!==LEGACY_ACTUAL_PROFIT_POLICY.version;
  const placeholderPolicy=[ACTUAL_PROFIT_POLICY.version,REFUND_CREDIT_ACTUAL_PROFIT_POLICY.version,WEIGHT_ACTUAL_PROFIT_POLICY.version,REVENUE_ACTUAL_PROFIT_POLICY.version].includes(period.policyVersion);
  const originalPaymentPolicy=period.policyVersion===ACTUAL_PROFIT_POLICY.version;
  const orderResult = await client.query(ORDER_SCOPE_SQL, [...monthParams,placeholderPolicy,originalPaymentPolicy]);
  const paymentBridgeResult = await client.query(PAYMENT_BRIDGE_SQL,params);
  const refundResult = await client.query(REFUND_SQL, [...params,placeholderPolicy]);
  const freightResult = await client.query(FREIGHT_SQL, [...monthParams,placeholderPolicy]);
  const costResult = await client.query(COST_SQL, [...monthParams, nonMerchandiseProductIds,currentCostPolicy,placeholderPolicy]);
  const ownerResult = await client.query(OWNER_SQL, [...monthParams, ownerOptionalProductIds, nonMerchandiseProductIds,placeholderPolicy]);
  const adsResult = await client.query(ADS_SQL, [period.startDate, period.endDate, adShopName]);
  const weightPolicy=[ACTUAL_PROFIT_POLICY.version,REFUND_CREDIT_ACTUAL_PROFIT_POLICY.version,WEIGHT_ACTUAL_PROFIT_POLICY.version].includes(period.policyVersion);
  const weightResult=weightPolicy?await client.query(SKU_GROSS_WEIGHT_COVERAGE_SQL,[...monthParams,placeholderPolicy,nonMerchandiseProductIds,
    ACTUAL_PROFIT_POLICY.missingFreightPerWaybill,period.refundCutoff,hasReturnCostCredit(period.policyVersion)]):null;
  const weightRun=weightPolicy?await client.query(`SELECT run_id,method,created_at,
      changed_estimate_count,changed_inferred_count
    FROM meta.platform_sku_gross_weight_runs WHERE shop_key=$1
      AND (changed_estimate_count>0 OR changed_inferred_count>0)
    ORDER BY created_at DESC LIMIT 1`,[args.shopKey]):null;
  const orderScope = rowNumbers(orderResult.rows[0], ['eligible_orders','ignored_placeholder_orders','order_lines','shipments']);
  orderScope.paid_amount = decimal(orderScope.paid_amount);
  orderScope.header_paid_amount = decimal(orderScope.header_paid_amount);
  orderScope.header_real_amount = decimal(orderScope.header_real_amount);
  orderScope.header_refund_amount = decimal(orderScope.header_refund_amount);
  orderScope.allocated_line_revenue = decimal(orderScope.allocated_line_revenue);
  orderScope.line_revenue_difference = (Number(orderScope.allocated_line_revenue || 0) - Number(orderScope.paid_amount || 0)).toFixed(2);
  orderScope.selected_revenue_amount = orderScope.paid_amount;
  orderScope.allocation_weight_amount = orderScope.allocated_line_revenue;
  orderScope.allocation_rule = originalPaymentPolicy
    ? '已发货订单头 real_amount + refund_amount 还原支付原额；商品明细 shareAmount/paid 作为订单内分配权重，退款单另行扣减'
    : '订单头 paid_amount 作为收入总额；商品明细 shareAmount/paid 仅作为订单内分配权重，并按订单头实付归一化';
  orderScope.sources = {
    headerAmount:originalPaymentPolicy
      ? {table:'raw.wdt_order_headers',columns:['real_amount','refund_amount'],sourceFields:['orders[].realAmount','orders[].refundAmount']}
      : {table:'raw.wdt_order_headers',column:'paid_amount',sourceField:'orders[].paid'},
    lineAmount:{table:'raw.wdt_order_lines',column:'source_share_amount',fallbackColumn:'source_line_paid',sourceFields:['orders[].items[].shareAmount','orders[].items[].paid']},
  };
  const paymentBridge=rowNumbers(paymentBridgeResult.rows[0],
    ['all_order_count','cancelled_order_count','cancelled_positive_orders_without_settled_refund']);
  paymentBridge.cancelled_net_after_settled_refunds=
    (Number(paymentBridge.cancelled_original_payment||0)-Number(paymentBridge.cancelled_settled_refund||0)).toFixed(2);
  paymentBridge.shipped_original_payment=
    (Number(orderScope.header_real_amount||0)+Number(orderScope.header_refund_amount||0)).toFixed(2);
  paymentBridge.all_to_shipped_difference=
    (Number(paymentBridge.all_order_original_payment||0)-Number(paymentBridge.shipped_original_payment||0)).toFixed(2);
  const refunds = rowNumbers(refundResult.rows[0], ['settled_refunds','refund_lines','unmatched_refund_headers','unmapped_refund_lines',
    'pre_ship_refund_lines','return_refund_lines','pending_stockin_return_lines','unmapped_cost_refund_lines']);
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
  costs.basis=currentCostPolicy?'master.current_sku_costs.unit_cost × raw.wdt_order_lines.quantity'
    :'raw.wdt_order_lines.source_goods_cost; fallback paid-date master.sku_cost_versions.unit_cost × quantity';
  if(hasReturnCostCredit(period.policyVersion)) costs.basis+=`; 未发货退款数量全额冲回，退货退款数量按 ${(period.returnResaleRate*100).toFixed(0)}% 可二次销售比例冲回`;
  if(currentCostPolicy) {
    const syncBatch=await client.query(`SELECT batch_id,source_metadata,imported_at,effective_from::text
      FROM meta.master_data_batches WHERE shop_key=$1 AND data_type='sku-cost-sync'
        AND status='approved' ORDER BY imported_at DESC LIMIT 1`,[args.shopKey]);
    costs.latestSync=syncBatch.rows[0]??null;
  }
  const owners = rowNumbers(ownerResult.rows[0], ['product_days','assigned_product_days','unassigned_product_days','unassigned_products','review_unassigned_products','intentional_unassigned_products']);
  const ads = rowNumbers(adsResult.rows[0], ['covered_days','rows']);
  ads.expected_days = Number(period.endDate.slice(8,10));
  ads.missing_days = Math.max(0, ads.expected_days - ads.covered_days);
  const freightWeightAllocation=weightPolicy?{
    method:'platform_sku_gross_weight',sourceTable:'master.current_platform_sku_gross_weights',
    componentTable:'master.current_platform_sku_components',
    latestWeightRun:weightRun.rows[0]??null,
    ...rowNumbers(weightResult.rows[0],['sku_groups','weighted_sku_groups','missing_sku_groups','inferred_sku_groups','shared_inferred_sku_groups','low_confidence_sku_groups','orders','missing_weight_orders','missing_platform_skus']),
  }:{method:'order_revenue_share',status:'revenue_share'};
  if(weightPolicy) freightWeightAllocation.status=freightWeightAllocation.missing_weight_orders>0?'weight_with_revenue_fallback':'weight_allocated';

  const blockingGaps = [];
  const advisoryGaps = [];
  addGap(blockingGaps, !ordersCoverage.complete, {code:'ORDER_SOURCE_COVERAGE_INCOMPLETE', missingPeriods:ordersCoverage.missingPeriods});
  addGap(blockingGaps, !refundSourceCoverage.complete, {code:'REFUND_SOURCE_COVERAGE_INCOMPLETE', missingPeriods:refundSourceCoverage.missingPeriods});
  addGap(blockingGaps, originalPaymentPolicy && Number(orderScope.missing_real_amount_orders||0)>0,
    {code:'ORDER_ORIGINAL_PAYMENT_MISSING',orders:Number(orderScope.missing_real_amount_orders)});
  addGap(advisoryGaps, Math.abs(Number(orderScope.line_revenue_difference)) > 0.01,
    {code:'ORDER_LINES_USED_AS_ALLOCATION_WEIGHTS', difference:orderScope.line_revenue_difference, selectedRevenue:orderScope.selected_revenue_amount, allocationWeightAmount:orderScope.allocation_weight_amount});
  addGap(advisoryGaps, Number(paymentBridge.cancelled_positive_orders_without_settled_refund||0)>0 ||
    Math.abs(Number(paymentBridge.cancelled_net_after_settled_refunds||0))>0.01,
    {code:'CANCELLED_ORDER_PAYMENT_REFUND_REVIEW',cancelledOriginalPayment:paymentBridge.cancelled_original_payment,
      cancelledSettledRefund:paymentBridge.cancelled_settled_refund,
      netAfterSettledRefunds:paymentBridge.cancelled_net_after_settled_refunds,
      positiveOrdersWithoutSettledRefund:paymentBridge.cancelled_positive_orders_without_settled_refund,
      positivePaymentWithoutSettledRefund:paymentBridge.cancelled_positive_payment_without_settled_refund});
  addGap(blockingGaps, costs.missing_lines > 0, {code:'GOODS_COST_MISSING', count:costs.missing_lines, affectedRevenue:costs.missing_revenue});
  addGap(blockingGaps, ads.missing_days > 0, {code:'AD_DAILY_COVERAGE_INCOMPLETE', count:ads.missing_days});
  addGap(blockingGaps, Math.abs(Number(refunds.header_refund_amount || 0) - Number(refunds.line_refund_amount || 0)) > 0.01,
    {code:'REFUND_LINE_AMOUNT_MISMATCH', headerAmount:refunds.header_refund_amount, lineAmount:refunds.line_refund_amount});
  addGap(advisoryGaps, refunds.unmapped_refund_lines > 0, {code:'REFUND_LINE_UNMAPPED', count:refunds.unmapped_refund_lines, amount:refunds.unmapped_refund_amount});
  if(hasReturnCostCredit(period.policyVersion)) {
    addGap(advisoryGaps, refunds.unmapped_cost_refund_lines>0,
      {code:'REFUND_COST_LINE_UNMAPPED',count:refunds.unmapped_cost_refund_lines,rule:'无法映射的退款行暂不冲回商品成本，需人工核对'});
    addGap(advisoryGaps, refunds.pending_stockin_return_lines>0,
      {code:'RETURN_RESALE_ASSUMPTION_PENDING_STOCKIN',count:refunds.pending_stockin_return_lines,
        returnResaleRate:period.returnResaleRate,rule:'退货退款虽为待入库，按人为设定的可二次销售比例暂估冲回成本'});
  }
  addGap(advisoryGaps, freight.estimated_waybills > 0, {code:'FREIGHT_ESTIMATED_BY_CONFIRMED_POLICY', count:freight.estimated_waybills, amount:freight.estimated_freight_amount, unitAmount:freight.estimated_unit_amount});
  addGap(advisoryGaps, freight.shared_tracking_waybills > 0, {code:'TRACKING_SHARED_BY_MULTIPLE_ORDERS', count:freight.shared_tracking_waybills});
  addGap(advisoryGaps, freight.multi_carrier_waybills > 0, {code:'TRACKING_MATCHES_MULTIPLE_CARRIERS', count:freight.multi_carrier_waybills});
  addGap(advisoryGaps, owners.review_unassigned_products > 0, {code:'PRODUCT_OWNER_REVIEW_REQUIRED', productDays:owners.unassigned_product_days, products:owners.review_unassigned_products});
  if(weightPolicy) {
    addGap(advisoryGaps, freightWeightAllocation.missing_weight_orders>0,
      {code:'SKU_GROSS_WEIGHT_REVENUE_FALLBACK',orders:freightWeightAllocation.missing_weight_orders,
        skuGroups:freightWeightAllocation.missing_sku_groups,
        freightAmount:freightWeightAllocation.fallback_freight_amount,
        rule:hasReturnCostCredit(period.policyVersion)
          ?'整单按有效发货数量加权的收入占比分摊；收入权重为零时按发货数量分摊'
          :'整单按收入比例分摊；零实付时按子件行等分',
        examples:freightWeightAllocation.missing_examples});
    addGap(advisoryGaps, freightWeightAllocation.low_confidence_sku_groups>0,
      {code:'SKU_GROSS_WEIGHT_LOW_CONFIDENCE',skuGroups:freightWeightAllocation.low_confidence_sku_groups});
    addGap(advisoryGaps, freightWeightAllocation.inferred_sku_groups>0,
      {code:'SKU_GROSS_WEIGHT_MULTI_SKU_INFERRED',skuGroups:freightWeightAllocation.inferred_sku_groups,
        packagingAssumptionKg:ACTUAL_PROFIT_POLICY.residualPackagingAssumptionKg});
    addGap(advisoryGaps, freightWeightAllocation.shared_inferred_sku_groups>0,
      {code:'SKU_GROSS_WEIGHT_SHARED_RESIDUAL',skuGroups:freightWeightAllocation.shared_inferred_sku_groups,
        rule:'多个未知 SKU 的剩余净货重按购买件数均分',confidenceCap:0.1});
  } else addGap(advisoryGaps, true, {code:'FREIGHT_ALLOCATED_BY_REVENUE', reason:'按订单内归一化收入占比分配'});

  return {
    mode:'live-read-only', calculationPerformed:false, shopKey:args.shopKey, shopName:sourceShopName,
    period, targetState:'actual/reconciled', status:blockingGaps.length ? 'incomplete' :
      freight.estimated_waybills > 0 || weightPolicy ? 'provisional' : 'actual/reconciled',
    coverage:{orders:ordersCoverage, refundSource:{...refundSourceCoverage,dateBasis:'退款申请日批次覆盖；退款金额另按原支付月订单与结算截止时间核对'}, orderScope,paymentBridge, refunds, freight, costs, owners, ads,
      policy:{...actualPolicy(period.policyVersion),returnResaleRate:hasReturnCostCredit(period.policyVersion)?period.returnResaleRate:null,status:'confirmed'}, freightWeightAllocation},
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

export function validateActualOrderCostAuditRequest(args = {}) {
  const period = validateActualCoverageRequest(args);
  const orderNos = [...new Set(String(args.orderNos || '').split(/[,，\s]+/).map(value=>value.trim()).filter(Boolean))];
  if (orderNos.length > 100) throw new Error('--order-nos 最多支持 100 个订单号');
  if (orderNos.length && args.sampleSize != null) throw new Error('--order-nos 与 --sample-size 不能同时使用');
  const sampleSize = orderNos.length ? orderNos.length : Number(args.sampleSize ?? 30);
  if (!Number.isInteger(sampleSize) || sampleSize < 1 || sampleSize > 1000) throw new Error('--sample-size 必须是 1 到 1000 的整数');
  return {...period, orderNos, sampleSize, selectionMode:orderNos.length ? 'explicit-orders' : 'deterministic-sample'};
}

export function validateActualComboCostAuditRequest(args = {}) {
  const period = validateActualCoverageRequest(args);
  const productId = String(args.productId || '').trim() || null;
  const platformSkuId = String(args.platformSkuId || '').trim() || null;
  return {...period, productId, platformSkuId};
}

export function validateActualReferenceCostAuditRequest(args = {}) {
  return validateActualCoverageRequest(args);
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

const ORDER_COST_AUDIT_SQL = `
  WITH eligible_orders AS MATERIALIZED (
    SELECT h.shop_key,h.wdt_trade_no,(h.paid_at AT TIME ZONE 'Asia/Shanghai')::date AS paid_date
    FROM raw.wdt_order_headers h
    WHERE h.shop_key=$1 AND h.order_status_code=95
      AND (h.paid_at AT TIME ZONE 'Asia/Shanghai')::date BETWEEN $2::date AND $3::date
  ), selected_orders AS MATERIALIZED (
    SELECT * FROM eligible_orders
    WHERE ($4::text[] IS NULL OR wdt_trade_no=ANY($4::text[]))
    ORDER BY CASE WHEN $4::text[] IS NULL THEN md5(wdt_trade_no) ELSE wdt_trade_no END
    LIMIT $5
  ), line_costs AS MATERIALIZED (
    SELECT o.paid_date,o.wdt_trade_no,l.order_line_key,l.platform_product_id,l.platform_sku_id,l.erp_spec_no,
      l.product_name,l.sku_name,coalesce(l.quantity,0) AS quantity,
      l.source_goods_cost,l.source_ref_unit_cost,c.unit_cost AS master_unit_cost
    FROM selected_orders o JOIN raw.wdt_order_lines l USING(shop_key,wdt_trade_no)
    LEFT JOIN LATERAL (
      SELECT unit_cost FROM master.sku_cost_versions c
      WHERE c.shop_key=$1 AND c.erp_spec_no=l.erp_spec_no AND c.status='approved'
        AND o.paid_date>=c.effective_from AND (c.effective_to IS NULL OR o.paid_date<=c.effective_to)
      ORDER BY c.effective_from DESC LIMIT 1
    ) c ON true
  )
  SELECT min(paid_date)::text AS paid_date,wdt_trade_no,count(*)::text AS line_count,
    count(DISTINCT platform_product_id)::text AS product_count,
    count(DISTINCT coalesce(erp_spec_no,platform_sku_id))::text AS sku_count,
    sum(quantity)::text AS quantity_total,
    count(*) FILTER(WHERE source_goods_cost IS NULL)::text AS source_goods_missing_lines,
    count(*) FILTER(WHERE source_goods_cost=0)::text AS source_goods_zero_lines,
    sum(source_goods_cost)::text AS source_goods_cost_total,
    count(*) FILTER(WHERE source_ref_unit_cost IS NULL)::text AS source_ref_missing_lines,
    sum(source_ref_unit_cost*quantity)::text AS source_ref_calculated_cost_total,
    count(*) FILTER(WHERE master_unit_cost IS NULL)::text AS master_missing_lines,
    sum(master_unit_cost*quantity)::text AS master_calculated_cost_total,
    (SELECT count(*)::text FROM eligible_orders) AS eligible_order_count,
    CASE WHEN $4::text[] IS NOT NULL THEN jsonb_agg(jsonb_build_object(
      'orderLineKey',order_line_key,'platformProductId',platform_product_id,
      'platformSkuId',platform_sku_id,'erpSpecNo',erp_spec_no,
      'productName',product_name,'skuName',sku_name,'quantity',quantity,
      'sourceGoodsCost',source_goods_cost,'sourceRefUnitCost',source_ref_unit_cost,
      'sourceRefCalculatedCost',source_ref_unit_cost*quantity,
      'masterUnitCost',master_unit_cost,'masterCalculatedCost',master_unit_cost*quantity
    ) ORDER BY order_line_key) END AS detail_lines
  FROM line_costs GROUP BY wdt_trade_no
  ORDER BY min(paid_date),wdt_trade_no`;

function orderComparisonSummary(rows,key) {
  const comparisons = rows.map(row=>row[key]);
  const comparable = comparisons.filter(item=>item.comparable);
  const mismatches = comparable.filter(item=>!item.matches);
  return {
    comparableOrderCount:comparable.length,
    matchOrderCount:comparable.length-mismatches.length,
    mismatchOrderCount:mismatches.length,
    unavailableOrderCount:comparisons.length-comparable.length,
    absoluteDifferenceTotal:auditAmount(mismatches.reduce((sum,item)=>sum+Math.abs(item.difference),0)),
    maximumAbsoluteDifference:auditAmount(mismatches.reduce((max,item)=>Math.max(max,Math.abs(item.difference)),0)),
  };
}

export async function getActualOrderCostAudit(client,args={}) {
  const request = validateActualOrderCostAuditRequest(args);
  const shop = await client.query('SELECT shop_name FROM raw.wdt_order_headers WHERE shop_key=$1 ORDER BY observed_at DESC LIMIT 1',[args.shopKey]);
  if (!shop.rows.length) throw new Error('没有找到该店铺的订单事实');
  const params=[args.shopKey,request.startDate,request.endDate,request.orderNos.length ? request.orderNos : null,request.sampleSize];
  const sourceRows=(await client.query(ORDER_COST_AUDIT_SQL,params)).rows;
  const rows=sourceRows.map(row=>{
    const sourceGoodsMissingLines=Number(row.source_goods_missing_lines);
    const sourceRefMissingLines=Number(row.source_ref_missing_lines);
    const masterMissingLines=Number(row.master_missing_lines);
    const sourceGoodsCostTotal=auditNumber(row.source_goods_cost_total);
    const sourceRefCalculatedCostTotal=auditNumber(row.source_ref_calculated_cost_total);
    const masterCalculatedCostTotal=auditNumber(row.master_calculated_cost_total);
    const detailLines=request.selectionMode==='explicit-orders' ? (row.detail_lines || []).map(line=>{
      const sourceGoodsCost=auditNumber(line.sourceGoodsCost);
      const sourceRefCalculatedCost=auditNumber(line.sourceRefCalculatedCost);
      const masterCalculatedCost=auditNumber(line.masterCalculatedCost);
      return {
        orderLineKey:line.orderLineKey,platformProductId:line.platformProductId,
        platformSkuId:line.platformSkuId,erpSpecNo:line.erpSpecNo,
        productName:line.productName,skuName:line.skuName,quantity:auditAmount(auditNumber(line.quantity)),
        sourceGoodsCost:auditAmount(sourceGoodsCost),sourceRefUnitCost:auditAmount(auditNumber(line.sourceRefUnitCost)),
        sourceRefCalculatedCost:auditAmount(sourceRefCalculatedCost),masterUnitCost:auditAmount(auditNumber(line.masterUnitCost)),
        masterCalculatedCost:auditAmount(masterCalculatedCost),
        goodsVsSourceRef:costComparison(sourceGoodsCost,sourceRefCalculatedCost),
        goodsVsMaster:costComparison(sourceGoodsCost,masterCalculatedCost),
        sourceRefVsMaster:costComparison(sourceRefCalculatedCost,masterCalculatedCost),
      };
    }) : undefined;
    return {
      paidDate:row.paid_date,wdtTradeNo:row.wdt_trade_no,lineCount:Number(row.line_count),
      productCount:Number(row.product_count),skuCount:Number(row.sku_count),quantityTotal:auditNumber(row.quantity_total),
      sourceGoodsMissingLines,sourceGoodsZeroLines:Number(row.source_goods_zero_lines),
      sourceGoodsCostTotal:auditAmount(sourceGoodsCostTotal),sourceRefMissingLines,
      sourceRefCalculatedCostTotal:auditAmount(sourceRefCalculatedCostTotal),masterMissingLines,
      masterCalculatedCostTotal:auditAmount(masterCalculatedCostTotal),
      goodsVsSourceRef:costComparison(sourceGoodsMissingLines ? null : sourceGoodsCostTotal,sourceRefMissingLines ? null : sourceRefCalculatedCostTotal),
      goodsVsMaster:costComparison(sourceGoodsMissingLines ? null : sourceGoodsCostTotal,masterMissingLines ? null : masterCalculatedCostTotal),
      sourceRefVsMaster:costComparison(sourceRefMissingLines ? null : sourceRefCalculatedCostTotal,masterMissingLines ? null : masterCalculatedCostTotal),
      detailLines,
    };
  });
  const returnedOrderNos=new Set(rows.map(row=>row.wdtTradeNo));
  const goodsVsSourceRef=orderComparisonSummary(rows,'goodsVsSourceRef');
  const goodsVsMaster=orderComparisonSummary(rows,'goodsVsMaster');
  const sourceRefVsMaster=orderComparisonSummary(rows,'sourceRefVsMaster');
  return {
    mode:'live-read-only',calculationPerformed:false,audit:'whole-order-cost-consistency',tolerance:'0.01',
    shopKey:args.shopKey,shopName:shop.rows[0].shop_name,period:request,
    selection:{mode:request.selectionMode,sampleSize:request.sampleSize,eligibleOrderCount:Number(sourceRows[0]?.eligible_order_count || 0),requestedOrderNos:request.orderNos,missingRequestedOrderNos:request.orderNos.filter(value=>!returnedOrderNos.has(value))},
    summary:{
      orderCount:rows.length,lineCount:rows.reduce((sum,row)=>sum+row.lineCount,0),
      ordersWithZeroGoodsCostLines:rows.filter(row=>row.sourceGoodsZeroLines>0).length,
      goodsVsSourceRef,goodsVsMaster,sourceRefVsMaster,
      allComparableOrderCostsMatch:goodsVsSourceRef.mismatchOrderCount===0&&goodsVsMaster.mismatchOrderCount===0&&sourceRefVsMaster.mismatchOrderCount===0,
      fullyComparable:goodsVsSourceRef.unavailableOrderCount===0&&goodsVsMaster.unavailableOrderCount===0&&sourceRefVsMaster.unavailableOrderCount===0,
    },
    rows,
  };
}

const COMBO_COST_AUDIT_SQL = `
  WITH scoped_lines AS MATERIALIZED (
    SELECT (h.paid_at AT TIME ZONE 'Asia/Shanghai')::date AS paid_date,h.wdt_trade_no,
      l.platform_product_id,l.platform_sku_id,l.erp_spec_no,l.product_name,l.sku_name,
      coalesce(l.quantity,0) AS quantity,l.source_goods_cost,l.source_ref_unit_cost,
      c.unit_cost AS master_unit_cost
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
      AND ($4::text IS NULL OR l.platform_product_id=$4)
      AND ($5::text IS NULL OR l.platform_sku_id=$5)
      AND l.platform_product_id IS NOT NULL AND l.platform_sku_id IS NOT NULL AND l.erp_spec_no IS NOT NULL
  ), combo_instances AS MATERIALIZED (
    SELECT wdt_trade_no,platform_product_id,platform_sku_id
    FROM scoped_lines
    GROUP BY wdt_trade_no,platform_product_id,platform_sku_id
    HAVING count(DISTINCT erp_spec_no)>1
  ), combo_lines AS MATERIALIZED (
    SELECT l.* FROM scoped_lines l JOIN combo_instances c USING(wdt_trade_no,platform_product_id,platform_sku_id)
  ), order_combo AS MATERIALIZED (
    SELECT min(paid_date) AS paid_date,wdt_trade_no,platform_product_id,platform_sku_id,
      count(*) AS line_count,count(DISTINCT erp_spec_no) AS component_count,
      count(*) FILTER(WHERE source_goods_cost IS NULL) AS goods_missing_lines,
      count(*) FILTER(WHERE source_goods_cost=0) AS goods_zero_lines,
      count(*) FILTER(WHERE source_goods_cost=0 AND coalesce(source_ref_unit_cost*quantity,master_unit_cost*quantity,0)>0) AS positive_cost_zero_lines,
      sum(source_goods_cost) AS goods_cost_total,
      count(*) FILTER(WHERE source_ref_unit_cost IS NULL) AS ref_missing_lines,
      sum(source_ref_unit_cost*quantity) AS ref_cost_total,
      count(*) FILTER(WHERE master_unit_cost IS NULL) AS master_missing_lines,
      sum(master_unit_cost*quantity) AS master_cost_total
    FROM combo_lines GROUP BY wdt_trade_no,platform_product_id,platform_sku_id
  ), component_summary AS MATERIALIZED (
    SELECT platform_product_id,platform_sku_id,max(product_name) AS product_name,
      array_agg(DISTINCT erp_spec_no ORDER BY erp_spec_no) AS erp_spec_nos,
      count(*) AS line_count,sum(quantity) AS quantity_total,
      count(*) FILTER(WHERE source_goods_cost=0) AS goods_zero_lines,
      count(*) FILTER(WHERE source_goods_cost=0 AND coalesce(source_ref_unit_cost*quantity,master_unit_cost*quantity,0)>0) AS positive_cost_zero_lines,
      count(*) FILTER(WHERE source_goods_cost IS NULL) AS goods_missing_lines,
      count(*) FILTER(WHERE source_ref_unit_cost IS NULL) AS ref_missing_lines,
      count(*) FILTER(WHERE master_unit_cost IS NULL) AS master_missing_lines
    FROM combo_lines GROUP BY platform_product_id,platform_sku_id
  ), order_summary AS MATERIALIZED (
    SELECT platform_product_id,platform_sku_id,min(paid_date) AS first_paid_date,max(paid_date) AS last_paid_date,
      count(*) AS order_count,
      count(*) FILTER(WHERE goods_missing_lines=0 AND ref_missing_lines=0 AND abs(goods_cost_total-ref_cost_total)<=0.01) AS goods_ref_match_orders,
      count(*) FILTER(WHERE goods_missing_lines=0 AND ref_missing_lines=0 AND abs(goods_cost_total-ref_cost_total)>0.01) AS goods_ref_mismatch_orders,
      count(*) FILTER(WHERE goods_missing_lines>0 OR ref_missing_lines>0) AS goods_ref_unavailable_orders,
      count(*) FILTER(WHERE goods_missing_lines=0 AND goods_cost_total=0 AND ref_missing_lines=0 AND ref_cost_total>0) AS all_goods_zero_orders,
      sum(goods_cost_total) AS goods_cost_total,sum(ref_cost_total) AS ref_cost_total,sum(master_cost_total) AS master_cost_total,
      (array_agg(wdt_trade_no ORDER BY wdt_trade_no) FILTER(WHERE goods_missing_lines=0 AND ref_missing_lines=0 AND abs(goods_cost_total-ref_cost_total)>0.01))[1:10] AS mismatch_order_examples
    FROM order_combo GROUP BY platform_product_id,platform_sku_id
  )
  SELECT c.platform_product_id,c.platform_sku_id,c.product_name,c.erp_spec_nos,
    o.first_paid_date::text,o.last_paid_date::text,o.order_count::text,c.line_count::text,c.quantity_total::text,
    c.goods_zero_lines::text,c.positive_cost_zero_lines::text,c.goods_missing_lines::text,c.ref_missing_lines::text,c.master_missing_lines::text,
    o.goods_ref_match_orders::text,o.goods_ref_mismatch_orders::text,o.goods_ref_unavailable_orders::text,o.all_goods_zero_orders::text,
    o.goods_cost_total::text,o.ref_cost_total::text,o.master_cost_total::text,o.mismatch_order_examples
  FROM component_summary c JOIN order_summary o USING(platform_product_id,platform_sku_id)
  ORDER BY o.goods_ref_mismatch_orders DESC,abs(o.goods_cost_total-o.ref_cost_total) DESC,c.platform_product_id,c.platform_sku_id`;

export async function getActualComboCostAudit(client,args={}) {
  const request=validateActualComboCostAuditRequest(args);
  const shop=await client.query('SELECT shop_name FROM raw.wdt_order_headers WHERE shop_key=$1 ORDER BY observed_at DESC LIMIT 1',[args.shopKey]);
  if(!shop.rows.length) throw new Error('没有找到该店铺的订单事实');
  const sourceRows=(await client.query(COMBO_COST_AUDIT_SQL,[args.shopKey,request.startDate,request.endDate,request.productId,request.platformSkuId])).rows;
  const rows=sourceRows.map(row=>{
    const goodsCostTotal=auditNumber(row.goods_cost_total);
    const refCostTotal=auditNumber(row.ref_cost_total);
    const masterCostTotal=auditNumber(row.master_cost_total);
    const goodsMissingLines=Number(row.goods_missing_lines);
    const refMissingLines=Number(row.ref_missing_lines);
    const masterMissingLines=Number(row.master_missing_lines);
    return {
      platformProductId:row.platform_product_id,platformSkuId:row.platform_sku_id,productName:row.product_name,
      erpSpecNos:row.erp_spec_nos || [],firstPaidDate:row.first_paid_date,lastPaidDate:row.last_paid_date,
      orderCount:Number(row.order_count),lineCount:Number(row.line_count),quantityTotal:auditAmount(auditNumber(row.quantity_total)),
      goodsZeroLines:Number(row.goods_zero_lines),positiveCostZeroLines:Number(row.positive_cost_zero_lines),
      goodsMissingLines,refMissingLines,masterMissingLines,
      goodsRefMatchOrders:Number(row.goods_ref_match_orders),goodsRefMismatchOrders:Number(row.goods_ref_mismatch_orders),
      goodsRefUnavailableOrders:Number(row.goods_ref_unavailable_orders),allGoodsZeroOrders:Number(row.all_goods_zero_orders),
      goodsCostTotal:auditAmount(goodsCostTotal),refCostTotal:auditAmount(refCostTotal),masterCostTotal:auditAmount(masterCostTotal),
      goodsVsRef:costComparison(goodsMissingLines ? null : goodsCostTotal,refMissingLines ? null : refCostTotal),
      refVsMaster:costComparison(refMissingLines ? null : refCostTotal,masterMissingLines ? null : masterCostTotal),
      mismatchOrderExamples:row.mismatch_order_examples || [],
    };
  });
  return {
    mode:'live-read-only',calculationPerformed:false,audit:'combo-sku-cost-consistency',tolerance:'0.01',
    combinationDefinition:'同一旺店通订单内，同一商品ID与平台SKU ID展开为两个及以上不同ERP规格',
    shopKey:args.shopKey,shopName:shop.rows[0].shop_name,period:request,
    summary:{
      comboSkuCount:rows.length,comboOrderInstances:rows.reduce((sum,row)=>sum+row.orderCount,0),
      affectedComboSkuCount:rows.filter(row=>row.goodsRefMismatchOrders>0).length,
      mismatchOrderInstances:rows.reduce((sum,row)=>sum+row.goodsRefMismatchOrders,0),
      positiveCostZeroLines:rows.reduce((sum,row)=>sum+row.positiveCostZeroLines,0),
      goodsCostTotal:auditAmount(rows.reduce((sum,row)=>sum+(row.goodsCostTotal||0),0)),
      refCostTotal:auditAmount(rows.reduce((sum,row)=>sum+(row.refCostTotal||0),0)),
      costDifference:auditAmount(rows.reduce((sum,row)=>sum+((row.goodsCostTotal||0)-(row.refCostTotal||0)),0)),
    },
    rows,
  };
}

const REFERENCE_COST_AUDIT_SQL = `
  WITH scoped_lines AS MATERIALIZED (
    SELECT (h.paid_at AT TIME ZONE 'Asia/Shanghai')::date AS paid_date,h.wdt_trade_no,
      l.order_line_key,l.platform_product_id,l.platform_sku_id,l.erp_goods_no,l.erp_spec_no,l.product_name,l.sku_name,
      coalesce(l.quantity,0) AS quantity,l.source_goods_cost,l.source_ref_unit_cost,
      c.unit_cost AS master_unit_cost
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
  ), merchandise AS MATERIALIZED (
    SELECT * FROM scoped_lines WHERE platform_product_id IS NULL OR NOT(platform_product_id=ANY($4::text[]))
  )
  SELECT (SELECT count(*)::text FROM scoped_lines) AS line_count,
    (SELECT count(*)::text FROM scoped_lines WHERE platform_product_id=ANY($4::text[])) AS explicit_zero_lines,
    count(*)::text AS merchandise_lines,
    count(*) FILTER(WHERE source_ref_unit_cost IS NOT NULL)::text AS reference_present_lines,
    count(*) FILTER(WHERE source_ref_unit_cost IS NULL)::text AS reference_missing_lines,
    count(*) FILTER(WHERE source_ref_unit_cost=0)::text AS reference_zero_lines,
    count(*) FILTER(WHERE source_ref_unit_cost=0 AND source_goods_cost>0)::text AS reference_zero_goods_positive_lines,
    count(*) FILTER(WHERE source_ref_unit_cost=0 AND master_unit_cost>0)::text AS reference_false_zero_lines,
    count(*) FILTER(WHERE master_unit_cost IS NOT NULL)::text AS master_present_lines,
    count(*) FILTER(WHERE master_unit_cost IS NULL)::text AS master_missing_lines,
    count(*) FILTER(WHERE source_ref_unit_cost IS NOT NULL AND master_unit_cost IS NOT NULL)::text AS comparable_lines,
    count(*) FILTER(WHERE source_ref_unit_cost IS NOT NULL AND master_unit_cost IS NOT NULL
      AND abs(source_ref_unit_cost-master_unit_cost)<=0.01)::text AS matching_lines,
    count(*) FILTER(WHERE source_ref_unit_cost IS NOT NULL AND master_unit_cost IS NOT NULL
      AND abs(source_ref_unit_cost-master_unit_cost)>0.01)::text AS mismatch_lines,
    round(coalesce(sum(source_ref_unit_cost*quantity),0),2)::text AS reference_cost_total,
    round(coalesce(sum(master_unit_cost*quantity),0),2)::text AS master_cost_total,
    round(coalesce(sum((source_ref_unit_cost-master_unit_cost)*quantity)
      FILTER(WHERE source_ref_unit_cost IS NOT NULL AND master_unit_cost IS NOT NULL),0),2)::text AS comparable_difference,
    (SELECT coalesce(jsonb_agg(x ORDER BY abs((x->>'difference')::numeric) DESC),'[]'::jsonb) FROM (
      SELECT jsonb_build_object('paidDate',paid_date,'wdtTradeNo',wdt_trade_no,'orderLineKey',order_line_key,
        'platformProductId',platform_product_id,'platformSkuId',platform_sku_id,'erpSpecNo',erp_spec_no,
        'productName',product_name,'skuName',sku_name,'quantity',quantity,
        'referenceUnitCost',source_ref_unit_cost,'masterUnitCost',master_unit_cost,
        'difference',round((source_ref_unit_cost-master_unit_cost)*quantity,2)) AS x
      FROM merchandise WHERE source_ref_unit_cost IS NOT NULL AND master_unit_cost IS NOT NULL
        AND abs(source_ref_unit_cost-master_unit_cost)>0.01
      ORDER BY abs((source_ref_unit_cost-master_unit_cost)*quantity) DESC,paid_date,wdt_trade_no,order_line_key LIMIT 100
    ) mismatches) AS mismatch_examples,
    (SELECT coalesce(jsonb_agg(x ORDER BY x->>'erpSpecNo'),'[]'::jsonb) FROM (
      SELECT jsonb_build_object('erpGoodsNo',max(erp_goods_no),'erpSpecNo',erp_spec_no,'platformProductId',max(platform_product_id),
        'platformSkuId',max(platform_sku_id),'productName',max(product_name),'skuName',max(sku_name),
        'lineCount',count(*),'quantity',round(coalesce(sum(quantity),0),2),
        'goodsCostTotal',round(coalesce(sum(source_goods_cost),0),2),
        'masterUnitCost',max(master_unit_cost)) AS x
      FROM merchandise WHERE source_ref_unit_cost=0 GROUP BY erp_spec_no
    ) zeroes) AS zero_reference_items,
    (SELECT coalesce(jsonb_agg(x ORDER BY x->>'erpSpecNo'),'[]'::jsonb) FROM (
      SELECT jsonb_build_object('erpGoodsNo',max(erp_goods_no),'erpSpecNo',erp_spec_no,'platformProductId',max(platform_product_id),
        'platformSkuId',max(platform_sku_id),'productName',max(product_name),'skuName',max(sku_name),
        'lineCount',count(*),'quantity',round(coalesce(sum(quantity),0),2)) AS x
      FROM merchandise WHERE source_ref_unit_cost IS NULL GROUP BY erp_spec_no
    ) missing) AS missing_reference_items
  FROM merchandise`;

export async function getActualReferenceCostAudit(client,args={}) {
  const request=validateActualReferenceCostAuditRequest(args);
  const shop=await client.query('SELECT shop_name FROM raw.wdt_order_headers WHERE shop_key=$1 ORDER BY observed_at DESC LIMIT 1',[args.shopKey]);
  if(!shop.rows.length) throw new Error('没有找到该店铺的订单事实');
  const row=(await client.query(REFERENCE_COST_AUDIT_SQL,[args.shopKey,request.startDate,request.endDate,Object.keys(ACTUAL_PROFIT_POLICY.nonMerchandiseProducts)])).rows[0] || {};
  const merchandiseLines=Number(row.merchandise_lines || 0);
  const referencePresentLines=Number(row.reference_present_lines || 0);
  const masterPresentLines=Number(row.master_present_lines || 0);
  const comparableLines=Number(row.comparable_lines || 0);
  const mismatchLines=Number(row.mismatch_lines || 0);
  const referenceMissingLines=Number(row.reference_missing_lines || 0);
  const referenceFalseZeroLines=Number(row.reference_false_zero_lines || 0);
  return {
    mode:'live-read-only',calculationPerformed:false,audit:'reference-cost-policy-readiness',tolerance:'0.01',
    shopKey:args.shopKey,shopName:shop.rows[0].shop_name,period:request,
    summary:{
      lineCount:Number(row.line_count || 0),explicitZeroLines:Number(row.explicit_zero_lines || 0),merchandiseLines,
      referencePresentLines,referenceMissingLines,referenceZeroLines:Number(row.reference_zero_lines || 0),referenceFalseZeroLines,
      referenceZeroGoodsPositiveLines:Number(row.reference_zero_goods_positive_lines || 0),
      masterPresentLines,masterMissingLines:Number(row.master_missing_lines || 0),comparableLines,
      matchingLines:Number(row.matching_lines || 0),mismatchLines,
      referenceCoverageRate:merchandiseLines ? referencePresentLines/merchandiseLines : 1,
      masterCoverageRate:merchandiseLines ? masterPresentLines/merchandiseLines : 1,
      comparableRate:merchandiseLines ? comparableLines/merchandiseLines : 1,
      referenceCostTotal:auditAmount(auditNumber(row.reference_cost_total)),
      masterCostTotal:auditAmount(auditNumber(row.master_cost_total)),
      comparableDifference:auditAmount(auditNumber(row.comparable_difference)),
      readyForReferenceFirstPolicy:referenceMissingLines===0&&referenceFalseZeroLines===0&&mismatchLines===0&&comparableLines===merchandiseLines,
    },
    mismatchExamples:row.mismatch_examples || [],zeroReferenceItems:row.zero_reference_items || [],
    missingReferenceItems:row.missing_reference_items || [],
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

// One platform SKU has one gross-weight estimate. ERP component quantities are
// used only to recover how many units of that platform SKU were purchased.
export const SKU_GROSS_WEIGHT_CTES = `, order_sku_components AS MATERIALIZED (
    SELECT wdt_trade_no,platform_sku_id,erp_spec_no,sum(shipped_quantity) AS actual_qty
    FROM valued_lines GROUP BY wdt_trade_no,platform_sku_id,erp_spec_no
  ), order_sku_products AS MATERIALIZED (
    SELECT wdt_trade_no,platform_sku_id,
      count(DISTINCT platform_product_id)::integer AS product_count,
      bool_and(platform_product_id=ANY(__NON_MERCH_PARAM__::text[])) AS non_merchandise
    FROM valued_lines GROUP BY wdt_trade_no,platform_sku_id
  ), expected_sku_component_counts AS MATERIALIZED (
    SELECT platform_sku_id,count(*)::integer AS expected_count
    FROM master.current_platform_sku_components WHERE shop_key=$1 AND component_qty>0
    GROUP BY platform_sku_id
  ), order_sku_component_checks AS MATERIALIZED (
    SELECT a.wdt_trade_no,a.platform_sku_id,count(*)::integer AS observed_count,
      count(m.erp_spec_no)::integer AS matched_count,max(e.expected_count) AS expected_count,
      sum(a.actual_qty) AS total_shipped_component_qty,
      min(a.actual_qty/m.component_qty) AS min_units,
      max(a.actual_qty/m.component_qty) AS max_units,
      bool_or(a.erp_spec_no IS NULL OR a.actual_qty<=0 OR m.component_qty IS NULL OR m.component_qty<=0) AS invalid_component
    FROM order_sku_components a
    LEFT JOIN master.current_platform_sku_components m ON m.shop_key=$1
      AND m.platform_sku_id=a.platform_sku_id AND m.erp_spec_no=a.erp_spec_no
    LEFT JOIN expected_sku_component_counts e ON e.platform_sku_id=a.platform_sku_id
    GROUP BY a.wdt_trade_no,a.platform_sku_id
  ), order_sku_units AS MATERIALIZED (
    SELECT c.*,p.product_count,p.non_merchandise,
      CASE WHEN NOT invalid_component AND p.product_count=1 AND observed_count=matched_count
        AND observed_count=expected_count AND min_units=max_units
        AND min_units>0 AND min_units=trunc(min_units)
        THEN min_units END AS purchased_units
    FROM order_sku_component_checks c JOIN order_sku_products p
      ON p.wdt_trade_no=c.wdt_trade_no AND p.platform_sku_id IS NOT DISTINCT FROM c.platform_sku_id
  ), order_sku_weights AS MATERIALIZED (
    SELECT u.*,
      w.estimate_kg AS unit_gross_weight_kg,w.status AS weight_status,
      w.method AS weight_method,
      w.confidence_score,w.confidence_level,
      w.sample_count,w.run_id AS weight_run_id,
      CASE WHEN u.non_merchandise OR u.total_shipped_component_qty=0 THEN 0::numeric
        WHEN u.purchased_units IS NOT NULL AND w.estimate_kg>0
        AND ((w.status IN ('estimated','inferred') AND w.sample_count>0)
          OR w.status='manual-estimate')
        THEN u.purchased_units*w.estimate_kg END AS allocation_weight_kg
    FROM order_sku_units u LEFT JOIN master.current_platform_sku_gross_weights w
      ON w.shop_key=$1 AND w.platform_sku_id=u.platform_sku_id
  ), order_weight_totals AS MATERIALIZED (
    SELECT wdt_trade_no,sum(allocation_weight_kg) AS order_weight_kg,
      count(*) FILTER(WHERE allocation_weight_kg IS NULL)::integer AS missing_sku_count
    FROM order_sku_weights GROUP BY wdt_trade_no
  ), order_sku_line_counts AS MATERIALIZED (
    SELECT wdt_trade_no,platform_sku_id,count(*)::integer AS line_count,
      sum(shipped_quantity) AS shipped_quantity
    FROM valued_lines GROUP BY wdt_trade_no,platform_sku_id
  )`;

const SKU_GROSS_WEIGHT_COVERAGE_SQL = `WITH scoped_orders AS MATERIALIZED (
    SELECT h.wdt_trade_no FROM raw.wdt_order_headers h
    WHERE h.shop_key=$1 AND h.order_status_code=95
      AND (h.paid_at AT TIME ZONE 'Asia/Shanghai')::date BETWEEN $2::date AND $3::date
      ${excludePlaceholderOrder(4)}
      AND EXISTS (SELECT 1 FROM raw.shipments s WHERE s.shop_key=h.shop_key
        AND s.wdt_trade_no=h.wdt_trade_no AND nullif(trim(s.tracking_no),'') IS NOT NULL)
  ), pre_ship_refund_events AS MATERIALIZED (
    SELECT coalesce(oi.order_line_key,os.order_line_key) AS order_line_key,
      coalesce(l.refund_quantity,0) AS refund_quantity
    FROM raw.wdt_refund_headers h JOIN scoped_orders o USING(wdt_trade_no)
    JOIN raw.wdt_refund_lines l USING(shop_key,refund_no)
    LEFT JOIN LATERAL (
      SELECT order_line_key FROM raw.wdt_order_lines original
      WHERE original.shop_key=$1 AND original.wdt_trade_no=h.wdt_trade_no
        AND original.wdt_order_line_id=l.wdt_order_line_id
      ORDER BY order_line_key LIMIT 1
    ) oi ON true
    LEFT JOIN LATERAL (
      SELECT order_line_key FROM raw.wdt_order_lines original
      WHERE original.shop_key=$1 AND original.wdt_trade_no=h.wdt_trade_no
        AND original.source_order_line_id=l.source_order_line_id
      ORDER BY order_line_key LIMIT 1
    ) os ON oi.order_line_key IS NULL
    WHERE $8::boolean AND h.shop_key=$1 AND h.refund_type=1
      AND h.is_financially_refunded AND h.settled_at<=$7::timestamptz
  ), pre_ship_refund_quantities AS MATERIALIZED (
    SELECT order_line_key,sum(refund_quantity) AS refund_quantity
    FROM pre_ship_refund_events WHERE order_line_key IS NOT NULL GROUP BY order_line_key
  ), valued_lines AS MATERIALIZED (
    SELECT l.wdt_trade_no,l.platform_product_id,l.platform_sku_id,l.erp_spec_no,
      coalesce(l.quantity,0) AS quantity,
      CASE WHEN $8::boolean THEN greatest(0,coalesce(l.quantity,0)
        -least(coalesce(l.quantity,0),coalesce(r.refund_quantity,0)))
        ELSE coalesce(l.quantity,0) END AS shipped_quantity
    FROM raw.wdt_order_lines l JOIN scoped_orders o USING(wdt_trade_no)
    LEFT JOIN pre_ship_refund_quantities r ON r.order_line_key=l.order_line_key
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
  )
  SELECT count(*)::integer AS sku_groups,
    count(*) FILTER(WHERE allocation_weight_kg IS NOT NULL)::integer AS weighted_sku_groups,
    count(*) FILTER(WHERE allocation_weight_kg IS NULL)::integer AS missing_sku_groups,
    count(*) FILTER(WHERE allocation_weight_kg>0 AND weight_status='inferred')::integer AS inferred_sku_groups,
    count(*) FILTER(WHERE allocation_weight_kg>0 AND weight_method='platform-sku-gross-shared-residual-v1')::integer AS shared_inferred_sku_groups,
    count(*) FILTER(WHERE allocation_weight_kg>0 AND confidence_level='low')::integer AS low_confidence_sku_groups,
    count(DISTINCT wdt_trade_no)::integer AS orders,
    (SELECT count(*)::integer FROM order_weight_totals
      WHERE missing_sku_count>0 OR coalesce(order_weight_kg,0)<=0) AS missing_weight_orders,
    (SELECT round(coalesce(sum(f.freight_cost),0),2)::text
      FROM order_weight_totals o JOIN order_freight f USING(wdt_trade_no)
      WHERE o.missing_sku_count>0 OR coalesce(o.order_weight_kg,0)<=0) AS fallback_freight_amount,
    count(DISTINCT platform_sku_id) FILTER(WHERE allocation_weight_kg IS NULL)::integer AS missing_platform_skus,
    (SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) FROM (
      SELECT wdt_trade_no,platform_sku_id,observed_count,matched_count,expected_count,product_count,
        purchased_units,unit_gross_weight_kg,confidence_score,sample_count,
        CASE WHEN purchased_units IS NULL THEN 'component_mapping_or_quantity_mismatch'
          WHEN unit_gross_weight_kg IS NULL THEN 'sku_weight_missing'
          ELSE 'sku_weight_unusable' END AS reason
      FROM order_sku_weights WHERE allocation_weight_kg IS NULL
      ORDER BY wdt_trade_no,platform_sku_id LIMIT 50
    ) x) AS missing_examples
  FROM order_sku_weights`;

export function buildActualProfitQuery(groupBy='shop',policyVersion=ACTUAL_PROFIT_POLICY.version) {
  if (!ACTUAL_QUERY_GROUPS.has(groupBy)) throw new Error('--group-by 仅支持 shop|owner|product|day|report');
  const group = actualProfitGroupSql(groupBy);
  const precision = groupBy==='report' ? 4 : 2;
  const refundCostPolicy=hasReturnCostCredit(policyVersion);
  const weightPolicy=[ACTUAL_PROFIT_POLICY.version,REFUND_CREDIT_ACTUAL_PROFIT_POLICY.version,WEIGHT_ACTUAL_PROFIT_POLICY.version].includes(policyVersion);
  const originalPaymentPolicy=policyVersion===ACTUAL_PROFIT_POLICY.version;
  const revenueShare=`CASE WHEN l.paid_amount<>0 THEN l.line_revenue/l.paid_amount ELSE 1::numeric/l.order_line_count END`;
  const shippedRevenueWeight=`greatest(l.line_revenue,0)*l.shipped_quantity/nullif(l.quantity,0)`;
  const shippedRevenueShare=`CASE WHEN sum(${shippedRevenueWeight}) OVER(PARTITION BY l.wdt_trade_no)>0
    THEN ${shippedRevenueWeight}/sum(${shippedRevenueWeight}) OVER(PARTITION BY l.wdt_trade_no)
    WHEN sum(l.shipped_quantity) OVER(PARTITION BY l.wdt_trade_no)>0
    THEN l.shipped_quantity/sum(l.shipped_quantity) OVER(PARTITION BY l.wdt_trade_no)
    ELSE ${revenueShare} END`;
  const weightShare=`CASE WHEN ow.missing_sku_count=0 AND ow.order_weight_kg>0
      THEN ${refundCostPolicy?'sw.allocation_weight_kg/ow.order_weight_kg*coalesce(l.shipped_quantity/nullif(sc.shipped_quantity,0),0)':'sw.allocation_weight_kg/ow.order_weight_kg/sc.line_count'}
      ELSE ${refundCostPolicy?shippedRevenueShare:revenueShare} END`;
  const lineShare=weightPolicy?weightShare:revenueShare;
  const refundAdjustmentCtes=refundCostPolicy?`, refund_order_by_id AS MATERIALIZED (
    SELECT DISTINCT ON (wdt_order_line_id) wdt_order_line_id,order_line_key
    FROM raw_lines WHERE wdt_order_line_id IS NOT NULL ORDER BY wdt_order_line_id,order_line_key
  ), refund_order_by_source AS MATERIALIZED (
    SELECT DISTINCT ON (wdt_trade_no,source_order_line_id) wdt_trade_no,source_order_line_id,order_line_key
    FROM raw_lines WHERE source_order_line_id IS NOT NULL ORDER BY wdt_trade_no,source_order_line_id,order_line_key
  ), refund_cost_events AS MATERIALIZED (
    SELECT coalesce(oi.order_line_key,os.order_line_key) AS order_line_key,h.refund_type,
      coalesce(l.refund_quantity,0) AS refund_quantity
    FROM raw.wdt_refund_headers h JOIN scoped_orders o USING(wdt_trade_no)
    JOIN raw.wdt_refund_lines l USING(shop_key,refund_no)
    LEFT JOIN refund_order_by_id oi ON oi.wdt_order_line_id=l.wdt_order_line_id
    LEFT JOIN refund_order_by_source os ON os.wdt_trade_no=h.wdt_trade_no
      AND os.source_order_line_id=l.source_order_line_id
    WHERE h.shop_key=$1 AND h.is_financially_refunded AND h.settled_at<=$4::timestamptz
      AND h.refund_type IN (1,2)
  ), refund_cost_quantities AS MATERIALIZED (
    SELECT order_line_key,sum(refund_quantity) FILTER(WHERE refund_type=1) AS pre_ship_qty,
      sum(refund_quantity) FILTER(WHERE refund_type=2) AS returned_qty
    FROM refund_cost_events WHERE order_line_key IS NOT NULL GROUP BY order_line_key
  )`:'';
  return `WITH scoped_orders AS MATERIALIZED (
    SELECT h.wdt_trade_no,(h.paid_at AT TIME ZONE 'Asia/Shanghai')::date AS paid_date,
      ${originalPaymentPolicy?'h.real_amount+coalesce(h.refund_amount,0)':'h.paid_amount'} AS paid_amount
    FROM raw.wdt_order_headers h
    WHERE h.shop_key=$1 AND h.order_status_code=95
      AND (h.paid_at AT TIME ZONE 'Asia/Shanghai')::date BETWEEN $2::date AND $3::date
      ${excludePlaceholderOrder(13)}
  ), raw_lines AS MATERIALIZED (
    SELECT o.paid_date,o.paid_amount,l.order_line_key,l.wdt_order_line_id,l.source_order_line_id,l.wdt_trade_no,
      l.platform_product_id,l.platform_sku_id,l.erp_spec_no,coalesce(i.product_title,l.product_name) AS product_name,l.sku_name,
      i.image_url AS product_image_url,
      coalesce(l.quantity,0) AS quantity,coalesce(l.source_share_amount,l.source_line_paid,0) AS allocation_weight,
      l.source_goods_cost
    FROM scoped_orders o JOIN raw.wdt_order_lines l USING(wdt_trade_no)
    LEFT JOIN master.product_image_mappings i USING(platform_product_id)
    WHERE l.shop_key=$1
  )${refundAdjustmentCtes}, weighted_lines AS MATERIALIZED (
    SELECT l.*,sum(allocation_weight) OVER(PARTITION BY wdt_trade_no) AS order_weight,
      count(*) OVER(PARTITION BY wdt_trade_no) AS order_line_count
    FROM raw_lines l
  ), valued_lines AS MATERIALIZED (
    SELECT l.*,
      ${refundCostPolicy?`greatest(0,l.quantity-least(l.quantity,coalesce(r.pre_ship_qty,0)))`:'l.quantity'} AS shipped_quantity,
      ${refundCostPolicy?`least(l.quantity,coalesce(r.pre_ship_qty,0))`:'0::numeric'} AS pre_ship_refund_quantity,
      ${refundCostPolicy?`least(greatest(0,l.quantity-coalesce(r.pre_ship_qty,0)),coalesce(r.returned_qty,0))`:'0::numeric'} AS returned_refund_quantity,
      ${refundCostPolicy?`CASE WHEN platform_product_id=ANY($9::text[]) THEN 0
        WHEN current_cost.cost_status='available' AND current_cost.unit_cost>0
        THEN current_cost.unit_cost*quantity END`:'NULL::numeric'} AS gross_goods_cost,
      ${refundCostPolicy?`CASE WHEN platform_product_id=ANY($9::text[]) THEN 0
        WHEN current_cost.cost_status='available' AND current_cost.unit_cost>0
        THEN current_cost.unit_cost*least(quantity,coalesce(r.pre_ship_qty,0)) END`:'NULL::numeric'} AS pre_ship_cost_credit,
      ${refundCostPolicy?`CASE WHEN platform_product_id=ANY($9::text[]) THEN 0
        WHEN current_cost.cost_status='available' AND current_cost.unit_cost>0
        THEN current_cost.unit_cost*$14::numeric*least(greatest(0,quantity-coalesce(r.pre_ship_qty,0)),coalesce(r.returned_qty,0)) END`:'NULL::numeric'} AS return_cost_credit,
      CASE WHEN order_weight<>0 THEN paid_amount*allocation_weight/order_weight ELSE paid_amount/order_line_count END AS line_revenue,
      CASE WHEN platform_product_id=ANY($9::text[]) THEN 0
           WHEN $12::boolean THEN CASE WHEN current_cost.cost_status='available' AND current_cost.unit_cost>0
             THEN current_cost.unit_cost*(${refundCostPolicy?`quantity-least(quantity,coalesce(r.pre_ship_qty,0))
               -$14::numeric*least(greatest(0,quantity-coalesce(r.pre_ship_qty,0)),coalesce(r.returned_qty,0))`:'quantity'}) END
           WHEN source_goods_cost IS NOT NULL THEN source_goods_cost
           WHEN c.unit_cost IS NOT NULL THEN c.unit_cost*quantity END AS goods_cost,
      CASE WHEN platform_product_id=ANY($9::text[]) THEN 'explicit_zero'
           WHEN $12::boolean AND current_cost.cost_status='available' AND current_cost.unit_cost>0 THEN 'standard_reference'
           WHEN $12::boolean THEN 'missing'
           WHEN source_goods_cost IS NOT NULL THEN 'actual'
           WHEN c.unit_cost IS NOT NULL THEN 'standard_reference' ELSE 'missing' END AS cost_state
    FROM weighted_lines l LEFT JOIN LATERAL (
      SELECT unit_cost FROM master.sku_cost_versions c WHERE c.shop_key=$1 AND c.erp_spec_no=l.erp_spec_no
        AND c.status='approved' AND l.paid_date>=c.effective_from
        AND (c.effective_to IS NULL OR l.paid_date<=c.effective_to)
      ORDER BY c.effective_from DESC LIMIT 1
    ) c ON true
    LEFT JOIN master.current_sku_costs current_cost
      ON current_cost.shop_key=$1 AND current_cost.erp_spec_no=l.erp_spec_no
    ${refundCostPolicy?'LEFT JOIN refund_cost_quantities r ON r.order_line_key=l.order_line_key':''}
  )${weightPolicy?SKU_GROSS_WEIGHT_CTES.replaceAll('__NON_MERCH_PARAM__','$9'):''}, scoped_tracking AS MATERIALIZED (
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
      coalesce(f.freight_cost,0)*(${lineShare}) AS raw_freight_cost,
      coalesce(f.actual_freight,0)*(${lineShare}) AS raw_actual_freight,
      coalesce(f.estimated_freight,0)*(${lineShare}) AS raw_estimated_freight
    FROM valued_lines l LEFT JOIN order_freight f USING(wdt_trade_no)
    ${weightPolicy?`LEFT JOIN order_sku_weights sw ON sw.wdt_trade_no=l.wdt_trade_no
      AND sw.platform_sku_id IS NOT DISTINCT FROM l.platform_sku_id
    LEFT JOIN order_weight_totals ow ON ow.wdt_trade_no=l.wdt_trade_no
    LEFT JOIN order_sku_line_counts sc ON sc.wdt_trade_no=l.wdt_trade_no
      AND sc.platform_sku_id IS NOT DISTINCT FROM l.platform_sku_id`:''}
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
      sum(line_revenue) AS gross_revenue,sum(goods_cost) AS goods_cost,
      sum(gross_goods_cost) AS gross_goods_cost,sum(pre_ship_cost_credit) AS pre_ship_cost_credit,
      sum(return_cost_credit) AS return_cost_credit,sum(freight_cost) AS freight_cost,
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
      coalesce(s.gross_goods_cost,0) AS gross_goods_cost,
      coalesce(s.pre_ship_cost_credit,0) AS pre_ship_cost_credit,
      coalesce(s.return_cost_credit,0) AS return_cost_credit,
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
    round(sum(gross_goods_cost),${precision}) AS gross_goods_cost,
    round(sum(pre_ship_cost_credit),${precision}) AS pre_ship_cost_credit,
    round(sum(return_cost_credit),${precision}) AS return_cost_credit,
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
    nonMerchandiseProductIds,ownerOptionalProductIds,request.owners,
    request.policyVersion!==LEGACY_ACTUAL_PROFIT_POLICY.version,
    [ACTUAL_PROFIT_POLICY.version,REFUND_CREDIT_ACTUAL_PROFIT_POLICY.version,WEIGHT_ACTUAL_PROFIT_POLICY.version,REVENUE_ACTUAL_PROFIT_POLICY.version].includes(request.policyVersion)];
  if(hasReturnCostCredit(request.policyVersion)) params.push(request.returnResaleRate);
  const rows = (await client.query(buildActualProfitQuery(request.groupBy,request.policyVersion),params)).rows;
  const sections = request.groupBy==='report' ? {
    shop:rows.filter(row=>row.level==='shop'),owners:rows.filter(row=>row.level==='owner'),products:rows.filter(row=>row.level==='product'),
  } : undefined;
  const reconciliation = sections ? {
    ownerToShop:reconcileSection(sections.shop[0],sections.owners),
    productToShop:reconcileSection(sections.shop[0],sections.products),
  } : undefined;
  const paymentBridge=coverage.coverage.paymentBridge;
  const shippedSettledRefund=coverage.coverage.refunds.line_refund_amount;
  const paymentFlow={
    source:'wdt_order_and_settled_refund_facts',
    all_order_original_payment:paymentBridge.all_order_original_payment,
    cancelled_order_original_payment:paymentBridge.cancelled_original_payment,
    shipped_order_original_payment:paymentBridge.shipped_original_payment,
    shipped_order_settled_refund:shippedSettledRefund,
    net_sales:(Number(paymentBridge.shipped_original_payment)-Number(shippedSettledRefund)).toFixed(2),
    cancelled_order_settled_refund:paymentBridge.cancelled_settled_refund,
    cancelled_order_refund_residual:paymentBridge.cancelled_net_after_settled_refunds,
    formula:'全部订单还原支付原额 - 取消订单还原支付原额 = 已发货订单销售原额；已发货订单销售原额 - 对应已结算退款 = 净销售额',
  };
  let ownerPaymentFlows,productPaymentFlows;
  if(sections && request.policyVersion===ACTUAL_PROFIT_POLICY.version){
    const cancelledRows=(await client.query(OWNER_CANCELLED_PAYMENT_SQL,[
      args.shopKey,request.startDate,request.endDate,request.refundCutoff,
      nonMerchandiseProductIds,ownerOptionalProductIds,
    ])).rows;
    const cancelledByOwner=new Map(cancelledRows.filter(row=>row.level==='owner').map(row=>[row.owner_name,row]));
    const cancelledByProduct=new Map(cancelledRows.filter(row=>row.level==='product').map(row=>[row.platform_product_id,row]));
    const shippedByOwner=new Map(sections.owners.map(row=>[row.owner_name,row]));
    const shippedByProduct=new Map(sections.products.map(row=>[row.platform_product_id,row]));
    function paymentAmounts(shipped,cancelled){
      const shippedPayment=Number(shipped?.gross_revenue||0);
      const shippedRefund=Number(shipped?.refund_amount||0);
      const cancelledPayment=Number(cancelled?.cancelled_order_original_payment||0);
      const cancelledRefund=Number(cancelled?.cancelled_order_settled_refund||0);
      return {
        all_order_original_payment:(shippedPayment+cancelledPayment).toFixed(4),
        cancelled_order_original_payment:cancelledPayment.toFixed(4),
        shipped_order_original_payment:shippedPayment.toFixed(4),
        shipped_order_settled_refund:shippedRefund.toFixed(4),
        net_sales:(shippedPayment-shippedRefund).toFixed(4),
        cancelled_order_settled_refund:cancelledRefund.toFixed(4),
        cancelled_order_refund_residual:(cancelledPayment-cancelledRefund).toFixed(4),
      };
    }
    ownerPaymentFlows=[...new Set([...shippedByOwner.keys(),...cancelledByOwner.keys()])].sort().map(ownerName=>{
      return {owner_name:ownerName,...paymentAmounts(shippedByOwner.get(ownerName),cancelledByOwner.get(ownerName))};
    });
    productPaymentFlows=[...new Set([...shippedByProduct.keys(),...cancelledByProduct.keys()])].sort().map(productId=>{
      const shipped=shippedByProduct.get(productId),cancelled=cancelledByProduct.get(productId);
      return {
        platform_product_id:productId,
        product_name:shipped?.product_name??cancelled?.product_name??'未知商品',
        product_image_url:shipped?.product_image_url??cancelled?.product_image_url??null,
        owner_name:shipped?.owner_name??cancelled?.owner_name??'未分配负责人',
        cancelled_only:Number(shipped?.gross_revenue||0)===0 && Number(cancelled?.cancelled_order_original_payment||0)>0,
        ...paymentAmounts(shipped,cancelled),
      };
    });
    for(const field of ['all_order_original_payment','cancelled_order_original_payment',
      'shipped_order_original_payment','shipped_order_settled_refund','net_sales',
      'cancelled_order_settled_refund','cancelled_order_refund_residual']){
      for(const [dimension,flows] of [['负责人',ownerPaymentFlows],['商品',productPaymentFlows]]){
        const total=flows.reduce((sum,row)=>sum+Number(row[field]),0);
        if(Math.abs(total-Number(paymentFlow[field]))>0.01){
          throw new Error(`${dimension}支付桥接未与全店对齐：${field}，明细合计 ${total.toFixed(4)}，全店 ${paymentFlow[field]}`);
        }
      }
    }
  }
  return {
    mode:'live-read-only',calculationPerformed:true,shopKey:args.shopKey,shopName:coverage.shopName,
    period:coverage.period,policy:coverage.coverage.policy,status:coverage.status,groupBy:request.groupBy,owners:request.owners,
    ...(request.policyVersion===ACTUAL_PROFIT_POLICY.version?{paymentFlow}:{}),
    ...(ownerPaymentFlows?{ownerPaymentFlows}:{}),
    ...(productPaymentFlows?{productPaymentFlows}:{}),
    quality:{blockingGaps:coverage.blockingGaps,advisoryGaps:coverage.advisoryGaps,
      orderCoverageComplete:coverage.coverage.orders.complete,refundCoverageComplete:coverage.coverage.refundSource.complete,
      costBasis:coverage.coverage.costs.basis,costSyncBatch:coverage.coverage.costs.latestSync??null,
      freightAllocation:{method:coverage.coverage.freightWeightAllocation.method,
        status:coverage.coverage.freightWeightAllocation.status,
        missingWeightOrders:coverage.coverage.freightWeightAllocation.missing_weight_orders??0,
        missingSkuGroups:coverage.coverage.freightWeightAllocation.missing_sku_groups??0,
        inferredSkuGroups:coverage.coverage.freightWeightAllocation.inferred_sku_groups??0,
        sharedInferredSkuGroups:coverage.coverage.freightWeightAllocation.shared_inferred_sku_groups??0,
        fallbackFreightAmount:coverage.coverage.freightWeightAllocation.fallback_freight_amount??'0.00',
        latestWeightRun:coverage.coverage.freightWeightAllocation.latestWeightRun??null},
      ignoredPlaceholderOrders:coverage.coverage.orderScope.ignored_placeholder_orders,
      paymentBridge:coverage.coverage.paymentBridge,
      missingCostLines:coverage.coverage.costs.missing_lines,estimatedFreightAmount:coverage.coverage.freight.estimated_freight_amount,
      unmappedRefundAmount:coverage.coverage.refunds.unmapped_refund_amount,unassignedOwnerProducts:coverage.coverage.owners.review_unassigned_products},
    ...(sections?{sections,reconciliation}:{rows}),
  };
}
