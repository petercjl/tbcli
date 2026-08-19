import * as fontkit from 'fontkit';

import {
  decodeSecfontApiPrices,
  parseSecfontPrice,
} from './secfont-direct-decoder.mjs';
import { assertPageNotVerifying } from './taobao-guard.mjs';

const GLYPH_TEXT = new Map([
  ['zero', '0'], ['one', '1'], ['two', '2'], ['three', '3'], ['four', '4'],
  ['five', '5'], ['six', '6'], ['seven', '7'], ['eight', '8'], ['nine', '9'],
  ['period', '.'], ['decimal', '.'],
]);

export function decodePriceText(encodedText, glyphNameForCodePoint) {
  const decoded = [...String(encodedText || '')].map((char) => {
    const glyphName = glyphNameForCodePoint(char.codePointAt(0));
    const value = GLYPH_TEXT.get(String(glyphName || '').toLowerCase());
    if (value == null) throw new Error(`价格字符无法映射：U+${char.codePointAt(0).toString(16).toUpperCase()}`);
    return value;
  }).join('');
  if (!/^\d+(?:\.\d{1,2})?$/.test(decoded)) throw new Error(`价格格式异常：${decoded || '(空)'}`);
  return decoded;
}

export function makeShopPageUrl(shopUrl, pageNo) {
  const url = new URL(shopUrl);
  url.hash = '';
  url.searchParams.delete('spm');
  url.searchParams.set('search', 'y');
  url.searchParams.set('pageNo', String(pageNo));
  return url.toString();
}

export function isTrustedFontUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (
      url.hostname === 'taobao.com'
      || url.hostname.endsWith('.taobao.com')
      || url.hostname === 'tmall.com'
      || url.hostname.endsWith('.tmall.com')
      || url.hostname === 'alicdn.com'
      || url.hostname.endsWith('.alicdn.com')
    );
  } catch {
    return false;
  }
}

export async function enrichEncodedPrices({
  page,
  items,
  totalCount,
  shopUrl,
  delayBeforeRequest,
  navigateToShopPage,
  prefetchedVisibleItems = [],
  maxShopPages = 0,
  allowedShopPages = null,
  onProgress = () => {},
  fetchImpl = fetch,
  directDecoder = decodeSecfontApiPrices,
}) {
  const targets = new Map(
    items
      .filter((item) => item.priceStatus === 'encoded')
      .map((item) => [String(item.itemId), item]),
  );
  if (!targets.size) return { decodedCount: 0, scannedPages: 0, directDecodedCount: 0 };
  if (!shopUrl) throw new Error('导出 Excel 并还原价格时必须提供 --url');

  const decodedIds = new Set();
  const directDecodedIds = new Set();
  const directTargets = [...targets.values()].filter((item) => parseSecfontPrice(item.encodedPrice));
  if (directTargets.length) {
    const directResults = await directDecoder({ page, items: directTargets });
    for (const result of directResults) {
      const item = targets.get(String(result.itemId));
      if (!item) continue;
      item.price = result.price;
      item.priceStatus = 'decoded-secfont';
      decodedIds.add(String(result.itemId));
      directDecodedIds.add(String(result.itemId));
    }
    onProgress({
      phase: 'direct',
      found: decodedIds.size,
      total: targets.size,
    });
    if (decodedIds.size === targets.size) {
      return {
        decodedCount: decodedIds.size,
        directDecodedCount: directDecodedIds.size,
        scannedPages: 0,
      };
    }
  }

  const found = new Map();
  for (const entry of prefetchedVisibleItems) {
    if (targets.has(entry.itemId) && (entry.plainPrice || (entry.encodedDisplayPrice && entry.fontUrl))) {
      found.set(entry.itemId, entry);
    }
  }
  const decoders = new Map();
  await applyFoundPrices();

  const expectedWebPages = Math.max(1, Math.ceil(Number(totalCount || items.length) / 60));
  const pageNumbers = Array.isArray(allowedShopPages) && allowedShopPages.length
    ? [...new Set(allowedShopPages.map(Number).filter((value) => value >= 1 && value <= 100))]
    : Array.from({
      length: maxShopPages
        ? Math.min(maxShopPages, 100)
        : Math.min(expectedWebPages + 2, 100),
    }, (_, index) => index + 1);
  const prefetchedPages = new Set(
    prefetchedVisibleItems.map((entry) => entry.pageNo).filter(Boolean),
  );
  let scannedPages = prefetchedPages.size;

  for (const pageNo of pageNumbers) {
    if (found.size >= targets.size) break;
    if (prefetchedPages.has(pageNo)) continue;
    await assertPageNotVerifying(page);
    if (navigateToShopPage) {
      await navigateToShopPage(pageNo);
    } else {
      await delayBeforeRequest();
      await page.goto(makeShopPageUrl(shopUrl, pageNo), { waitUntil: 'domcontentloaded', timeout: 60000 });
    }
    await assertPageNotVerifying(page);
    try {
      await page.waitForFunction(
        () => document.querySelector('.J_TItems > [class*="item"][class*="line1"] .c-price'),
        null,
        { timeout: 30000 },
      );
    } catch (error) {
      await assertPageNotVerifying(page);
      throw new Error(`店铺网页第 ${pageNo} 页未加载出商品价格：${error.message}`);
    }
    await assertPageNotVerifying(page);
    const visibleItems = await readVisiblePrices(page);
    scannedPages = Math.max(scannedPages, pageNo);
    for (const entry of visibleItems) {
      if (targets.has(entry.itemId) && (entry.plainPrice || (entry.encodedDisplayPrice && entry.fontUrl))) {
        found.set(entry.itemId, entry);
      }
    }
    await applyFoundPrices();
    onProgress({ phase: 'shop-page', pageNo, found: found.size, total: targets.size });
  }

  const missing = [...targets.keys()].filter((itemId) => !found.has(itemId));
  if (missing.length) {
    const error = new Error(`有 ${missing.length} 个商品未在已获取的店铺列表页找到可展示价格；为避免逐个访问商品详情，已停止导出：${missing.slice(0, 5).join(', ')}`);
    error.code = 'PARTIAL_DATA';
    error.partialDecodedCount = decodedIds.size;
    throw error;
  }

  return {
    decodedCount: decodedIds.size,
    directDecodedCount: directDecodedIds.size,
    scannedPages,
  };

  async function applyFoundPrices() {
    for (const [itemId, display] of found) {
      if (decodedIds.has(itemId)) continue;
      const item = targets.get(itemId);
      if (!item) continue;
      if (display.plainPrice) {
        item.price = display.plainPrice;
        item.priceStatus = 'shop-page';
        decodedIds.add(itemId);
        continue;
      }
      let decode = decoders.get(display.fontUrl);
      if (!decode) {
        decode = await loadFontDecoder(display.fontUrl, fetchImpl);
        decoders.set(display.fontUrl, decode);
      }
      item.price = decode(display.encodedDisplayPrice);
      item.priceStatus = 'decoded-font';
      item.encodedDisplayPrice = display.encodedDisplayPrice;
      decodedIds.add(itemId);
    }
  }
}

