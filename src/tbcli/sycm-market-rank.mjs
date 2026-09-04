import fs from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from '@excel.js/exceljs';

import { waitBeforeTaobaoApiRequest } from './api-policy.mjs';
import {
  assertPageNotVerifying,
  createVerificationError,
  isVerificationSignal,
} from './taobao-guard.mjs';

export const SYCM_MARKET_RANK_ORIGIN = 'https://sycm.taobao.com';
export const SYCM_MARKET_RANK_PAGE_PATH = '/mc/free/market_rank';
export const SYCM_MARKET_RANK_API_PATH = '/mc/mq/mkt/item/offline/rank.json';

export const MARKET_RANK_HEADERS = Object.freeze([
  '榜单排名', '商品ID', '商品标题', '店铺', '店铺类型', '核心关键词', '支付买家数',
  '访客数', '所属价格带', '价格带排名', '商品链接', '店铺链接', '图片链接',
]);

export const MARKET_RANK_SEGMENTS = Object.freeze([
  Object.freeze({ id: '1', priceSeg: '1', minPrice: '0', maxPrice: '50', label: '0-50.0', sheetName: '0-50' }),
  Object.freeze({ id: '2', priceSeg: '2', minPrice: '50', maxPrice: '135', label: '50.0-135.0', sheetName: '50-135' }),
  Object.freeze({ id: '3', priceSeg: '3', minPrice: '135', maxPrice: '255', label: '135.0-255.0', sheetName: '135-255' }),
  Object.freeze({ id: '4', priceSeg: '4', minPrice: '255', maxPrice: '455', label: '255.0-455.0', sheetName: '255-455' }),
  Object.freeze({ id: '5', priceSeg: '5', minPrice: '455', maxPrice: '660', label: '455.0-660.0', sheetName: '455-660' }),
  Object.freeze({ id: '6', priceSeg: '6', minPrice: '660', maxPrice: '', label: '660.0以上', sheetName: '660以上' }),
]);

export function parseMarketRankCategoryUrl(value) {
  let url;
  try {
    url = new URL(String(value || '').trim());
  } catch {
    throw new Error('--category-url 必须是完整的生意参谋商品排行链接');
  }
  if (url.origin !== SYCM_MARKET_RANK_ORIGIN || url.pathname !== SYCM_MARKET_RANK_PAGE_PATH) {
    throw new Error('--category-url 必须是 sycm.taobao.com 的商品排行页链接');
  }
  const parentCateId = url.searchParams.get('parentCateId') || '';
  const cateId = url.searchParams.get('cateId') || '';
  if (!/^\d+$/.test(parentCateId) || !/^\d+$/.test(cateId)) {
    throw new Error('--category-url 缺少有效的 parentCateId 或 cateId');
  }
  return {
    parentCateId,
    cateId,
    cateFlag: url.searchParams.get('cateFlag') || '',
    url: url.toString(),
  };
}

export function resolveFourMarketRankWeeks(value) {
  const selected = parseIsoDate(value, '--last-week');
  const selectedDate = new Date(`${selected}T00:00:00Z`);
  const day = selectedDate.getUTCDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const finalStart = addUtcDays(selectedDate, mondayOffset);
  return Array.from({ length: 4 }, (_, index) => {
    const start = addUtcDays(finalStart, (index - 3) * 7);
    const end = addUtcDays(start, 6);
    return {
      index: index + 1,
      startDate: isoDate(start),
      endDate: isoDate(end),
      dateRange: `${isoDate(start)}|${isoDate(end)}`,
    };
  });
}

export function buildMarketRankPageUrl(category, week) {
  const url = new URL(category.url);
  url.searchParams.set('activeKey', 'item');
  url.searchParams.set('dateRange', week.dateRange);
  url.searchParams.set('dateType', 'week');
  url.searchParams.set('parentCateId', category.parentCateId);
  url.searchParams.set('cateId', category.cateId);
  if (category.cateFlag) url.searchParams.set('cateFlag', category.cateFlag);
  return url.toString();
}

