#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const NON_OWNER_GROUPS = new Set(['无法归属', '未分配负责人', '已下架未分配', '不归属负责人', '未分配']);

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--shop-key') options.shopKey = argv[++index];
    else if (key === '--month') options.month = argv[++index];
    else if (key === '--out') options.out = argv[++index];
    else if (key === '--tbcli-entry') options.tbcliEntry = argv[++index];
    else if (key === '--tbcli-bin') options.tbcliBin = argv[++index];
    else throw new Error(`不支持的参数：${key}`);
  }
  if (!options.shopKey || !/^\d{4}-(0[1-9]|1[0-2])$/.test(options.month || '') || !options.out) {
    throw new Error('需要 --shop-key、有效 --month YYYY-MM 和 --out');
  }
  return options;
}

function runTbcli(args, options) {
  const command = options.tbcliEntry ? process.execPath : (options.tbcliBin || 'tbcli');
  const commandArgs = options.tbcliEntry ? [path.resolve(options.tbcliEntry), ...args] : args;
  const result = spawnSync(command, commandArgs, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || `tbcli 退出码 ${result.status}`).trim());
  try { return JSON.parse(result.stdout.trim()); } catch { throw new Error('tbcli 没有返回有效 JSON'); }
}

function validatePayload(payload) {
  if (payload?.calculationPerformed !== true) throw new Error('实际利润查询没有执行计算');
  if (!Array.isArray(payload?.sections?.shop) || payload.sections.shop.length !== 1) throw new Error('报告数据缺少唯一全店汇总');
  if (!Array.isArray(payload?.sections?.owners) || !Array.isArray(payload?.sections?.products)) throw new Error('报告数据缺少负责人或商品分区');
  if (payload.quality?.blockingGaps?.length) throw new Error(`PROFIT_DATA_INCOMPLETE: ${JSON.stringify(payload.quality.blockingGaps)}`);
  if (!payload.reconciliation?.ownerToShop?.passed || !payload.reconciliation?.productToShop?.passed) throw new Error(`RECONCILIATION_FAILED: ${JSON.stringify(payload.reconciliation)}`);
  const flow = payload.paymentFlow;
  if (!flow || payload.period?.policyVersion !== 'operating-profit-v6') throw new Error('报告缺少 v6 支付金额桥接');
  const near = (left, right) => Math.abs(Number(left) - Number(right)) <= 0.01;
  if (!near(Number(flow.all_order_original_payment) - Number(flow.cancelled_order_original_payment), flow.shipped_order_original_payment)
      || !near(Number(flow.shipped_order_original_payment) - Number(flow.shipped_order_settled_refund), flow.net_sales)
      || !near(flow.shipped_order_original_payment, payload.sections.shop[0].gross_revenue)
      || !near(flow.shipped_order_settled_refund, payload.sections.shop[0].refund_amount)
      || !near(flow.net_sales, payload.sections.shop[0].net_sales)) throw new Error('PAYMENT_RECONCILIATION_FAILED: 支付桥接与全店利润不一致');
  if (!Array.isArray(payload.ownerPaymentFlows)) throw new Error('报告缺少负责人支付金额桥接');
  const ownerFlows = new Map(payload.ownerPaymentFlows.map((row) => [row.owner_name, row]));
  if (ownerFlows.size !== payload.ownerPaymentFlows.length) throw new Error('OWNER_PAYMENT_RECONCILIATION_FAILED: 负责人重复');
  for (const row of payload.sections.owners) {
    const ownerFlow = ownerFlows.get(row.owner_name);
    if (!ownerFlow || !near(ownerFlow.shipped_order_original_payment, row.gross_revenue)
        || !near(ownerFlow.shipped_order_settled_refund, row.refund_amount)
        || !near(ownerFlow.net_sales, row.net_sales)
        || !near(Number(ownerFlow.all_order_original_payment) - Number(ownerFlow.cancelled_order_original_payment), ownerFlow.shipped_order_original_payment)) {
      throw new Error(`OWNER_PAYMENT_RECONCILIATION_FAILED: ${row.owner_name}`);
    }
  }
  for (const field of ['all_order_original_payment', 'cancelled_order_original_payment', 'shipped_order_original_payment',
    'shipped_order_settled_refund', 'net_sales', 'cancelled_order_settled_refund', 'cancelled_order_refund_residual']) {
    if (!near(payload.ownerPaymentFlows.reduce((sum, row) => sum + Number(row[field]), 0), flow[field])) {
      throw new Error(`OWNER_PAYMENT_RECONCILIATION_FAILED: ${field} 合计与全店不一致`);
    }
  }
  if (!Array.isArray(payload.productPaymentFlows)) throw new Error('报告缺少商品支付金额桥接');
  const productFlows = new Map(payload.productPaymentFlows.map((row) => [row.platform_product_id, row]));
  if (productFlows.size !== payload.productPaymentFlows.length) throw new Error('PRODUCT_PAYMENT_RECONCILIATION_FAILED: 商品 ID 重复');
  for (const row of payload.sections.products) {
    const productFlow = productFlows.get(row.platform_product_id);
    if (!productFlow || !near(productFlow.shipped_order_original_payment, row.gross_revenue)
        || !near(productFlow.shipped_order_settled_refund, row.refund_amount)
        || !near(productFlow.net_sales, row.net_sales)
        || !near(Number(productFlow.all_order_original_payment) - Number(productFlow.cancelled_order_original_payment), productFlow.shipped_order_original_payment)) {
      throw new Error(`PRODUCT_PAYMENT_RECONCILIATION_FAILED: ${row.platform_product_id}`);
    }
  }
  for (const field of ['all_order_original_payment', 'cancelled_order_original_payment', 'shipped_order_original_payment',
    'shipped_order_settled_refund', 'net_sales', 'cancelled_order_settled_refund', 'cancelled_order_refund_residual']) {
    if (!near(payload.productPaymentFlows.reduce((sum, row) => sum + Number(row[field]), 0), flow[field])) {
      throw new Error(`PRODUCT_PAYMENT_RECONCILIATION_FAILED: ${field} 合计与全店不一致`);
    }
  }
  for (const ownerFlow of payload.ownerPaymentFlows) {
    const products = payload.productPaymentFlows.filter((row) => row.owner_name === ownerFlow.owner_name);
    for (const field of ['all_order_original_payment', 'cancelled_order_original_payment']) {
      if (!near(products.reduce((sum, row) => sum + Number(row[field]), 0), ownerFlow[field])) {
        throw new Error(`PRODUCT_OWNER_PAYMENT_ATTRIBUTION_MISMATCH: ${ownerFlow.owner_name} 的商品${field}合计与负责人不一致`);
      }
    }
  }
}

