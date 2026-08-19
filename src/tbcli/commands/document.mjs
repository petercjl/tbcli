import fs from 'node:fs/promises';
import path from 'node:path';

import { withBrowserSession } from '../browser-session.mjs';
import {
  assertDingtalkDocumentUrl,
  extractDingtalkDocument,
  renderAlidocsPackage,
} from '../dingtalk-document.mjs';

const DOCUMENT_DATA_PATH = '/api/document/data';
const IMAGE_RESOURCE_PATH = '/core/api/resources/img/';
const ALIDOCS_OSS_IMAGE_HOST = 'alidocs.oss-cn-zhangjiakou.aliyuncs.com';
const ALIDOCS_OSS_IMAGE_PATH = '/lark/';
const ALIDOCS_OSS_ATTACHMENT_IMAGE_PATH = /^\/a\/\d+\/\d+\/[A-Za-z0-9-]+\.(?:png|jpe?g|webp|gif)$/i;

export async function runDocumentGet(opts = {}) {
  const sourceUrl = assertDingtalkDocumentUrl(opts.url || '').toString();
  const timeoutMs = boundedInteger(opts.timeoutMs, 30000, 5000, 120000, '--timeout-ms');
  const outputDir = path.resolve(opts.out || defaultOutputDirectory(sourceUrl));
  await assertOutputDoesNotExist(outputDir);

  const result = await withBrowserSession(opts, async ({ context }) => {
    const page = findDocumentPage(context.pages(), sourceUrl) || await context.newPage();
    const capturedImages = new Map();
    const onResponse = (response) => {
      const url = new URL(response.url());
      if (url.hostname !== 'alidocs.dingtalk.com' || !url.pathname.startsWith(IMAGE_RESOURCE_PATH)) return;
      capturedImages.set(url.pathname, response.body().catch(() => null));
    };
    page.on('response', onResponse);
    try {
      const responsePromise = page.waitForResponse(
        (response) => {
          const url = new URL(response.url());
          return url.hostname === 'alidocs.dingtalk.com' && url.pathname === DOCUMENT_DATA_PATH;
        },
        { timeout: timeoutMs },
      );
      await page.goto(sourceUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      const response = await responsePromise;
      if (!response.ok()) throw new Error(`钉钉文档数据请求失败：HTTP ${response.status()}`);
      const payload = await response.json();
      await assertDingtalkPageReadable(page);
      const extracted = extractDingtalkDocument(payload, sourceUrl);
      const rendered = renderAlidocsPackage(extracted.packageData, {
        title: extracted.metadata.title,
        sourceUrl: extracted.metadata.sourceUrl,
      });
      await page.waitForTimeout(1200);
      const files = await exportDocumentBundle({
        context,
        page,
        outputDir,
        timeoutMs,
        capturedImages,
        metadata: extracted.metadata,
        packageData: extracted.packageData,
        rendered,
        includeImages: opts.images !== false,
      });
      await assertDingtalkPageReadable(page);
      return {
        ...extracted.metadata,
        outputDir,
        textCharacters: rendered.text.length,
        tableCount: rendered.tables.length,
        imageCount: rendered.images.length,
        downloadedImages: files.downloadedImages,
        skippedImages: files.skippedImages,
        tabClosed: Boolean(opts.closeTab),
        files: files.paths,
      };
    } finally {
      page.off('response', onResponse);
      if (opts.closeTab && !page.isClosed()) {
        await page.close({ runBeforeUnload: false }).catch(() => {});
      }
    }
  });

  if (opts.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`已读取：${result.title}`);
    console.log(`正文字符：${result.textCharacters}`);
    console.log(`表格：${result.tableCount}；图片：${result.downloadedImages}/${result.imageCount}；跳过：${result.skippedImages}`);
    if (result.tabClosed) console.log('来源标签页：已关闭');
    console.log(`导出目录：${result.outputDir}`);
  }
  return result;
}

