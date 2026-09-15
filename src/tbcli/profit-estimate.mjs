import fs from 'node:fs';
import path from 'node:path';
import ExcelJS from '@excel.js/exceljs';
import {getProfitOrderCoverage} from './profit-orders.mjs';
import {getProfitRefundCoverage} from './profit-refunds.mjs';

export function formatProfitDate(value){const text=String(value??'');const exact=text.match(/^\d{4}-\d{2}-\d{2}/);if(exact)return exact[0];const date=value instanceof Date?value:new Date(value);if(Number.isNaN(date.getTime()))throw new Error(`无法识别利润日期：${text}`);const parts=new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date);const fields=Object.fromEntries(parts.map(part=>[part.type,part.value]));return `${fields.year}-${fields.month}-${fields.day}`;}
export function normalizeProfitOwners({owner,owners}={}){if(owner&&owners)throw new Error('--owner 与 --owners 不能同时使用');const raw=owner?[owner]:String(owners||'').split(/[,，]/);const selected=[...new Set(raw.map(v=>String(v).trim()).filter(Boolean))];if(owners&&!selected.length)throw new Error('--owners 至少需要一个负责人姓名');return selected;}
export const PROFIT_COLUMN_LABELS=Object.freeze({stat_month:'统计月份',available_days:'有数据天数',first_date:'首个数据日期',last_date:'末个数据日期',stat_date:'统计日期',shop_key:'店铺键',shop_name:'店铺名称',platform_product_id:'商品ID',product_name:'商品名称',owner_name:'负责人',gross_revenue:'订单实付收入',refund_amount:'当日结算退款',net_sales:'净销售额',goods_cost:'商品成本',freight_cost:'预估运费',ad_spend:'推广费',platform_fee:'平台费',tax_cost:'税费',estimated_profit:'预估利润',profit_margin:'预估利润率',product_order_count:'商品订单关系数',quantity:'商品数量',cost_fallback_amount:'成本估算金额',freight_fallback_amount:'运费兜底金额'});
export const PROFIT_RULE_ROWS=[['口径','内容'],['版本','每日预估利润第一版'],['收入','旺店通支付日、订单状态为有效完成状态的实付收入，按商品分配'],['退款','退款平台状态为已完成、有结算时间且实际退款金额大于零；按结算日和商品计入'],['成本','优先旺店通商品成本，其次生效的商品成本主数据，仍缺失时按商品收入的50%估算'],['运费','订单全部商品均有可用运费估算时使用商品估算，否则整单按2元估算并按商品收入占比分配'],['推广费','无界商品主体、15天转化、主体类型为商品的花费'],['平台费','净销售额的6%'],['税费','净销售额的2%'],['负责人','按统计日匹配生效且已审核的商品负责人；未匹配部分保留为未分配负责人'],['说明','本表为经营预估，不是次月15日正式月结']];

export function validateProfitRequest(args) {
  if(args.runId) throw new Error('请使用 --shop-key、--start-date 和 --end-date 查询当前数据');
  if(!args.shopKey) throw new Error('缺少 --shop-key');
  const valid=v=>typeof v==='string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0,10)===v;
  if(!valid(args.startDate)||!valid(args.endDate)||args.startDate>args.endDate) throw new Error('需要有效且完整的 --start-date 和 --end-date');
  const policy={platformFeeRate:Number(args.platformFeeRate??0.06),taxRate:Number(args.taxRate??0.02),missingCostRate:Number(args.missingCostRate??0.5),fallbackFreight:Number(args.fallbackFreight??2)};
  for(const [key,value] of Object.entries(policy)) if(!Number.isFinite(value)||value<0||(key!=='fallbackFreight'&&value>1)) throw new Error('费率须在0到1之间，运费须为非负有限数');
  normalizeProfitOwners(args);
  return policy;
}

const GROUPS={
  shop:{select:[],group:[],order:'estimated_profit DESC'},
  owner:{select:['owner_name'],group:['owner_name'],order:'owner_name'},
  product:{select:['platform_product_id','product_name','owner_name'],group:['platform_product_id','product_name','owner_name'],order:'platform_product_id'},
  day:{select:['stat_date::text AS stat_date'],group:['stat_date'],order:'stat_date'},
  month:{select:["to_char(stat_date,'YYYY-MM') AS stat_month"],group:["to_char(stat_date,'YYYY-MM')"],order:'stat_month'},
  'owner-month':{select:["to_char(stat_date,'YYYY-MM') AS stat_month",'owner_name'],group:["to_char(stat_date,'YYYY-MM')",'owner_name'],order:'stat_month,owner_name'}
};

