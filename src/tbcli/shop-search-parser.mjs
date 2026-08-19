export function parseShopSearchResponse(body, { pageNo = 1 } = {}) {
  const html = unwrapJsonpHtml(body);
  const containerMatch = html.match(/class=(["'])[^"']*\bJ_TItems\b[^"']*\1/i);
  if (!containerMatch) throw new Error('店铺列表响应中未找到商品容器');

  const containerHtml = html.slice(containerMatch.index);
  const boundary = findFirstBoundary(containerHtml, [
    /class=(["'])[^"']*\bpagination\b[^"']*\1/i,
    /class=(["'])[^"']*\bcomboHd\b[^"']*\1/i,
  ]);
  const mainHtml = boundary < 0 ? containerHtml : containerHtml.slice(0, boundary);
  const items = [];
  const seen = new Set();
  const itemPattern = /<dl\b([^>]*\bdata-id=(["'])\d+\2[^>]*)>([\s\S]*?)<\/dl>/gi;
  let match;

  while ((match = itemPattern.exec(mainHtml))) {
    const attributes = match[1];
    const itemHtml = match[3];
    const itemId = attributeValue(attributes, 'data-id');
    if (!itemId || seen.has(itemId)) continue;
    seen.add(itemId);

    const titleLink = elementByClass(itemHtml, 'a', 'item-name');
    const photo = elementByClass(itemHtml, 'dt', 'photo');
    const priceElement = elementByClass(itemHtml, 'span', 'c-price');
    const saleElement = elementByClass(itemHtml, 'span', 'sale-num');
    const couponElement = elementByClass(itemHtml, 'div', 'coupon-area');
    const itemUrl = decodeHtml(attributeValue(titleLink?.attributes || '', 'href'));
    const title = textContent(titleLink?.body || '');
    const image = imageUrl(photo?.body || '');
    const displayedPrice = textContent(priceElement?.body || '');
    const commentPrice = itemHtml.match(/item\.discntPrice\s*:\s*(\d+(?:\.\d{1,2})?)/i)?.[1] || '';
    const plainPrice = commentPrice || (/^\d+(?:\.\d{1,2})?$/.test(displayedPrice) ? displayedPrice : '');
    const skuInfoList = parseSkuThumbnails(itemHtml, itemUrl);
    const benefitText = textContent(couponElement?.body || '');

    items.push({
      itemId,
      title,
      itemUrl,
      image,
      priceEncoded: !plainPrice,
      discountPrice: plainPrice || displayedPrice,
      vagueSold365: textContent(saleElement?.body || ''),
      benefitPointList: benefitText ? [{ text: benefitText }] : [],
      rankingInfoList: [],
      skuInfoList,
    });
  }

  if (!items.length) throw new Error('店铺列表响应中未解析出主列表商品');
  const totalPages = Math.max(
    Number(pageNo) || 1,
    ...[...html.matchAll(/(?:[?&]|&amp;)pageNo=(\d+)/gi)].map((entry) => Number(entry[1])),
  );
  return {
    data: items,
    totalCnt: items.length,
    hasNext: totalPages > Number(pageNo),
    totalPages,
  };
}

export async function readShopProductPage(page, pageNo) {
  const html = await page.evaluate(() => document.querySelector('.J_TItems')?.outerHTML || '');
  if (!html) throw new Error(`店铺第 ${pageNo} 页没有可读取的商品列表`);
  return parseShopSearchResponse(`tbcli(${JSON.stringify(html)})`, { pageNo });
}

export function unwrapJsonpHtml(body) {
  const text = String(body || '').trim();
  const open = text.indexOf('(');
  const close = text.lastIndexOf(')');
  if (open < 0 || close <= open) throw new Error('店铺列表响应不是有效 JSONP');
  let payload;
  try {
    payload = JSON.parse(text.slice(open + 1, close));
  } catch (error) {
    throw new Error(`店铺列表 JSONP 解析失败：${error.message}`);
  }
  if (typeof payload === 'string') return payload;
  if (payload && typeof payload === 'object') {
    const html = findHtmlString(payload);
    if (html) return html;
  }
  throw new Error('店铺列表 JSONP 中没有 HTML 内容');
}

function findHtmlString(value) {
  if (typeof value === 'string') {
    return /class=(["'])[^"']*\bJ_TItems\b/i.test(value) ? value : '';
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const html = findHtmlString(entry);
      if (html) return html;
    }
    return '';
  }
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) {
      const html = findHtmlString(entry);
      if (html) return html;
    }
  }
  return '';
}

function parseSkuThumbnails(itemHtml, itemUrl) {
  const skus = [];
  const pattern = /<b\b([^>]*\bdata-sku=(["'])[^"']+\2[^>]*)>([\s\S]*?)<\/b>/gi;
  let match;
  while ((match = pattern.exec(itemHtml))) {
    const propertyText = attributeValue(match[1], 'data-sku');
    if (!propertyText) continue;
    skus.push({
      skuId: '',
      skuPropertyText: propertyText,
      skuImageUrl: imageUrl(match[3]),
      itemSkuUrl: itemUrl,
    });
  }
  return skus;
}

function elementByClass(html, tag, className) {
  const pattern = new RegExp(
    `<${tag}\\b([^>]*class=(["'])[^"']*\\b${escapeRegExp(className)}\\b[^"']*\\2[^>]*)>([\\s\\S]*?)<\\/${tag}>`,
    'i',
  );
  const match = String(html || '').match(pattern);
  return match ? { attributes: match[1], body: match[3] } : null;
}

function imageUrl(html) {
  const match = String(html || '').match(/<img\b([^>]*)>/i);
  if (!match) return '';
  return decodeHtml(
    attributeValue(match[1], 'src')
    || attributeValue(match[1], 'data-ks-lazyload')
    || attributeValue(match[1], 'data-src'),
  );
}

function attributeValue(attributes, name) {
  const escaped = escapeRegExp(name);
  const match = String(attributes || '').match(new RegExp(`(?:^|\\s)${escaped}=(["'])(.*?)\\1`, 'i'));
  return match?.[2] || '';
}

function textContent(html) {
  return decodeHtml(
    String(html || '')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  );
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function findFirstBoundary(value, patterns) {
  const indexes = patterns
    .map((pattern) => value.search(pattern))
    .filter((index) => index >= 0);
  return indexes.length ? Math.min(...indexes) : -1;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