export function buildMarketRankRequestUrl(capturedUrl, { week, segment, page }) {
  const url = new URL(capturedUrl);
  if (url.origin !== SYCM_MARKET_RANK_ORIGIN || url.pathname !== SYCM_MARKET_RANK_API_PATH) {
    throw new Error('拒绝使用非生意参谋商品排行请求');
  }
  url.searchParams.set('dateRange', week.dateRange);
  url.searchParams.set('dateType', 'week');
  url.searchParams.set('page', String(page));
  url.searchParams.set('pageSize', '100');
  url.searchParams.set('priceSeg', segment.priceSeg);
  url.searchParams.set('minPrice', segment.minPrice);
  url.searchParams.set('maxPrice', segment.maxPrice);
  url.searchParams.set('_', String(Date.now()));
  return url.toString();
}

export async function requestMarketRankJson(page, requestUrl, {
  delayRange,
  waitBeforeRequest = waitBeforeTaobaoApiRequest,
  assertPageSafe = assertPageNotVerifying,
} = {}) {
  const url = new URL(requestUrl);
  if (url.origin !== SYCM_MARKET_RANK_ORIGIN || url.pathname !== SYCM_MARKET_RANK_API_PATH) {
    throw new Error('拒绝访问非生意参谋商品排行数据');
  }
  const delayMs = await waitBeforeRequest(page, delayRange);
  const result = await page.evaluate(async (targetUrl) => {
    const response = await fetch(targetUrl, {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
      headers: { accept: 'application/json' },
    });
    return {
      status: response.status,
      redirected: response.redirected,
      responseUrl: response.url,
      contentType: response.headers.get('content-type') || '',
      body: await response.text(),
    };
  }, url.toString());
  await assertPageSafe(page);
  if (result.redirected || isVerificationSignal(`${result.responseUrl}\n${result.body}`)) {
    throw createVerificationError(result.responseUrl || '生意参谋商品排行验证信号');
  }
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`生意参谋商品排行请求失败：HTTP ${result.status}`);
  }
  let payload;
  try {
    payload = JSON.parse(result.body);
  } catch {
    throw new Error('生意参谋商品排行没有返回 JSON');
  }
  if (payload?.success === false || payload?.ok === false) {
    throw new Error(`生意参谋商品排行返回异常：${payload?.message || payload?.msg || payload?.code || 'unknown'}`);
  }
  const numericCode = payload?.code == null ? null : Number(payload.code);
  if (numericCode != null && Number.isFinite(numericCode) && ![0, 200].includes(numericCode)) {
    throw new Error(`生意参谋商品排行返回异常：${payload?.message || payload?.msg || payload.code}`);
  }
  return { payload, delayMs: Number(delayMs) || 0, status: result.status };
}

export function extractMarketRankPage(payload) {
  const candidates = [payload, payload?.data, payload?.data?.data].filter((value) => value && typeof value === 'object');
  for (const candidate of candidates) {
    const rows = [candidate.data, candidate.list, candidate.rows, candidate.records, candidate.recordList]
      .find(Array.isArray);
    if (!rows) continue;
    const rawCount = candidate.recordCount ?? candidate.totalCount ?? candidate.total ?? payload?.recordCount;
    const recordCount = Number(rawCount);
    if (!Number.isInteger(recordCount) || recordCount < 0) {
      throw new Error('生意参谋商品排行缺少有效 recordCount');
    }
    return { rows, recordCount };
  }
  throw new Error('无法识别生意参谋商品排行数据结构');
}