export function buildProfitQuery(groupBy='day') {
  const g=GROUPS[groupBy];
  if(!g) throw new Error('--group-by 仅支持 shop|owner|product|day|month|owner-month');
  return `WITH eligible_dates AS (SELECT DISTINCT stat_date FROM raw.sycm_rows WHERE dataset_key='wujie-subject' AND shop_name=$2 AND conversion_cycle='15天转化' AND subject_type='商品' AND stat_date BETWEEN $3 AND $4),
base_lines AS (SELECT (h.paid_at AT TIME ZONE 'Asia/Shanghai')::date d,h.wdt_trade_no,l.platform_product_id,coalesce(l.product_name,'未知商品') product_name,coalesce(l.quantity,0) qty,coalesce(l.source_share_amount,l.source_line_paid,0) revenue,l.source_goods_cost,l.erp_spec_no,l.platform_sku_id FROM raw.wdt_order_headers h JOIN raw.wdt_order_lines l USING(shop_key,wdt_trade_no) JOIN eligible_dates e ON e.stat_date=(h.paid_at AT TIME ZONE 'Asia/Shanghai')::date WHERE h.shop_key=$1 AND h.order_status_code=95 AND l.platform_product_id IS NOT NULL),
line_calc AS (SELECT b.*,coalesce(b.source_goods_cost,mc.unit_cost*b.qty,b.revenue*$7) cost,CASE WHEN b.source_goods_cost IS NULL AND mc.unit_cost IS NULL THEN b.revenue*$7 ELSE 0 END cost_fb,mf.estimated_freight sku_freight FROM base_lines b LEFT JOIN LATERAL(SELECT unit_cost FROM master.sku_cost_versions m WHERE m.shop_key=$1 AND m.erp_spec_no=b.erp_spec_no AND m.status='approved' AND b.d>=m.effective_from AND (m.effective_to IS NULL OR b.d<=m.effective_to) ORDER BY m.effective_from DESC LIMIT 1)mc ON true LEFT JOIN LATERAL(SELECT estimated_freight FROM master.platform_sku_freight_versions f WHERE f.shop_key=$1 AND f.platform_product_id=b.platform_product_id AND f.platform_sku_id=b.platform_sku_id AND f.status='approved' AND f.usable_for_profit AND b.d>=f.effective_from AND (f.effective_to IS NULL OR b.d<=f.effective_to) ORDER BY f.effective_from DESC LIMIT 1)mf ON true),
order_calc AS (SELECT d,wdt_trade_no,sum(revenue) order_revenue,count(*) line_count,CASE WHEN bool_and(sku_freight IS NOT NULL) THEN sum(sku_freight*qty) ELSE $8 END order_freight,CASE WHEN bool_and(sku_freight IS NOT NULL) THEN 0 ELSE $8 END freight_fb FROM line_calc GROUP BY 1,2),
sales AS (SELECT l.d,l.platform_product_id,max(l.product_name) product_name,sum(l.revenue) gross_revenue,sum(l.cost) goods_cost,sum(l.cost_fb) cost_fb,sum(CASE WHEN o.order_revenue<>0 THEN o.order_freight*l.revenue/o.order_revenue ELSE o.order_freight/o.line_count END) freight_cost,sum(CASE WHEN o.order_revenue<>0 THEN o.freight_fb*l.revenue/o.order_revenue ELSE o.freight_fb/o.line_count END) freight_fb,count(DISTINCT l.wdt_trade_no) orders,sum(l.qty) qty FROM line_calc l JOIN order_calc o USING(d,wdt_trade_no) GROUP BY 1,2),
order_lookup AS MATERIALIZED (SELECT wdt_order_line_id,source_order_line_id,wdt_trade_no,platform_product_id,product_name,order_line_key FROM raw.wdt_order_lines WHERE shop_key=$1),
order_by_id AS (SELECT DISTINCT ON (wdt_order_line_id) * FROM order_lookup WHERE wdt_order_line_id IS NOT NULL ORDER BY wdt_order_line_id,order_line_key),
order_by_source AS (SELECT DISTINCT ON (wdt_trade_no,source_order_line_id) * FROM order_lookup WHERE source_order_line_id IS NOT NULL ORDER BY wdt_trade_no,source_order_line_id,order_line_key),
refund_lines AS (SELECT (h.settled_at AT TIME ZONE 'Asia/Shanghai')::date d,coalesce(l.platform_product_id,CASE WHEN oi.wdt_order_line_id IS NOT NULL THEN oi.platform_product_id ELSE os.platform_product_id END,'__UNMAPPED_REFUND__') platform_product_id,coalesce(l.product_name,CASE WHEN oi.wdt_order_line_id IS NOT NULL THEN oi.product_name ELSE os.product_name END,'无法归属商品的退款') product_name,coalesce(l.actual_refund_amount,0) amount FROM raw.wdt_refund_headers h JOIN raw.wdt_refund_lines l USING(shop_key,refund_no) LEFT JOIN order_by_id oi ON oi.wdt_order_line_id=l.wdt_order_line_id LEFT JOIN order_by_source os ON os.source_order_line_id=l.source_order_line_id AND os.wdt_trade_no=h.wdt_trade_no JOIN eligible_dates e ON e.stat_date=(h.settled_at AT TIME ZONE 'Asia/Shanghai')::date WHERE h.shop_key=$1 AND h.is_financially_refunded),
refunds AS (SELECT d,platform_product_id,max(product_name) product_name,sum(amount) refund_amount FROM refund_lines GROUP BY 1,2),
ads AS (SELECT stat_date d,subject_id platform_product_id,max(subject_name) product_name,sum(CASE WHEN replace(coalesce(row_data->>'花费','0'),',','') ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN replace(row_data->>'花费',',','')::numeric ELSE 0 END) ad_spend FROM raw.sycm_rows WHERE dataset_key='wujie-subject' AND shop_name=$2 AND conversion_cycle='15天转化' AND subject_type='商品' AND stat_date BETWEEN $3 AND $4 GROUP BY 1,2),
keys AS (SELECT d,platform_product_id FROM sales UNION SELECT d,platform_product_id FROM refunds UNION SELECT d,platform_product_id FROM ads),
joined AS (SELECT k.d,k.platform_product_id,coalesce(s.product_name,r.product_name,a.product_name,'未知商品') product_name,coalesce(s.gross_revenue,0) gross_revenue,coalesce(r.refund_amount,0) refund_amount,coalesce(s.goods_cost,0) goods_cost,coalesce(s.freight_cost,0) freight_cost,coalesce(a.ad_spend,0) ad_spend,coalesce(s.orders,0) orders,coalesce(s.qty,0) qty,coalesce(s.cost_fb,0) cost_fb,coalesce(s.freight_fb,0) freight_fb FROM keys k LEFT JOIN sales s USING(d,platform_product_id) LEFT JOIN refunds r USING(d,platform_product_id) LEFT JOIN ads a USING(d,platform_product_id)),
daily AS (
SELECT j.d AS stat_date,j.platform_product_id,j.product_name,coalesce(o.owner_name,'未分配负责人') AS owner_name,
j.gross_revenue,j.refund_amount,j.gross_revenue-j.refund_amount AS net_sales,j.goods_cost,j.freight_cost,j.ad_spend,
(j.gross_revenue-j.refund_amount)*$5 AS platform_fee,(j.gross_revenue-j.refund_amount)*$6 AS tax_cost,
(j.gross_revenue-j.refund_amount)-j.goods_cost-j.freight_cost-j.ad_spend-(j.gross_revenue-j.refund_amount)*$5-(j.gross_revenue-j.refund_amount)*$6 AS estimated_profit,
j.orders AS order_count,j.qty AS quantity,j.cost_fb AS cost_fallback_amount,j.freight_fb AS freight_fallback_amount
FROM joined j LEFT JOIN LATERAL(SELECT owner_name FROM master.product_owner_versions p WHERE p.shop_key=$1 AND p.platform_product_id=j.platform_product_id AND p.status='approved' AND j.d>=p.effective_from AND (p.effective_to IS NULL OR j.d<=p.effective_to) ORDER BY p.effective_from DESC LIMIT 1)o ON true)
SELECT ${g.select.length?g.select.join(',')+',':''}
count(DISTINCT stat_date)::integer AS available_days,min(stat_date)::text AS first_date,max(stat_date)::text AS last_date,
round(sum(gross_revenue),2) AS gross_revenue,round(sum(refund_amount),2) AS refund_amount,
round(sum(net_sales),2) AS net_sales,round(sum(goods_cost),2) AS goods_cost,round(sum(freight_cost),2) AS freight_cost,
round(sum(ad_spend),2) AS ad_spend,round(sum(platform_fee),2) AS platform_fee,round(sum(tax_cost),2) AS tax_cost,
round(sum(estimated_profit),2) AS estimated_profit,
CASE WHEN sum(net_sales)=0 THEN NULL ELSE round(sum(estimated_profit)/sum(net_sales),4) END AS profit_margin,
sum(order_count)::bigint AS product_order_count,round(sum(quantity),2) AS quantity,
round(sum(cost_fallback_amount),2) AS cost_fallback_amount,round(sum(freight_fallback_amount),2) AS freight_fallback_amount
FROM daily WHERE (cardinality($9::text[])=0 OR owner_name=ANY($9::text[]))
${g.group.length?'GROUP BY '+g.group.join(','):''} HAVING count(*)>0 ORDER BY ${g.order}`;
}

