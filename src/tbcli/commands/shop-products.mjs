import path from 'node:path';
import { withAuthenticatedTaobaoSession } from '../browser-session.mjs';
import {
  resolvePageActionDelayRange,
  waitBeforeTaobaoApiRequest,
} from '../api-policy.mjs';
import { writeCsv } from '../format.mjs';
import { enrichEncodedPrices, readVisiblePrices } from '../price-decoder.mjs';
import {
  openInitialShopProductPage,
  prepareShopProductPage,
} from '../shop-pagination.mjs';
import { readShopProductPage } from '../shop-search-parser.mjs';
import {
  resolveShopProductsCheckpointPath,
  writeShopProductsCheckpoint,
} from '../shop-products-cache.mjs';
import { writeShopProductsXlsx } from '../shop-products-xlsx.mjs';

const CSV_COLUMNS = [
  'shopName', 'shopId', 'sellerId', 'itemId', 'title', 'itemUrl', 'image',
  'price', 'priceStatus', 'vagueSold365', 'benefits', 'skuCount',
];

export async function runShopProducts(opts) {
  const shopUrl = String(opts.url || '').trim();
  if (!shopUrl) throw new Error('缺少 --url；店铺商品分页必须从真实店铺页面开始');

  let pageSize = 0;
  if (opts.pageSize != null) {
    throw new Error('店铺每页商品数由真实页面布局决定，不支持手工设置 --page-size');
  }
  const maxPages = boundedInteger(opts.maxPages, 0, 0, 10000, '--max-pages');
  const targetPage = boundedInteger(opts.page, 0, 0, 10000, '--page');
  if (targetPage && maxPages) throw new Error('--page 与 --max-pages 不能同时使用');
  const outPath = opts.out ? path.resolve(opts.out) : '';

  await withAuthenticatedTaobaoSession({ ...opts, startUrl: shopUrl || 'https://www.taobao.com/' }, async ({ context }) => {
    let page;
    let checkpointPath = '';
    let checkpoint = null;
    let latestOutput = null;
    try {
      page = await context.newPage();
      const firstPageAction = await openInitialShopProductPage(page, shopUrl, opts);

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

      checkpointPath = resolveShopProductsCheckpointPath({
        outPath,
        shopId,
        cachePath: opts.cachePath,
      });
      const rawItems = [];
      const seen = new Set();
      const visiblePriceItems = [];
      const pageActions = targetPage > 1 ? [firstPageAction] : [];
      const pageNumbers = [];
      let pageNo = targetPage || 1;
      let hasNext = true;
      let totalCount = 0;
      checkpoint = buildCheckpoint({
        status: 'in-progress',
        shopUrl,
        seller,
        shopId,
        sellerId,
        pageSize,
        maxPages,
        totalCount,
        rawItems,
        pagesFetched: 0,
        pageNumbers,
        nextPage: pageNo,
        pageActions,
      });
      writeShopProductsCheckpoint(checkpointPath, checkpoint);
      process.stderr.write(`断点文件：${checkpointPath}\n`);

      while (hasNext && (targetPage ? pageNumbers.length < 1 : (!maxPages || pageNumbers.length < maxPages))) {
        const pageAction = pageNo === 1
          ? firstPageAction
          : await prepareShopProductPage(page, pageNo, opts);
        pageActions.push(pageAction);
        const visibleItems = await readVisiblePrices(page, pageNo);
        visiblePriceItems.push(...visibleItems);

        const result = await readShopProductPage(page, pageNo);
        if (!pageSize) pageSize = result.data.length;
        for (const item of result.data || []) {
          const itemId = String(item?.itemId || '');
          if (!itemId || seen.has(itemId)) continue;
          seen.add(itemId);
          rawItems.push(item);
        }
        totalCount = rawItems.length;
        hasNext = result.hasNext === true || result.hasNext === 'true';
        pageNumbers.push(pageNo);
        checkpoint = buildCheckpoint({
          status: 'in-progress',
          shopUrl,
          seller,
          shopId,
          sellerId,
          pageSize,
          maxPages,
          totalCount,
          rawItems,
          pagesFetched: pageNumbers.length,
          pageNumbers,
          nextPage: pageNo + 1,
          pageActions,
        });
        writeShopProductsCheckpoint(checkpointPath, checkpoint);
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
        pagesFetched: pageNumbers.length,
        pageNumbers,
        pageSize,
        requestDelayMs: resolvePageActionDelayRange(opts),
      });
      latestOutput = output;
      const isXlsx = outPath.toLowerCase().endsWith('.xlsx');
      if (isXlsx) {
        process.stderr.write('正在还原店铺列表价格...\n');
        const detailDelayRange = resolvePageActionDelayRange(opts);
        const priceResult = await enrichEncodedPrices({
          page,
          items: output.items,
          totalCount: output.totalCount,
          shopUrl,
          prefetchedVisibleItems: visiblePriceItems,
          allowedShopPages: output.pageNumbers,
          navigateToShopPage: (targetPageNo) => prepareShopProductPage(page, targetPageNo, opts),
          delayBeforeRequest: () => waitBeforeTaobaoApiRequest(page, detailDelayRange),
          onProgress: ({ phase, pageNo: webPage, itemId, found, total }) => {
            if (phase === 'direct') {
              process.stderr.write(`\r价格直接还原：已完成 ${found}/${total} 条`);
            } else if (phase === 'detail') {
              process.stderr.write(`\r价格补充：商品 ${itemId}，已找到 ${found}/${total} 条`);
            } else {
              process.stderr.write(`\r价格匹配：网页第 ${webPage} 页，已找到 ${found}/${total} 条`);
            }
          },
        });
        process.stderr.write('\n');
        output.priceDirectDecodedCount = priceResult.directDecodedCount;
        output.pricePagesScanned = priceResult.scannedPages;
        output.priceDecodedCount = output.items.filter((item) => item.price !== '').length;
        await writeShopProductsXlsx(outPath, output);
      } else if (outPath.toLowerCase().endsWith('.csv')) {
        writeCsv(outPath, output.items, CSV_COLUMNS);
      } else if (outPath) {
        const { default: fs } = await import('node:fs');
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
      }

      if (opts.json) console.log(JSON.stringify(output, null, 2));
      else {
        console.log(`Taobao shop products: ${output.shop.name} (${output.shop.shopId})`);
        console.log(`exported=${output.exportedCount}, total=${output.totalCount}, pages=${output.pageNumbers.join(',')}`);
        if (isXlsx) console.log(`price=${output.priceDecodedCount}/${output.exportedCount}`);
        else console.log(`price=${output.items.filter((item) => item.price !== '').length}/${output.exportedCount}`);
        if (outPath) console.log(`output: ${outPath}`);
        console.log(`checkpoint: ${checkpointPath}`);
      }
      checkpoint = {
        ...checkpoint,
        status: 'complete',
        output,
      };
      writeShopProductsCheckpoint(checkpointPath, checkpoint);
    } catch (error) {
      if (checkpointPath && checkpoint) {
        checkpoint = {
          ...checkpoint,
          status: 'stopped',
          output: latestOutput || checkpoint.output,
          error: {
            code: error?.code || 'SHOP_PRODUCTS_STOPPED',
            message: String(error?.message || error),
          },
        };
        writeShopProductsCheckpoint(checkpointPath, checkpoint);
        process.stderr.write(`\n获取已停止，已保留断点数据：${checkpointPath}\n`);
      }
      throw error;
    }
    // Intentionally keep the ecommerce browser page open so the user can
    // inspect the exact state after success or a guarded stop.
  });
}

