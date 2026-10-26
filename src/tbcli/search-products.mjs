import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { resolveApiDelayRange, waitBeforeTaobaoApiRequest } from './api-policy.mjs';
import { assertPageNotVerifying, createVerificationError, isVerificationSignal } from './taobao-guard.mjs';

export const SEARCH_CARD = 'a[id^="item_id_"]';
export function searchError(code, message) { return Object.assign(new Error(message), { code }); }

export async function prepareSearch(opts) {
  const images = opts.searchImages || [];
  const keywords = (opts.searchKeywords || (opts.keyword ? [opts.keyword] : [])).map(v => String(v || '').trim());
  if (!images.length || images.length > 5 || !keywords.length || keywords.length > 10 || keywords.some(v => !v || v.length > 100)) {
    throw searchError('INVALID_SEARCH_INPUT', '需要 1–5 个 --image 本地图片和 1–10 个 --keyword 搜索词（每词 1–100 字）。');
  }
  const maxPages = Number(opts.maxPages ?? 1);
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 10) throw searchError('INVALID_SEARCH_INPUT', '--max-pages 必须是 1–10，限定每个关键词的页数。');
  const prepared = [];
  for (const file of images) {
    if (!file || /^https?:/i.test(file)) throw searchError('INVALID_SEARCH_IMAGE', '--image 接受已保存的本地 JPEG/PNG 图片。');
    const info = await stat(file);
    if (!info.isFile() || info.size === 0 || info.size > 10 * 1024 * 1024) throw searchError('INVALID_SEARCH_IMAGE', '图片必须是 1 字节至 10 MiB 的普通文件。');
    const buffer = await readFile(file);
    let mimeType;
    if (buffer.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) mimeType = 'image/jpeg';
    if (buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) mimeType = 'image/png';
    if (!mimeType) throw searchError('INVALID_SEARCH_IMAGE', '淘宝图片搜索只接受 JPEG、PNG 图片内容。');
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    prepared.push({ name: path.basename(file), file: path.resolve(file), mimeType, sha256 });
  }
  return { images: prepared, keywords, maxPages, delayRange: resolveApiDelayRange(opts) };
}

// Runs inside the rendered search page. Only product cards are evidence.
export function extractSearchCards() {
  const text = (root, selector) => root.querySelector(selector)?.textContent?.trim() || null;
  return [...document.querySelectorAll('a[id^="item_id_"]')].map((card, index) => ({
    href: card.href, rank: index + 1, domItemId: card.id.replace(/^item_id_/, ''),
    title: card.querySelector('[class^="title--"]')?.getAttribute('title') || text(card, '[class^="title--"]'),
    imageUrl: card.querySelector('img[class^="mainPic--"]')?.getAttribute('src') || null,
    priceText: text(card, '[class^="innerPriceWrapper--"]'),
    salesText: text(card, '[class^="realSales--"]'),
    shopName: text(card, '[class^="shopNameText--"]'),
    location: [...card.querySelectorAll('[class^="procity--"]')].map(e => e.textContent.trim()).join(' '),
  }));
}

export function normalizeSearchCard(raw) {
  let url;
  try { url = new URL(raw.href, 'https://s.taobao.com/'); } catch { return null; }
  const promoted = ['mclick.simba.taobao.com', 'click.simba.taobao.com'].includes(url.hostname);
  if (!['item.taobao.com', 'detail.tmall.com'].includes(url.hostname) && !promoted) return null;
  const itemId = promoted ? raw.domItemId : url.searchParams.get('id');
  if (!/^\d+$/.test(itemId || '') || !raw.title) return null;
  if (raw.domItemId && raw.domItemId !== itemId) return null;
  let imageUrl = null;
  try { const image = new URL(raw.imageUrl, 'https://s.taobao.com/'); if (image.protocol === 'https:' && (image.hostname.endsWith('.alicdn.com'))) imageUrl = image.href; } catch { /* absent */ }
  return { itemId, url: `https://${promoted ? 'item.taobao.com' : url.hostname}/item.htm?id=${itemId}`, title: raw.title, promoted,
    imageUrl, priceText: raw.priceText || null, priceScope: 'search-card-display',
    salesText: raw.salesText || null, shopName: raw.shopName || null, location: raw.location || null };
}