const number = (value) => Number(value || 0);
const nullableNumber = (value) => value == null ? null : Number(value);
const safeProductId = (value) => value === '__UNMAPPED_ORDER_LINE__' ? '未映射订单明细' : value === '__UNMAPPED_REFUND__' ? '未映射退款' : String(value || '未知');

function httpsImageUrl(value) {
  if (!value) return null;
  let candidate = String(value).trim();
  if (candidate.startsWith('//')) candidate = `https:${candidate}`;
  if (candidate.startsWith('http://')) candidate = `https://${candidate.slice(7)}`;
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
}

function product(row, flow) {
  const netSales = number(row.net_sales);
  const adSpend = number(row.ad_spend);
  return {
    id: safeProductId(row.platform_product_id),
    name: row.product_name || '未知商品',
    owner: row.owner_name || '未分配负责人',
    cancelled_only: Boolean(flow.cancelled_only),
    image_url: httpsImageUrl(row.product_image_url),
    all_order_original_payment: number(flow.all_order_original_payment),
    cancelled_order_original_payment: number(flow.cancelled_order_original_payment),
    gross_revenue: number(row.gross_revenue),
    refund_amount: number(row.refund_amount),
    net_sales: netSales,
    goods_cost: number(row.goods_cost),
    freight_cost: number(row.freight_cost),
    ad_spend: adSpend,
    post_refund_paid_ratio: netSales === 0 ? null : adSpend / netSales,
    actual_profit: number(row.actual_profit),
    profit_margin: nullableNumber(row.profit_margin),
  };
}

function paymentFlow(row) {
  return Object.fromEntries(['all_order_original_payment', 'cancelled_order_original_payment',
    'shipped_order_original_payment', 'shipped_order_settled_refund', 'net_sales',
    'cancelled_order_settled_refund', 'cancelled_order_refund_residual'].map((field) => [field, number(row[field])]));
}

function summary(row, name, productCount, flow) {
  return {
    name,
    gross_revenue: number(row.gross_revenue),
    refund_amount: number(row.refund_amount),
    net_sales: number(row.net_sales),
    goods_cost: number(row.goods_cost),
    freight_cost: number(row.freight_cost),
    actual_freight_amount: number(row.actual_freight_amount),
    estimated_freight_amount: number(row.estimated_freight_amount),
    ad_spend: number(row.ad_spend),
    platform_fee: number(row.platform_fee),
    tax_cost: number(row.tax_cost),
    actual_profit: number(row.actual_profit),
    profit_margin: nullableNumber(row.profit_margin),
    product_count: productCount,
    ...(flow ? { payment_flow: paymentFlow(flow) } : {}),
  };
}

function slugOwner(index) {
  return `owner-${index + 1}`;
}

function qualityText(item) {
  const details = Object.entries(item).filter(([key]) => key !== 'code').map(([key, value]) => `${key}=${typeof value === 'object' ? JSON.stringify(value) : value}`).join('；');
  return `${item.code}${details ? `：${details}` : ''}`;
}