export function normalizeShopProducts({
  seller,
  shopId,
  sellerId,
  shopUrl,
  totalCount,
  rawItems,
  pagesFetched,
  pageNumbers = null,
  pageSize = 60,
  requestDelayMs = null,
}) {
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
    channel: 'taobao-shop-page',
    fetchedAt: new Date().toISOString(),
    shop: { name: shopName, shopId, sellerId, url: shopUrl },
    totalCount: Number(totalCount || items.length),
    exportedCount: items.length,
    pagesFetched,
    pageNumbers: Array.isArray(pageNumbers) && pageNumbers.length
      ? pageNumbers.map(Number)
      : Array.from({ length: Number(pagesFetched || 0) }, (_, index) => index + 1),
    pageSize,
    requestDelayMs,
    priceNote: 'price 为店铺列表页面展示价格；仅在页面未提供明文时保留 encodedPrice 供安全还原。',
    items,
  };
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

function buildCheckpoint({
  status,
  shopUrl,
  seller,
  shopId,
  sellerId,
  pageSize,
  maxPages,
  totalCount,
  rawItems,
  pagesFetched,
  pageNumbers,
  nextPage,
  pageActions,
}) {
  return {
    status,
    requestedUrl: shopUrl,
    requestedMaxPages: maxPages || null,
    pagesFetched,
    nextPage: Number(nextPage || pagesFetched + 1),
    pageNumbers: [...(pageNumbers || [])],
    pageActions: [...pageActions],
    output: normalizeShopProducts({
      seller,
      shopId,
      sellerId,
      shopUrl,
      totalCount,
      rawItems,
      pagesFetched,
      pageNumbers,
      pageSize,
      requestDelayMs: null,
    }),
  };
}