export function appendSearchBatch(products, rows, source) {
  const normalized = rows.map(normalizeSearchCard);
  if (normalized.some(item => !item)) throw searchError('SEARCH_SCHEMA_CHANGED', '商品卡片缺少有效 ID 或标题；保留此前成功批次。');
  for (const [index, item] of normalized.entries()) {
    const observation = { ...source, rank: rows[index].rank, title: item.title, imageUrl: item.imageUrl, priceText: item.priceText, salesText: item.salesText, shopName: item.shopName, promoted: item.promoted };
    products.push({ ...item, observations: [observation] });
  }
}

// Watch the page's own data responses, without replaying requests or storing headers.
export function watchSearchVerification(page) {
  let blocked = null;
  const pending = new Set();
  const onResponse = response => {
    const task = (async () => {
      const url = new URL(response.url());
      if (!/(^|\.)(taobao|tmall)\.com$/.test(url.hostname)) return;
      // Telemetry/long-lived streams are not search data. Inspect platform MTOP
      // replies (including JSONP) and explicit denial responses only.
      if (response.status() === 403 || response.status() === 429 || isVerificationSignal(url.pathname)) blocked = createVerificationError('搜索响应受限');
      if (!url.pathname.startsWith('/h5/mtop.')) return;
      const type = response.headers()['content-type'] || '';
      if (/json|javascript/.test(type)) {
        let timer;
        const body = await Promise.race([response.text(), new Promise((_, reject) => { timer = setTimeout(() => reject(searchError('SEARCH_RESPONSE_TIMEOUT', '搜索响应读取超时，停止采集。')), 5000); })]).finally(() => clearTimeout(timer));
        // Only inspect protocol error markers, not arbitrary product titles.
        if (/FAIL_SYS_USER_VALIDATE|RGV587|SESSION_EXPIRED|ILLEGAL_ACCESS|FAIL_SYS_SESSION_EXPIRED|_____tmd_____/.test(body)) blocked = createVerificationError('搜索返回验证状态');
      }
    })().catch(error => { blocked ||= searchError(error.code || 'SEARCH_RESPONSE_UNREADABLE', '搜索响应无法校验，停止采集。'); });
    pending.add(task); task.finally(() => pending.delete(task));
  };
  page.on('response', onResponse);
  return { async check() { await Promise.all([...pending]); if (blocked) throw blocked; await assertPageNotVerifying(page); }, dispose() { page.off('response', onResponse); } };
}

export async function guardedSearchAction(page, guard, delayRange, action, wait = waitBeforeTaobaoApiRequest) {
  await guard.check();
  await wait(page, delayRange);
  await guard.check();
  const result = await action();
  await guard.check();
  return result;
}

async function waitCards(page, guard, previousIds = '') {
  let last = ''; let stable = 0;
  for (let n = 0; n < 60; n += 1) {
    await guard.check();
    const rows = await page.evaluate(extractSearchCards);
    const ids = rows.map(r => r.href.split('&')[0]).join('|');
    if (rows.length && ids !== previousIds) {
      stable = ids === last ? stable + 1 : 0;
      if (stable >= 3) return rows;
      last = ids;
    }
    if (!rows.length && await page.getByText(/没有找到相关宝贝|未找到相关宝贝|没有找到相关商品/).count()) return [];
    await page.waitForTimeout(250);
  }
  throw searchError('SEARCH_RESULTS_UNAVAILABLE', '搜索结果未稳定显示或页面结构已变化，已停止；不把超时当作零结果。');
}

export async function loadSearchCardImages(page, guard, delayRange, initialRows) {
  // Freeze this batch before scrolling: image search may append another batch.
  const ids = new Set(initialRows.map(row => row.domItemId));
  let rows = initialRows;
  for (let step = 0; step < initialRows.length; step += 1) {
    const missing = rows.find(row => !normalizeSearchCard(row)?.imageUrl);
    if (!missing) return rows;
    if (!/^\d+$/.test(missing.domItemId || '')) throw searchError('SEARCH_SCHEMA_CHANGED', '缺少卡片 ID，无法加载主图。');
    await guardedSearchAction(page, guard, delayRange, () => page.locator(`#item_id_${missing.domItemId}`).scrollIntoViewIfNeeded({ timeout: 5000 }));
    for (let poll = 0; poll < 20; poll += 1) {
      await guard.check();
      const observed = await page.evaluate(extractSearchCards);
      rows = observed.filter(row => ids.has(row.domItemId));
      if (rows.length !== initialRows.length) throw searchError('SEARCH_BATCH_CHANGED', '滚动过程中当前商品批次发生变化。');
      if (normalizeSearchCard(rows.find(row => row.domItemId === missing.domItemId))?.imageUrl) break;
      await page.waitForTimeout(250);
      if (poll === 19) throw searchError('SEARCH_IMAGE_UNAVAILABLE', '商品主图未加载，停止并保留此前批次。');
    }
  }
  if (rows.some(row => !normalizeSearchCard(row)?.imageUrl)) throw searchError('SEARCH_IMAGE_UNAVAILABLE', '商品主图不完整。');
  return rows;
}

