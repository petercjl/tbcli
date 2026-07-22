import path from 'node:path';
import { assertTaobaoLoggedIn, withBrowserSession } from '../browser-session.mjs';
import { writeCsv } from '../format.mjs';
import {
  assertPageNotVerifying,
  createVerificationError,
  isVerificationSignal,
  VERIFICATION_ERROR_CODE,
} from '../taobao-guard.mjs';

const CSV_COLUMNS = [
  'shopName', 'shopId', 'sellerId', 'itemId', 'title', 'itemUrl', 'image',
  'price', 'priceStatus', 'vagueSold365', 'benefits', 'skuCount',
];

export async function runShopProducts(opts) {
  const shopUrl = String(opts.url || '').trim();
  if (!shopUrl && !(opts.shopId && opts.sellerId)) {
    throw new Error('缺少 --url；也可同时提供 --shop-id 和 --seller-id');
  }

  const pageSize = boundedInteger(opts.pageSize, 30, 1, 30, '--page-size');
  const maxPages = boundedInteger(opts.maxPages, 0, 0, 10000, '--max-pages');
  const fixedDelay = opts.delayMs == null ? null : boundedInteger(opts.delayMs, 0, 0, 60000, '--delay-ms');
  const minDelayMs = fixedDelay ?? boundedInteger(opts.minDelayMs, 1000, 0, 60000, '--min-delay-ms');
  const maxDelayMs = fixedDelay ?? boundedInteger(opts.maxDelayMs, 2000, 0, 60000, '--max-delay-ms');
  if (maxDelayMs < minDelayMs) throw new Error('--max-delay-ms 不能小于 --min-delay-ms');

  await withBrowserSession({ ...opts, startUrl: shopUrl || 'https://www.taobao.com/' }, async ({ context }) => {
    await assertTaobaoLoggedIn(context);
    let createdPage = false;
    let page;
    try {
      if (shopUrl) {
        page = await context.newPage();
        createdPage = true;
      } else {
        page = findShopPage(context.pages(), shopUrl);
        if (!page) {
          page = await context.newPage();
          createdPage = true;
        }
      }
      if (shopUrl && page.url() !== shopUrl) {
        await page.goto(shopUrl, { waitUntil: 'domcontentloaded' });
      }
      await assertPageNotVerifying(page);
      try {
        await page.waitForFunction(
          () => window.lib?.mtop?.request && (window.g_config?.shopId || window.g_config?.seller?.shopId),
          null,
          { timeout: 20000 },
        );
      } catch (error) {
        await assertPageNotVerifying(page);
        throw error;
      }

      const seller = await page.evaluate(() => ({
        shopId: String(window.g_config?.shopId || window.g_config?.seller?.shopId || ''),
        sellerId: String(window.g_config?.sellerId || window.g_config?.seller?.sellerId || ''),
        shopName: String(
          window.g_config?.seller?.shopName
          || document.querySelector('.slogo-shopname strong, .shop-name, .header-extra .slogo')?.textContent
          || document.title.split('-').find((part) => /店/.test(part))
          || '',
        ).replace(/\s+/g, ' ').trim(),
      }));
      const shopId = String(opts.shopId || seller.shopId || '');
      const sellerId = String(opts.sellerId || seller.sellerId || '');
      if (!shopId || !sellerId) throw new Error('无法从店铺页识别 shopId/sellerId');

      const rawItems = [];
      const seen = new Set();
      let pageNo = 1;
      let hasNext = true;
      let totalCount = 0;
      while (hasNext && (!maxPages || pageNo <= maxPages)) {
        await assertPageNotVerifying(page);
        await sleep(randomDelayMs(minDelayMs, maxDelayMs));
        const result = await requestProductPage(
          page,
          { shopId, sellerId, page: pageNo, pageSize },
          { minDelayMs, maxDelayMs },
        );
        totalCount = Number(result.totalCnt || totalCount || 0);
        for (const item of result.data || []) {
          const itemId = String(item?.itemId || '');
          if (!itemId || seen.has(itemId)) continue;
          seen.add(itemId);
          rawItems.push(item);
        }
        hasNext = result.hasNext === true || result.hasNext === 'true';
        process.stderr.write(`\r店铺商品：第 ${pageNo} 页，已获取 ${rawItems.length}/${totalCount || '?'} 条`);
        pageNo += 1;
      }
      process.stderr.write('\n');

      const output = normalizeShopProducts({
        seller,
        shopId,
        sellerId,
        shopUrl: page.url(),
        totalCount,
        rawItems,
        pagesFetched: pageNo - 1,
        requestDelayMs: { min: minDelayMs, max: maxDelayMs },
      });
      const outPath = opts.out ? path.resolve(opts.out) : '';
      if (outPath.toLowerCase().endsWith('.csv')) {
        writeCsv(outPath, output.items, CSV_COLUMNS);
      } else if (outPath) {
        const { default: fs } = await import('node:fs');
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
      }

      if (opts.json) console.log(JSON.stringify(output, null, 2));
      else {
        console.log(`Taobao shop products: ${output.shop.name} (${output.shop.shopId})`);
        console.log(`exported=${output.exportedCount}, total=${output.totalCount}, pages=${output.pagesFetched}`);
        console.log('price=encoded（淘宝列表接口未返回可直接读取的数字价格）');
        if (outPath) console.log(`output: ${outPath}`);
      }
    } finally {
      if (createdPage && !opts.keepPage && page) await page.close().catch(() => {});
    }
  });
}

