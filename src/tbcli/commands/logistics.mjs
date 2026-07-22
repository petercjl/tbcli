import { DEFAULT_CDP } from '../config.mjs';
import { printJsonOrText } from '../format.mjs';
import { ensureBrowserOpen } from './browser.mjs';
import { assertPageNotVerifying, createVerificationError, isVerificationSignal } from '../taobao-guard.mjs';

export async function runLogisticsGet(opts) {
  const tradeId = String(opts.tradeId || opts.tid || '').trim();
  if (!tradeId) throw new Error('缺少 --trade-id');

  const { chromium } = await import('playwright-core');
  await ensureBrowserOpen(opts);
  const browser = await chromium.connectOverCDP(opts.cdpUrl || DEFAULT_CDP);
  try {
    const context = browser.contexts()[0];
    if (!context) throw new Error('没有可用的浏览器上下文，请先打开已登录淘宝/千牛后台的电商浏览器');

    const sellerId = opts.sellerId || inferSellerId(context.pages());
    if (!sellerId) throw new Error('缺少 --seller-id，且当前电商浏览器页面 URL 中无法推断 seller_id');

    const page = await resolveTaobaoPage(context);
    await assertPageNotVerifying(page);
    const detail = await queryLogisticsDetail(page, { tradeId, sellerId });
    const output = normalizeLogisticsDetail(detail, { tradeId, sellerId });

    printJsonOrText(opts, output, (value) => {
      console.log(`Taobao logistics: tradeId=${value.tradeId}, packages=${value.packages.length}`);
      for (const pkg of value.packages) {
        console.log([
          pkg.cpName || '-',
          pkg.mailNo || '-',
          pkg.latestStatus || '-',
          pkg.latestTime || '-',
          pkg.traceCount,
        ].join('\t'));
      }
    });
  } finally {
    await browser.close();
  }
}

async function resolveTaobaoPage(context) {
  const pages = context.pages();
  const qnPage = pages.find((page) => isHost(page.url(), 'qn.taobao.com'));
  if (qnPage) return qnPage;

  const taobaoPage = pages.find((page) => isTaobaoHost(page.url()));
  if (taobaoPage) {
    await taobaoPage.goto('https://qn.taobao.com/home.htm/', { waitUntil: 'domcontentloaded' });
    return taobaoPage;
  }

  const page = await context.newPage();
  await page.goto('https://qn.taobao.com/home.htm/', { waitUntil: 'domcontentloaded' });
  return page;
}

async function queryLogisticsDetail(page, { tradeId, sellerId }) {
  const detail = await page.evaluate(async ({ tradeId: id, sellerId: sid }) => {
    const params = new URLSearchParams({
      from: 'list',
      params: 'v2',
      raw: '1',
      seller_id: sid,
      tradeId: id,
      'x-frame-parent': '',
    });
    const response = await fetch(`https://wuliu2.taobao.com/user/queryLogisticsDetailByOrderId?${params.toString()}`, {
      credentials: 'include',
      headers: { accept: 'application/json' },
    });
    if (response.redirected || /login|captcha|punish|_____tmd_____/i.test(response.url)) {
      return { __tbcliVerification: response.url };
    }
    if (!response.ok) throw new Error(`淘宝物流接口失败：HTTP ${response.status}`);
    return response.json();
  }, { tradeId, sellerId });
  if (detail?.__tbcliVerification || isVerificationSignal(JSON.stringify(detail))) {
    throw createVerificationError(detail?.__tbcliVerification || '物流接口风控信号');
  }
  return detail;
}

function normalizeLogisticsDetail(data, { tradeId, sellerId }) {
  const packages = Array.isArray(data?.pkgDetailBlock?.packageDetailBlockList)
    ? data.pkgDetailBlock.packageDetailBlockList
    : [];
  return {
    channel: 'taobao-browser',
    tradeId: data?.tradeOrderBlocks?.tradeId || tradeId,
    sellerId,
    createTime: data?.tradeOrderBlocks?.createTime || '',
    payTime: data?.tradeOrderBlocks?.payTime || '',
    packages: packages.map((pkg) => normalizePackage(pkg)),
  };
}

function normalizePackage(pkg) {
  const traces = Array.isArray(pkg.logisticsTraceListVo) ? pkg.logisticsTraceListVo : [];
  const latest = traces[0] || null;
  return {
    cpCode: pkg.cpCode || '',
    cpName: pkg.cpName || '',
    mailNo: pkg.mailNo || '',
    orderCode: pkg.orderCode || '',
    createTime: pkg.createTime || '',
    logisTypeName: pkg.logisTypeName || '',
    latestStatus: classifyTraceText(latest?.desc || ''),
    latestTime: latest?.time || '',
    latestSyncTime: latest?.syncTime || '',
    latestDesc: redactSensitive(latest?.desc || ''),
    traceCount: traces.length,
    traces: traces.map((trace) => ({
      time: trace.time || '',
      syncTime: trace.syncTime || '',
      status: classifyTraceText(trace.desc || ''),
      desc: redactSensitive(trace.desc || ''),
    })),
  };
}

function inferSellerId(pages) {
  for (const page of pages) {
    const match = page.url().match(/[?&]seller_id=(\d+)/);
    if (match) return match[1];
  }
  return '';
}

function isHost(url, expected) {
  try {
    return new URL(url).hostname === expected;
  } catch {
    return false;
  }
}

function isTaobaoHost(url) {
  try {
    const hostname = new URL(url).hostname;
    return hostname === 'taobao.com' || hostname.endsWith('.taobao.com');
  } catch {
    return false;
  }
}

function classifyTraceText(text) {
  if (/签收|派送成功|派送至本人|完成取件|已放在|放家门口|已送达|已投递|代收/.test(text)) return '签收';
  if (/暂存至|取货码|取件码|菜鸟驿站|驿站/.test(text)) return '驿站待取';
  if (/拒收|退回|异常|问题件|疑难件/.test(text)) return '异常';
  if (/派送|派件/.test(text)) return '派送中';
  if (/等待揽收|待揽/.test(text)) return '待揽收';
  if (/揽收|已揽件/.test(text)) return '已揽收';
  if (/发往|到达|转运|运输/.test(text)) return '运输中';
  return text ? '未知' : '';
}

function redactSensitive(text) {
  return String(text).replace(/(?<!\d)(?:1\d{10}|0\d{2,3}-?\d{7,8})(?!\d)/g, '[phone]');
}