export async function collectSearchProducts(context, plan, report, onBatch) {
  const candidates = context.pages();
  const page = candidates.find(p => p.url().startsWith('https://s.taobao.com/search'))
    || candidates.find(p => p.url() === 'https://www.taobao.com/')
    || candidates.find(p => p.url() === 'about:blank')
    || await context.newPage();
  const guard = watchSearchVerification(page);
  try {
    // Keyword navigation establishes the search page whose image uploader updates
    // in place. The home-page uploader opens a popup and is intentionally unused.
    const queries = [...plan.keywords.map(keyword => ({ type: 'keyword', keyword })), ...plan.images.map((image, index) => ({ type: 'image', image, imageIndex: index + 1 }))];
    for (const query of queries) {
      let previousIds = '';
      if (query.type === 'image') {
        previousIds = (await page.evaluate(extractSearchCards)).map(r => r.href.split('&')[0]).join('|');
        await guardedSearchAction(page, guard, plan.delayRange, () => page.locator('.image-search-icon-pic').click({ timeout: 10000 }));
        const currentHash = createHash('sha256').update(await readFile(query.image.file)).digest('hex');
        if (currentHash !== query.image.sha256) throw searchError('SEARCH_IMAGE_CHANGED', '图片自预检后发生变化，请重新执行。');
        await guardedSearchAction(page, guard, plan.delayRange, () => page.locator('#image-search-custom-file-input').setInputFiles(query.image.file, { timeout: 10000 }));
        await page.locator('#image-search-upload-button.upload-button-active').waitFor({ state: 'visible', timeout: 15000 });
        await guardedSearchAction(page, guard, plan.delayRange, () => page.locator('#image-search-upload-button').click({ timeout: 10000 }));
      } else {
        const url = new URL('https://s.taobao.com/search');
        url.searchParams.set('q', query.keyword); url.searchParams.set('page', '1'); url.searchParams.set('tab', 'all'); url.searchParams.set('search_type', 'item');
        await guardedSearchAction(page, guard, plan.delayRange, () => page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 30000 }));
      }
      await guard.check();
      if (new URL(page.url()).hostname !== 's.taobao.com') throw searchError('SEARCH_PAGE_MISMATCH', '未到达淘宝商品搜索结果。');
      const pageLimit = query.type === 'image' ? 1 : plan.maxPages;
      for (let number = 1; number <= pageLimit; number += 1) {
        const initialRows = await waitCards(page, guard, previousIds);
        const rows = await loadSearchCardImages(page, guard, plan.delayRange, initialRows);
        const source = { type: query.type, ...(query.type === 'image' ? { imageIndex: query.imageIndex, imageSha256: query.image.sha256 } : { keyword: query.keyword }), page: number, capturedAt: new Date().toISOString() };
        appendSearchBatch(report.products, rows, source);
        const batch = { ...source, rawCount: rows.length, scope: query.type === 'image' ? 'initial-rendered-batch' : 'rendered-keyword-page', stopReason: rows.length ? (number === pageLimit ? 'requested-limit' : null) : 'explicit-empty' };
        report.batches.push(batch);
        await onBatch(report);
        if (!rows.length || number === pageLimit) break;
        const next = page.locator('button.next-medium.next-pagination-item.next-next');
        await next.waitFor({ state: 'visible', timeout: 10000 });
        await guard.check();
        if (await next.count() !== 1) throw searchError('SEARCH_PAGINATION_UNAVAILABLE', '下一页入口无法唯一识别。');
        if (!await next.isEnabled()) { batch.stopReason = 'last-page'; await onBatch(report); break; }
        previousIds = rows.map(r => r.href.split('&')[0]).join('|');
        await guardedSearchAction(page, guard, plan.delayRange, async () => {
          await next.click({ timeout: 10000 });
          await page.waitForURL(u => u.searchParams.get('page') === String(number + 1), { waitUntil: 'domcontentloaded', timeout: 15000 });
        });
      }
    }
  } finally { guard.dispose(); }
  return report;
}