function buildViewModel(payload) {
  const productFlows = new Map(payload.productPaymentFlows.map((row) => [row.platform_product_id, row]));
  const shippedProductIds = new Set(payload.sections.products.map((row) => row.platform_product_id));
  const productRows = [
    ...payload.sections.products.map((row) => product(row, productFlows.get(row.platform_product_id))),
    ...payload.productPaymentFlows.filter((row) => !shippedProductIds.has(row.platform_product_id)).map((row) => product(row, row)),
  ];
  const ownerFlows = new Map(payload.ownerPaymentFlows.map((row) => [row.owner_name, row]));
  const shippedOwnerNames = new Set(payload.sections.owners.map((row) => row.owner_name));
  const allOwnerRows = [...payload.sections.owners,
    ...payload.ownerPaymentFlows.filter((row) => !shippedOwnerNames.has(row.owner_name)).map((row) => ({ owner_name: row.owner_name }))];
  const ownerRows = allOwnerRows.filter((row) => !NON_OWNER_GROUPS.has(row.owner_name || '未分配负责人'));
  const unownedRows = allOwnerRows.filter((row) => NON_OWNER_GROUPS.has(row.owner_name || '未分配负责人'));
  const owners = ownerRows.map((row, index) => {
    const name = row.owner_name;
    const products = productRows.filter((item) => item.owner === name);
    return { id: slugOwner(index), name, summary: summary(row, name, products.length, ownerFlows.get(name)), products };
  });
  const unownedNames = new Set(unownedRows.map((row) => row.owner_name || '未分配负责人'));
  const unownedProducts = productRows.filter((item) => unownedNames.has(item.owner));
  const shopRow = payload.sections.shop[0];
  const status = payload.status === 'actual/reconciled' ? '实际费用已核对' : '含已确认估算';
  const missingImageCount = productRows.filter((item) => !item.image_url).length;
  return {
    contract: 'monthly-profit-review@1.0',
    meta: {
      title: `${payload.shopName} ${payload.period.month} 实际利润分析`,
      shop_name: payload.shopName,
      month: payload.period.month,
      date_range: `${payload.period.startDate} — ${payload.period.endDate}`,
      status,
      external_images: 'allow_https',
      footer: `数据由 tbcli 实际利润口径生成｜退款观察截止 ${payload.period.refundCutoffDate}｜${status}`,
      source_payload_sha256: crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
    },
    shop: summary(shopRow, '全店', productRows.length),
    payment_flow: paymentFlow(payload.paymentFlow),
    owners,
    unowned: {
      groups: unownedRows.map((row) => {
        const name = row.owner_name || '未分配负责人';
        return summary(row, name, productRows.filter((item) => item.owner === name).length, ownerFlows.get(name));
      }),
      products: unownedProducts,
    },
    products: productRows,
    quality: {
      items: [
        ...(payload.quality.blockingGaps || []),
        ...(payload.quality.advisoryGaps || []),
        ...(missingImageCount ? [{ code: 'PRODUCT_IMAGE_URL_MISSING', count: missingImageCount, total: productRows.length }] : []),
      ].map(qualityText),
      method: [
        '已发货订单销售原额 = 旺店通全部订单还原支付原额 − 取消订单还原支付原额。',
        '净销售额 = 已发货订单销售原额 − 这些订单截至退款截止日已结算的退款。',
        '实际利润 = 净销售额 − 商品成本 − 运费 − 推广费 − 平台费 − 税费。',
        `平台费率 ${(number(payload.policy.platformFeeRate) * 100).toFixed(0)}%，税率 ${(number(payload.policy.taxRate) * 100).toFixed(0)}%。`,
        `未匹配快递账单按每运单 ${number(payload.policy.missingFreightPerWaybill).toFixed(2)} 元估算。`,
        '旺店通订单头 realAmount + refundAmount 还原支付原额；商品明细金额只作为订单内归一化分配权重。取消订单的支付与退款另列审计。',
        '取消订单支付金额按订单商品行金额权重归一化分到商品 ID，并按支付日负责人归属；商品和负责人明细分别与全店支付桥接核对。',
        '订单运费按订单内归一化收入占比分配到商品。',
        '本报告是经营利润分析，不替代法定财务报表或平台结算单。',
      ],
    },
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const output = path.resolve(options.out);
  if (fs.existsSync(output)) throw new Error(`拒绝覆盖已有文件：${output}`);
  const capabilities = runTbcli(['capabilities', '--json', '--all'], options);
  if (!JSON.stringify(capabilities).includes('profit-actual-query')) throw new Error('DEPENDENCY_UNAVAILABLE: tbcli 缺少 profit-actual-query');
  const payload = runTbcli(['profit', 'actual', 'query', '--shop-key', options.shopKey, '--month', options.month, '--group-by', 'report', '--json'], options);
  validatePayload(payload);
  const viewModel = buildViewModel(payload);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(viewModel, null, 2)}\n`, { flag: 'wx', mode: 0o644 });
  console.log(JSON.stringify({ ok: true, out: output, contract: viewModel.contract, status: payload.status, shopName: payload.shopName, month: payload.period.month, actualProfit: viewModel.shop.actual_profit, profitMargin: viewModel.shop.profit_margin, ownerCount: viewModel.owners.length, unownedGroupCount: viewModel.unowned.groups.length, productCount: viewModel.products.length, productImageCount: viewModel.products.filter((item) => item.image_url).length, quality: payload.quality, reconciliation: payload.reconciliation }, null, 2));
}

try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