async function prepareProfit(c,args) {
  const policy=validateProfitRequest(args);
  buildProfitQuery(args.groupBy||'day');
  const name=await c.query('SELECT shop_name FROM raw.wdt_order_headers WHERE shop_key=$1 ORDER BY observed_at DESC LIMIT 1',[args.shopKey]);
  if(!name.rows.length) throw new Error('没有找到该店铺的订单事实');
  const shopName=name.rows[0].shop_name.replace(/^天猫\s*/,'');
  const ad=await c.query("SELECT DISTINCT stat_date::text FROM raw.sycm_rows WHERE dataset_key='wujie-subject' AND shop_name=$1 AND conversion_cycle='15天转化' AND subject_type='商品' AND stat_date BETWEEN $2 AND $3 ORDER BY 1",[shopName,args.startDate,args.endDate]);
  const eligibleDates=ad.rows.map(r=>r.stat_date),present=new Set(eligibleDates),skippedDates=[];
  for(let d=Date.parse(args.startDate),end=Date.parse(args.endDate);d<=end;d+=86400000){const day=new Date(d).toISOString().slice(0,10);if(!present.has(day))skippedDates.push(day);}
  const orders=await getProfitOrderCoverage(c,args),refunds=await getProfitRefundCoverage(c,args);
  return {mode:'live-read-only',shopKey:args.shopKey,shopName,period:{startDate:args.startDate,endDate:args.endDate},policy,
    eligibleDates,skippedDates,coverage:{ordersComplete:orders.complete,orderMissingPeriods:orders.missingPeriods,refundsComplete:refunds.complete,refundMissingPeriods:refunds.missingPeriods,refundDateBasis:'申请日覆盖，不能单独证明结算日完整'},
    complete:orders.complete&&refunds.complete&&skippedDates.length===0,
    ...(eligibleDates.length?{}:{reason:'AD_DATA_NOT_AVAILABLE'})};
}
async function queryPrepared(c,args,info) {
  const groupBy=args.groupBy||'day',owners=normalizeProfitOwners(args),p=info.policy;
  const rows=info.eligibleDates.length?(await c.query(buildProfitQuery(groupBy),[info.shopKey,info.shopName,args.startDate,args.endDate,p.platformFeeRate,p.taxRate,p.missingCostRate,p.fallbackFreight,owners])).rows:[];
  return {...info,groupBy,owners,rows};
}
export async function getProfitEstimate(c,args) {
  return queryPrepared(c,args,await prepareProfit(c,args));
}