export async function readVisiblePrices(page, pageNo = null) {
  const entries = await page.evaluate(() => {
    const normalizeFamily = (value) => String(value || '').split(',')[0].replace(/["']/g, '').trim();
    const findFontUrl = (fontFamily) => {
      const family = normalizeFamily(fontFamily);
      for (const sheet of document.styleSheets) {
        let rules;
        try { rules = [...sheet.cssRules]; } catch { continue; }
        for (const rule of rules) {
          const ruleFamily = normalizeFamily(rule.style?.fontFamily);
          if (!ruleFamily || ruleFamily !== family) continue;
          const source = String(rule.style?.src || rule.cssText || '');
          const match = source.match(/url\(["']?([^"')]+)["']?\)/);
          if (match) return new URL(match[1], location.href).toString();
        }
      }
      return '';
    };

    const container = document.querySelector('.J_TItems');
    if (!container) return [];
    const result = [];
    for (const child of container.children) {
      if (child.classList.contains('pagination') || child.classList.contains('comboHd')) break;
      if (![...child.classList].some((name) => /^item\d+line1$/.test(name))) continue;
      for (const item of child.querySelectorAll('.item')) {
        const link = item.querySelector('a.item-name');
        const price = item.querySelector('.c-price');
        if (!link || !price) continue;
        const itemId = String(item.dataset.id || new URL(link.href, location.href).searchParams.get('id') || '');
        const fontFamily = getComputedStyle(price).fontFamily;
        const displayPrice = String(price.textContent || '').trim();
        result.push({
          itemId,
          plainPrice: /^\d+(?:\.\d{1,2})?$/.test(displayPrice) ? displayPrice : '',
          encodedDisplayPrice: displayPrice,
          fontUrl: findFontUrl(fontFamily),
        });
      }
    }
    return result;
  });
  return pageNo == null ? entries : entries.map((entry) => ({ ...entry, pageNo }));
}

async function loadFontDecoder(fontUrl, fetchImpl) {
  if (!isTrustedFontUrl(fontUrl)) throw new Error(`拒绝下载非淘宝/天猫字体：${fontUrl}`);
  const response = await fetchImpl(fontUrl);
  if (!response.ok) throw new Error(`价格字体下载失败：HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const font = fontkit.create(bytes);
  return (encodedText) => decodePriceText(
    encodedText,
    (codePoint) => font.glyphForCodePoint(codePoint)?.name,
  );
}