async function requestProductPage(page, data, delayRange) {
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      await assertPageNotVerifying(page);
      const response = await page.evaluate(async (requestData) => {
        if (!window.lib?.mtop?.request) throw new Error('店铺页 MTOP 客户端尚未就绪');
        let result;
        try {
          result = await Promise.race([
            window.lib.mtop.request({
              api: 'mtop.taobao.shop.simple.item.fetch',
              v: '1.0',
              data: { ...requestData, feature: '{}' },
            }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('MTOP 请求 20 秒超时')), 20000)),
          ]);
        } catch (error) {
          return {
            clientError: typeof error === 'string' ? error : JSON.stringify(error || {}),
            url: location.href,
            title: document.title,
          };
        }
        return { result, url: location.href, title: document.title };
      }, data);
      const signal = `${response?.clientError || ''}\n${response?.url || ''}\n${response?.title || ''}\n${JSON.stringify(response?.result?.ret || [])}`;
      if (response?.clientError || isVerificationSignal(signal)) {
        throw createVerificationError(response?.clientError || response?.title || 'MTOP 风控信号');
      }
      const result = response?.result;
      const success = Array.isArray(result?.ret) && result.ret.some((entry) => String(entry).startsWith('SUCCESS'));
      if (!success) throw new Error(`MTOP ${JSON.stringify(result?.ret || [])}`);
      if (!result?.data || !Array.isArray(result.data.data)) throw new Error('商品接口响应缺少 data 数组');
      return result.data;
    } catch (error) {
      lastError = error;
      if (error?.code === VERIFICATION_ERROR_CODE || isVerificationSignal(error?.message)) throw error;
      try {
        await assertPageNotVerifying(page);
      } catch (guardError) {
        throw guardError;
      }
      if (attempt < 5) {
        await sleep(randomDelayMs(delayRange.minDelayMs, delayRange.maxDelayMs));
      }
    }
  }
  throw new Error(`商品第 ${data.page} 页请求失败：${lastError?.message || lastError}`);
}

export function randomDelayMs(min, max, random = Math.random) {
  if (max <= min) return min;
  return min + Math.floor(random() * (max - min + 1));
}

export function normalizeShopProducts({ seller, shopId, sellerId, shopUrl, totalCount, rawItems, pagesFetched, requestDelayMs = null }) {
  const shopName = String(seller?.shopName || '');
  const items = rawItems.map((item) => ({
    shopName,
    shopId,
    sellerId,
    itemId: String(item.itemId || ''),
    title: String(item.title || '').replace(/\s+/g, ' ').trim(),
    itemUrl: normalizeUrl(item.itemUrl),
    image: normalizeUrl(item.image),
    price: item.priceEncoded === true || item.priceEncoded === 'true' ? '' : String(item.discountPrice || item.price || ''),
    priceStatus: item.priceEncoded === true || item.priceEncoded === 'true' ? 'encoded' : 'plain',
    encodedPrice: item.priceEncoded === true || item.priceEncoded === 'true' ? String(item.discountPrice || '') : '',
    vagueSold365: String(item.vagueSold365 || ''),
    benefits: (item.benefitPointList || []).map((entry) => entry?.text).filter(Boolean).join('；'),
    rankings: item.rankingInfoList || [],
    skuCount: Array.isArray(item.skuInfoList) ? item.skuInfoList.length : 0,
    skus: (item.skuInfoList || []).map((sku) => ({
      skuId: String(sku.skuId || ''),
      propertyText: String(sku.skuPropertyText || ''),
      image: normalizeUrl(sku.skuImageUrl),
      url: normalizeUrl(sku.itemSkuUrl),
    })),
  }));
  return {
    channel: 'taobao-browser-mtop',
    fetchedAt: new Date().toISOString(),
    shop: { name: shopName, shopId, sellerId, url: shopUrl },
    totalCount: Number(totalCount || items.length),
    exportedCount: items.length,
    pagesFetched,
    requestDelayMs,
    priceNote: 'priceStatus=encoded 表示淘宝列表接口返回加密价格，price 留空；encodedPrice 保留原始值供后续解码。',
    items,
  };
}

function findShopPage(pages, shopUrl) {
  if (shopUrl) {
    try {
      const target = new URL(shopUrl).hostname;
      const exact = pages.find((page) => {
        try { return new URL(page.url()).hostname === target; } catch { return false; }
      });
      if (exact) return exact;
    } catch {}
  }
  return pages.find((page) => /\.(?:taobao|tmall)\.com\//.test(page.url())) || null;
}

function normalizeUrl(value) {
  const text = String(value || '');
  return text.startsWith('//') ? `https:${text}` : text;
}

function boundedInteger(value, fallback, min, max, option) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${option} 必须是 ${min}-${max} 的整数`);
  }
  return parsed;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