export async function fetchMarketRankSegment(page, capturedUrl, { week, segment, delayRange }, {
  request = requestMarketRankJson,
  maxPages = 100,
} = {}) {
  const rows = [];
  const seenItemIds = new Set();
  const requests = [];
  let recordCount = null;
  for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
    const requestUrl = buildMarketRankRequestUrl(capturedUrl, { week, segment, page: pageNumber });
    const response = await request(page, requestUrl, { delayRange });
    const pageData = extractMarketRankPage(response.payload);
    if (recordCount == null) recordCount = pageData.recordCount;
    if (pageData.recordCount !== recordCount) {
      throw new Error(`${segment.sheetName} 价格带分页过程中 recordCount 发生变化`);
    }
    if (!pageData.rows.length && rows.length < recordCount) {
      throw new Error(`${segment.sheetName} 价格带在第 ${pageNumber} 页提前返回空数据`);
    }
    const normalized = pageData.rows.map((row) => normalizeMarketRankRow(row, segment));
    for (const row of normalized) {
      const previousRank = rows.at(-1)?.rank ?? 0;
      if (row.rank <= previousRank) {
        throw new Error(`${segment.sheetName} 价格带排名未严格递增：${previousRank} 后出现 ${row.rank}`);
      }
      if (seenItemIds.has(row.itemId)) throw new Error(`${segment.sheetName} 价格带出现重复商品：${row.itemId}`);
      seenItemIds.add(row.itemId);
      rows.push(row);
    }
    requests.push({ page: pageNumber, rows: normalized.length, recordCount, delayMs: response.delayMs });
    if (rows.length >= recordCount) break;
  }
  if (recordCount == null || rows.length !== recordCount) {
    throw new Error(`${segment.sheetName} 价格带获取不完整：${rows.length}/${recordCount ?? '?'}`);
  }
  return { ...segment, recordCount, rows, requests };
}

export async function fetchMarketRankWeek(page, capturedUrl, { week, delayRange }, options = {}) {
  const segments = [];
  for (const segment of MARKET_RANK_SEGMENTS) {
    segments.push(await fetchMarketRankSegment(page, capturedUrl, { week, segment, delayRange }, options));
  }
  return { week, segments };
}

export function normalizeMarketRankRow(row, segment) {
  const rank = Number(row?.cateRankId?.value);
  if (!Number.isInteger(rank) || rank < 1) {
    throw new Error(`${segment.sheetName} 价格带缺少有效 cateRankId`);
  }
  const itemId = String(row?.itemId?.value ?? row?.item?.itemId ?? '').trim();
  if (!/^\d+$/.test(itemId)) throw new Error(`${segment.sheetName} 价格带第 ${rank} 名缺少商品 ID`);
  return {
    rank,
    itemId,
    title: String(row?.item?.title || ''),
    shop: String(row?.shop?.title || ''),
    shopType: row?.shop?.b2CShop ? '天猫' : '淘宝',
    coreKeyword: String(row?.coreKeyWord?.value || ''),
    payBuyerCount: String(row?.payByrCnt?.value ?? ''),
    uv: String(row?.uv?.value ?? ''),
    priceBand: segment.label,
    priceBandRank: rank,
    itemUrl: absoluteHttpsUrl(row?.item?.detailUrl),
    shopUrl: absoluteHttpsUrl(row?.shop?.shopUrl),
    imageUrl: absoluteHttpsUrl(row?.item?.pictUrl),
  };
}

export function buildMarketRankWorkbook(weekData) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'tbcli';
  workbook.created = new Date();
  for (const segment of weekData.segments) {
    const sheet = workbook.addWorksheet(segment.sheetName, {
      views: [{ state: 'frozen', xSplit: 2, ySplit: 1, showGridLines: false }],
    });
    sheet.addTable({
      name: `PriceBand${segment.priceSeg}`,
      ref: 'A1',
      headerRow: true,
      style: { theme: 'TableStyleMedium2', showRowStripes: true },
      columns: MARKET_RANK_HEADERS.map((name) => ({ name })),
      rows: segment.rows.map((row) => [
        row.rank, row.itemId, row.title, row.shop, row.shopType, row.coreKeyword,
        row.payBuyerCount, row.uv, row.priceBand, row.priceBandRank,
        row.itemUrl, row.shopUrl, row.imageUrl,
      ]),
    });
    setWidths(sheet, [10, 20, 52, 28, 11, 25, 15, 15, 16, 13, 54, 40, 54]);
    sheet.getColumn(2).numFmt = '@';
    for (let rowNumber = 2; rowNumber <= segment.rows.length + 1; rowNumber += 1) {
      sheet.getCell(rowNumber, 2).value = String(sheet.getCell(rowNumber, 2).value ?? '');
      sheet.getRow(rowNumber).alignment = { vertical: 'top' };
      sheet.getCell(rowNumber, 3).alignment = { vertical: 'top', wrapText: true };
    }
    const header = sheet.getRow(1);
    header.height = 24;
    header.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '2F75B5' } };
      cell.font = { bold: true, color: { argb: 'FFFFFF' } };
      cell.alignment = { vertical: 'middle', wrapText: true };
    });
    sheet.autoFilter = { from: 'A1', to: 'M1' };
  }
  return workbook;
}

