import fs from 'node:fs/promises';
import path from 'node:path';

import { withBrowserSession } from '../browser-session.mjs';
import { assertDingtalkDocumentUrl } from '../dingtalk-document.mjs';
import { countTree, normalizeDingtalkListing } from '../dingtalk-document-tree.mjs';
import { assertDingtalkPageReadable } from './document.mjs';

const LIST_PATH = '/box/api/v2/dentry/list';

export async function runDocumentTree(opts = {}) {
  const sourceUrl = assertDingtalkDocumentUrl(opts.url || '').toString();
  const rootId = nodeIdFromUrl(sourceUrl);
  const timeoutMs = boundedInteger(opts.timeoutMs, 30000, 5000, 120000, '--timeout-ms');
  const maxDepth = boundedInteger(opts.maxDepth, 20, 1, 50, '--max-depth');
  const minDelayMs = boundedInteger(opts.minDelayMs, 1000, 0, 60000, '--min-delay-ms');
  const maxDelayMs = boundedInteger(opts.maxDelayMs, 2000, minDelayMs, 60000, '--max-delay-ms');
  const outputPath = opts.out ? path.resolve(opts.out) : '';
  if (outputPath) await assertOutputDoesNotExist(outputPath);

  const result = await withBrowserSession(opts, async ({ context }) => {
    const page = findDocumentPage(context.pages(), rootId) || await context.newPage();
    const initialPromise = page.waitForResponse(
      (response) => isListingResponse(response.url(), rootId),
      { timeout: timeoutMs },
    );
    await page.goto(sourceUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    const initialResponse = await initialPromise;
    if (!initialResponse.ok()) throw new Error(`钉钉文档目录请求失败：HTTP ${initialResponse.status()}`);
    await assertDingtalkPageReadable(page);
    const requestHeaders = Object.fromEntries(
      (await initialResponse.request().headersArray()).map(({ name, value }) => [name.toLowerCase(), value]),
    );
    const listingHeaders = selectDingtalkListingHeaders(requestHeaders);
    const initial = normalizeDingtalkListing(await initialResponse.json(), rootId);
    const seen = new Set([rootId]);
    const children = await expandChildren(page, initial, {
      depth: 1,
      maxDepth,
      minDelayMs,
      maxDelayMs,
      timeoutMs,
      listingHeaders,
      seen,
    });
    await assertDingtalkPageReadable(page);
    return {
      title: initial.node.name,
      sourceUrl,
      capturedAt: new Date().toISOString(),
      maxDepth,
      nodeCount: countTree(children),
      root: { ...initial.node, children },
    };
  });

  if (outputPath) await writeJsonAtomic(outputPath, result);
  if (opts.json || !outputPath) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`已盘点：${result.title}`);
    console.log(`子文档与目录：${result.nodeCount}`);
    console.log(`目录清单：${outputPath}`);
  }
  return result;
}

async function expandChildren(page, listing, options) {
  const all = [...listing.children];
  let loadMoreId = listing.loadMoreId;
  let hasMore = listing.hasMore;
  while (hasMore) {
    const next = await fetchListing(page, listing.node.id, { ...options, loadMoreId });
    all.push(...next.children);
    hasMore = next.hasMore;
    loadMoreId = next.loadMoreId;
    if (hasMore && !loadMoreId) throw new Error(`目录 ${listing.node.name} 分页标记缺失，已停止`);
  }

  const output = [];
  for (const child of all) {
    if (options.seen.has(child.id)) throw new Error(`检测到循环或重复目录节点：${child.name}`);
    options.seen.add(child.id);
    let children = [];
    if (child.hasChildren && options.depth < options.maxDepth) {
      const childListing = await fetchListing(page, child.id, options);
      children = await expandChildren(page, childListing, { ...options, depth: options.depth + 1 });
    }
    output.push({ ...child, children });
  }
  return output;
}

async function fetchListing(page, nodeId, options) {
  await page.waitForTimeout(randomInteger(options.minDelayMs, options.maxDelayMs));
  await assertDingtalkPageReadable(page);
  const payload = await page.evaluate(async ({ nodeId, loadMoreId, headers }) => {
    const url = new URL('/box/api/v2/dentry/list', location.origin);
    url.searchParams.set('dentryUuid', nodeId);
    url.searchParams.set('listDentrySource', '2');
    url.searchParams.set('orderType', 'SORT_KEY');
    url.searchParams.set('pageSize', '100');
    url.searchParams.set('sortType', 'desc');
    if (loadMoreId) url.searchParams.set('loadMoreId', loadMoreId);
    const response = await fetch(url, { credentials: 'include', headers });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }, { nodeId, loadMoreId: options.loadMoreId || '', headers: options.listingHeaders });
  return normalizeDingtalkListing(payload, nodeId);
}

export function selectDingtalkListingHeaders(headers = {}) {
  const selected = {};
  for (const key of ['a-token', 'x-xsrf-token', 'bx-v', 'utm-medium', 'utm-source']) {
    if (typeof headers[key] === 'string' && headers[key]) selected[key] = headers[key];
  }
  if (!selected['a-token']) throw new Error('钉钉目录页缺少临时访问凭据，已停止读取');
  return selected;
}

function isListingResponse(value, nodeId) {
  try {
    const url = new URL(value);
    return url.hostname === 'alidocs.dingtalk.com'
      && url.pathname === LIST_PATH
      && url.searchParams.get('dentryUuid') === nodeId
      && url.searchParams.has('pageSize');
  } catch {
    return false;
  }
}

function findDocumentPage(pages, nodeId) {
  return pages.find((page) => page.url().includes(`/i/nodes/${nodeId}`)) || null;
}

function nodeIdFromUrl(value) {
  return new URL(value).pathname.split('/').filter(Boolean).at(-1);
}

async function assertOutputDoesNotExist(outputPath) {
  try {
    await fs.stat(outputPath);
    throw new Error(`输出文件已存在，拒绝覆盖：${outputPath}`);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
}

async function writeJsonAtomic(outputPath, value) {
  const parent = path.dirname(outputPath);
  const temp = path.join(parent, `.${path.basename(outputPath)}.tmp-${process.pid}-${Date.now()}`);
  await fs.mkdir(parent, { recursive: true });
  try {
    await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await fs.rename(temp, outputPath);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

function boundedInteger(value, fallback, min, max, option) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${option} 必须是 ${min}-${max} 的整数`);
  }
  return parsed;
}

function randomInteger(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}