export async function exportProfitEstimate(c,args) {
  if(!args.out) throw new Error('缺少 --out');
  const out=path.resolve(args.out);
  if(fs.existsSync(out)) throw new Error('拒绝覆盖已有文件：'+out);
  const info=await prepareProfit(c,args);
  const wb=new ExcelJS.Workbook();wb.creator='tbcli';wb.created=new Date();
  for(const [name,groupBy] of [['摘要','shop'],['负责人汇总','owner'],['负责人月度对比','owner-month'],['商品汇总','product'],['每日明细','day']]){
    const data=await queryPrepared(c,{...args,groupBy},info),ws=wb.addWorksheet(name,{views:[{state:'frozen',ySplit:1}]});
    const keys=data.rows.length?Object.keys(data.rows[0]):['无数据'];
    ws.columns=keys.map(key=>({header:PROFIT_COLUMN_LABELS[key]||key,key,width:key==='product_name'?34:20}));ws.addRows(data.rows);
    ws.getRow(1).font={bold:true,color:{argb:'FFFFFFFF'}};
    ws.getRow(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF1F4E78'}};
    for(const key of keys)if(/revenue|amount|cost|spend|fee|sales|estimated_profit/.test(key))ws.getColumn(key).numFmt='#,##0.00;[Red]-#,##0.00';
    if(keys.includes('profit_margin'))ws.getColumn('profit_margin').numFmt='0.00%;[Red]-0.00%';
  }
  const rules=wb.addWorksheet('计算规则');
  rules.addRows(PROFIT_RULE_ROWS.filter(r=>!['平台费','税费','成本','运费'].includes(r[0])));
  rules.addRows([['平台费率',String(info.policy.platformFeeRate)],['税率',String(info.policy.taxRate)],['成本缺失估算比例',String(info.policy.missingCostRate)],['运费兜底',String(info.policy.fallbackFreight)],['查询日期',args.startDate+' 至 '+args.endDate],['跳过日期',info.skippedDates.join('、')||'无'],['订单缺期',JSON.stringify(info.coverage.orderMissingPeriods)],['退款申请日缺期',JSON.stringify(info.coverage.refundMissingPeriods)],['退款覆盖口径',info.coverage.refundDateBasis]]);
  rules.columns=[{width:24},{width:90}];
  const buffer=await wb.xlsx.writeBuffer();
  await fs.promises.writeFile(out,buffer,{flag:'wx'});
  return {...info,out,owners:normalizeProfitOwners(args),sheets:wb.worksheets.map(s=>s.name)};
}