export async function inspectMarketRankWorkbook(buffer, expectedCounts = {}) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const names = workbook.worksheets.map((sheet) => sheet.name);
  const expectedNames = MARKET_RANK_SEGMENTS.map((segment) => segment.sheetName);
  if (JSON.stringify(names) !== JSON.stringify(expectedNames)) {
    throw new Error(`Excel 工作表不符合预期：${names.join('、')}`);
  }
  const sheets = [];
  for (const sheet of workbook.worksheets) {
    const headers = Array.from({ length: MARKET_RANK_HEADERS.length }, (_, index) => sheet.getCell(1, index + 1).text);
    if (JSON.stringify(headers) !== JSON.stringify(MARKET_RANK_HEADERS)) {
      throw new Error(`${sheet.name} 工作表列头不符合预期`);
    }
    const rows = Math.max(0, sheet.rowCount - 1);
    if (expectedCounts[sheet.name] != null && rows !== expectedCounts[sheet.name]) {
      throw new Error(`${sheet.name} 工作表行数不符合预期：${rows}/${expectedCounts[sheet.name]}`);
    }
    let previousRank = 0;
    for (let index = 1; index <= rows; index += 1) {
      const rank = Number(sheet.getCell(index + 1, 1).value);
      const priceBandRank = Number(sheet.getCell(index + 1, 10).value);
      if (!Number.isInteger(rank) || rank <= previousRank || priceBandRank !== rank) {
        throw new Error(`${sheet.name} 工作表排名未严格递增或两个排名列不一致：第 ${index + 1} 行`);
      }
      previousRank = rank;
      if (!/^\d+$/.test(String(sheet.getCell(index + 1, 2).text || ''))) {
        throw new Error(`${sheet.name} 工作表商品 ID 不是文本数字`);
      }
    }
    sheets.push({ name: sheet.name, rows });
  }
  return { sheets };
}

export async function writeMarketRankWorkbookNew(target, weekData) {
  const workbook = buildMarketRankWorkbook(weekData);
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, buffer, { flag: 'wx', mode: 0o600 });
  const expectedCounts = Object.fromEntries(weekData.segments.map((segment) => [segment.sheetName, segment.rows.length]));
  const inspection = await inspectMarketRankWorkbook(buffer, expectedCounts);
  const stat = await fs.stat(target);
  if (stat.size !== buffer.length) throw new Error(`Excel 写入不完整：${target}`);
  return { output: target, bytes: stat.size, mode: `0${(stat.mode & 0o777).toString(8)}`, workbook: inspection };
}

export async function assertMarketRankOutputsAbsent(targets) {
  for (const target of targets) {
    try {
      const stat = await fs.stat(target);
      throw new Error(`输出文件已存在，拒绝覆盖：${target}（${stat.size} bytes）`);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

function parseIsoDate(value, option) {
  const text = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error(`${option} 必须是 YYYY-MM-DD`);
  const date = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(date.valueOf()) || isoDate(date) !== text) throw new Error(`${option} 不是有效日期`);
  return text;
}

function addUtcDays(date, days) {
  const copy = new Date(date.valueOf());
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function absoluteHttpsUrl(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text.startsWith('//')) return `https:${text}`;
  try {
    const url = new URL(text, SYCM_MARKET_RANK_ORIGIN);
    return url.protocol === 'https:' ? url.toString() : '';
  } catch {
    return '';
  }
}

function setWidths(sheet, widths) {
  widths.forEach((width, index) => { sheet.getColumn(index + 1).width = width; });
}
