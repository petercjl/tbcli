import * as fontkit from 'fontkit';

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
  onProgress = () => {},
  fetchImpl = fetch,
}) {
  const targets = new Map(
    items
      .filter((item) => item.priceStatus === 'encoded')
      .map((item) => [String(item.itemId), item]),
  );
  if (!targets.size) return { decodedCount: 0, scannedPages: 0 };
  if (!shopUrl) throw new Error('导出 Excel 并还原价格时必须提供 --url');

  const found = new Map();
  const expectedWebPages = Math.max(1, Math.ceil(Number(totalCount || items.length) / 60));
  const maxWebPages = Math.min(expectedWebPages + 2, 100);
  let scannedPages = 0;

  for (let pageNo = 1; pageNo <= maxWebPages && found.size < targets.size; pageNo += 1) {
    await assertPageNotVerifying(page);
    await delayBeforeRequest();
    await page.goto(makeShopPageUrl(shopUrl, pageNo), { waitUntil: 'domcontentloaded', timeout: 60000 });
    await assertPageNotVerifying(page);
    try {
      await page.waitForFunction(
        () => document.querySelector('.J_TItems > .item4line1 .c-price'),
        null,
        { timeout: 30000 },
      );
    } catch (error) {
      await assertPageNotVerifying(page);
      throw new Error(`店铺网页第 ${pageNo} 页未加载出商品价格：${error.message}`);
    }
    await assertPageNotVerifying(page);
    const visibleItems = await readVisiblePrices(page);
    scannedPages = pageNo;
    for (const entry of visibleItems) {
      if (targets.has(entry.itemId) && entry.encodedDisplayPrice && entry.fontUrl) {
        found.set(entry.itemId, entry);
      }
    }
    onProgress({ phase: 'shop-page', pageNo, found: found.size, total: targets.size });
  }

  const missing = [...targets.keys()].filter((itemId) => !found.has(itemId));
  for (const itemId of missing) {
    const item = targets.get(itemId);
    await assertPageNotVerifying(page);
    await delayBeforeRequest();
    let detailUrl;
    try {
      const original = new URL(item.itemUrl);
      const trustedHost = original.hostname === 'taobao.com'
        || original.hostname.endsWith('.taobao.com')
        || original.hostname === 'tmall.com'
        || original.hostname.endsWith('.tmall.com');
      detailUrl = trustedHost ? new URL(`${original.origin}${original.pathname}`) : new URL('https://detail.tmall.com/item.htm');
    } catch {
      detailUrl = new URL('https://detail.tmall.com/item.htm');
    }
    detailUrl.searchParams.set('id', itemId);
    await page.goto(detailUrl.toString(), { waitUntil: 'domcontentloaded', timeout: 60000 });
    await assertPageNotVerifying(page);
    const plainPrice = await readDetailPrice(page, itemId);
    if (plainPrice) found.set(itemId, { plainPrice });
    onProgress({ phase: 'detail', itemId, found: found.size, total: targets.size });
  }

  const stillMissing = [...targets.keys()].filter((itemId) => !found.has(itemId));
  if (stillMissing.length) {
    throw new Error(`有 ${stillMissing.length} 个商品未找到可展示价格，已停止导出：${stillMissing.slice(0, 5).join(', ')}`);
  }

  const decoders = new Map();
  for (const [itemId, item] of targets) {
    const display = found.get(itemId);
    if (display.plainPrice) {
      item.price = display.plainPrice;
      item.priceStatus = 'detail-page';
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
  }
  return { decodedCount: targets.size, scannedPages };
}

async function readDetailPrice(page, itemId) {
  try {
    await page.waitForFunction(() => {
      const selectors = [
        '[class*="highlightPrice"] [class*="text"]',
        '#J_PromoPrice .tm-price',
        '#J_StrPrice .tm-price',
        '[class*="Price--priceText"]',
      ];
      return selectors.some((selector) => [...document.querySelectorAll(selector)].some((node) => /^\d+(?:\.\d{1,2})?$/.test((node.textContent || '').trim())));
    }, null, { timeout: 30000 });
  } catch (error) {
    await assertPageNotVerifying(page);
    return '';
  }
  await assertPageNotVerifying(page);
  return page.evaluate((expectedItemId) => {
    if (new URL(location.href).searchParams.get('id') !== expectedItemId) return '';
    const selectors = [
      '[class*="highlightPrice"] [class*="text"]',
      '#J_PromoPrice .tm-price',
      '#J_StrPrice .tm-price',
      '[class*="Price--priceText"]',
    ];
    for (const selector of selectors) {
      for (const node of document.querySelectorAll(selector)) {
        const text = String(node.textContent || '').trim();
        if (/^\d+(?:\.\d{1,2})?$/.test(text)) return text;
      }
    }
    return '';
  }, itemId);
}

async function readVisiblePrices(page) {
  return page.evaluate(() => {
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
      if (!child.classList.contains('item4line1')) continue;
      for (const item of child.querySelectorAll('.item')) {
        const link = item.querySelector('a.item-name');
        const price = item.querySelector('.c-price');
        if (!link || !price) continue;
        const itemId = String(item.dataset.id || new URL(link.href, location.href).searchParams.get('id') || '');
        const fontFamily = getComputedStyle(price).fontFamily;
        result.push({
          itemId,
          encodedDisplayPrice: String(price.textContent || '').trim(),
          fontUrl: findFontUrl(fontFamily),
        });
      }
    }
    return result;
  });
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