export async function exportDocumentBundle({
  context,
  page,
  outputDir,
  timeoutMs,
  capturedImages,
  metadata,
  packageData,
  rendered,
  includeImages = true,
}) {
  const tempDir = `${outputDir}.tmp-${process.pid}-${Date.now()}`;
  const imagesDir = path.join(tempDir, 'images');
  const paths = {};
  let downloadedImages = 0;
  let skippedImages = 0;
  try {
    await fs.mkdir(tempDir, { recursive: false, mode: 0o700 });
    if (includeImages && rendered.images.length) await fs.mkdir(imagesDir, { recursive: false, mode: 0o700 });
    paths.metadata = await writeJson(tempDir, 'metadata.json', metadata);
    paths.package = await writeJson(tempDir, 'document-package.json', packageData);
    paths.markdown = await writeText(tempDir, 'content.md', rendered.markdown);
    paths.text = await writeText(tempDir, 'content.txt', rendered.text);
    paths.tables = await writeJson(tempDir, 'tables.json', rendered.tables);

    const imageInventory = [];
    for (const image of rendered.images) {
      const inventory = { ...image, downloaded: false, actualSize: null, skippedReason: null };
      if (includeImages) {
        const source = new URL(image.sourcePath, metadata.sourceUrl);
        if (!isTrustedDingtalkImageUrl(source)) {
          inventory.skippedReason = 'invalid-or-non-image-resource-url';
          skippedImages += 1;
          imageInventory.push(inventory);
          continue;
        }
        const body = await readImageBody({ context, page, image, timeoutMs, capturedImages });
        const target = path.join(tempDir, image.localPath);
        await fs.writeFile(target, body, { flag: 'wx', mode: 0o600 });
        inventory.downloaded = true;
        inventory.actualSize = body.length;
        downloadedImages += 1;
      }
      imageInventory.push(inventory);
    }
    paths.images = await writeJson(tempDir, 'images.json', imageInventory);
    const manifest = {
      title: metadata.title,
      sourceUrl: metadata.sourceUrl,
      capturedAt: metadata.capturedAt,
      textCharacters: rendered.text.length,
      tableCount: rendered.tables.length,
      imageCount: rendered.images.length,
      downloadedImages,
      skippedImages,
      files: Object.fromEntries(Object.entries(paths).map(([key, value]) => [key, path.basename(value)])),
    };
    paths.manifest = await writeJson(tempDir, 'manifest.json', manifest);
    await fs.rename(tempDir, outputDir);
    return {
      downloadedImages,
      skippedImages,
      paths: Object.fromEntries(Object.entries(paths).map(([key, value]) => [key, path.join(outputDir, path.basename(value))])),
    };
  } catch (error) {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function assertDingtalkPageReadable(page) {
  const state = await page.evaluate(() => ({
    url: location.href,
    title: document.title,
    text: (document.body?.innerText || '').slice(0, 2000),
    hasPassword: Boolean(document.querySelector('input[type="password"]')),
  }));
  const combined = `${state.title}\n${state.text}`;
  if (!state.url.startsWith('https://alidocs.dingtalk.com/i/nodes/')) {
    throw new Error(`钉钉文档跳转到非预期页面，已停止：${state.url}`);
  }
  if (state.hasPassword || /安全验证|验证码|访问受限|暂无权限|申请访问|页面不存在|文件不存在/i.test(combined)) {
    throw new Error('检测到登录、验证、权限或文档不可用状态，已停止读取');
  }
}

async function readImageBody({ context, page, image, timeoutMs, capturedImages }) {
  const source = new URL(image.sourcePath, page.url());
  if (!isTrustedDingtalkImageUrl(source)) {
    throw new Error(`图片资源地址不受信任：${source.toString()}`);
  }
  const captured = await capturedImages.get(source.pathname);
  if (captured?.length) return captured;
  await page.waitForTimeout(randomInteger(1000, 2000));
  await assertDingtalkPageReadable(page);
  const response = await context.request.get(source.toString(), { timeout: timeoutMs });
  if (!response.ok()) throw new Error(`图片下载失败：HTTP ${response.status()}`);
  return response.body();
}

export function isTrustedDingtalkImageUrl(value) {
  let source;
  try {
    source = value instanceof URL ? value : new URL(value);
  } catch {
    return false;
  }
  if (source.protocol !== 'https:' || source.username || source.password || source.port) return false;
  if (source.hostname === 'alidocs.dingtalk.com') {
    return source.pathname.startsWith(IMAGE_RESOURCE_PATH);
  }
  return source.hostname === ALIDOCS_OSS_IMAGE_HOST
    && (source.pathname.startsWith(ALIDOCS_OSS_IMAGE_PATH)
      || ALIDOCS_OSS_ATTACHMENT_IMAGE_PATH.test(source.pathname));
}

function findDocumentPage(pages, sourceUrl) {
  const nodeId = new URL(sourceUrl).pathname.split('/').filter(Boolean).at(-1);
  return pages.find((page) => page.url().includes(`/i/nodes/${nodeId}`)) || null;
}

function defaultOutputDirectory(sourceUrl) {
  const nodeId = new URL(sourceUrl).pathname.split('/').filter(Boolean).at(-1);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `dingtalk-document-${nodeId}-${stamp}`;
}

async function assertOutputDoesNotExist(outputDir) {
  try {
    await fs.stat(outputDir);
    throw new Error(`输出目录已存在，拒绝覆盖：${outputDir}`);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
}

async function writeJson(dir, name, value) {
  return writeText(dir, name, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeText(dir, name, value) {
  const target = path.join(dir, name);
  await fs.writeFile(target, value, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return target;
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
