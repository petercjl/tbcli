import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  MARKET_RANK_HEADERS,
  MARKET_RANK_SEGMENTS,
  assertMarketRankOutputsAbsent,
  buildMarketRankRequestUrl,
  buildMarketRankWorkbook,
  extractMarketRankPage,
  fetchMarketRankSegment,
  inspectMarketRankWorkbook,
  parseMarketRankCategoryUrl,
  requestMarketRankJson,
  resolveFourMarketRankWeeks,
} from '../src/tbcli/sycm-market-rank.mjs';

const CATEGORY_URL = 'https://sycm.taobao.com/mc/free/market_rank?activeKey=item&dateRange=2026-08-24%7C2026-08-30&dateType=week&parentCateId=50010101&cateId=50003449&cateFlag=2';
const CAPTURED_URL = 'https://sycm.taobao.com/mc/mq/mkt/item/offline/rank.json?dateRange=2026-08-24%7C2026-08-30&dateType=week&pageSize=10&page=1&cateId=50003449&rankType=gmv&minPrice=&maxPrice=&priceSeg=2&sellerType=-1&keyWord=&cateFlag=0&indexCode=payByrCnt%2Cuv&marketVersion=free&token=secret';

test('category URL parsing keeps category identity while allowing the page cateFlag', () => {
  const category = parseMarketRankCategoryUrl(CATEGORY_URL);
  assert.deepEqual({
    parentCateId: category.parentCateId,
    cateId: category.cateId,
    cateFlag: category.cateFlag,
  }, { parentCateId: '50010101', cateId: '50003449', cateFlag: '2' });
  assert.throws(() => parseMarketRankCategoryUrl('https://example.com/mc/free/market_rank?cateId=1'), /sycm\.taobao\.com/);
});

test('last-week accepts any date and resolves four Monday-to-Sunday periods', () => {
  assert.deepEqual(resolveFourMarketRankWeeks('2026-08-26').map(({ startDate, endDate }) => ({ startDate, endDate })), [
    { startDate: '2026-08-03', endDate: '2026-08-09' },
    { startDate: '2026-08-10', endDate: '2026-08-16' },
    { startDate: '2026-08-17', endDate: '2026-08-23' },
    { startDate: '2026-08-24', endDate: '2026-08-30' },
  ]);
  assert.equal(resolveFourMarketRankWeeks('2027-01-03')[0].startDate, '2026-12-07');
});

test('ranking request changes only runtime pagination, period and price-band fields', () => {
  const url = new URL(buildMarketRankRequestUrl(CAPTURED_URL, {
    week: { dateRange: '2026-08-03|2026-08-09' },
    segment: MARKET_RANK_SEGMENTS[5],
    page: 4,
  }));
  assert.equal(url.searchParams.get('cateId'), '50003449');
  assert.equal(url.searchParams.get('cateFlag'), '0');
  assert.equal(url.searchParams.get('token'), 'secret');
  assert.equal(url.searchParams.get('dateRange'), '2026-08-03|2026-08-09');
  assert.equal(url.searchParams.get('page'), '4');
  assert.equal(url.searchParams.get('pageSize'), '100');
  assert.equal(url.searchParams.get('priceSeg'), '6');
  assert.equal(url.searchParams.get('minPrice'), '660');
  assert.equal(url.searchParams.get('maxPrice'), '');
});

test('ranking request uses guarded delay before the browser request and a post guard', async () => {
  const events = [];
  const page = {
    evaluate: async (_fn, requestUrl) => {
      events.push(`request:${new URL(requestUrl).pathname}`);
      return {
        status: 200,
        redirected: false,
        responseUrl: requestUrl,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: { recordCount: 0, data: [] } }),
      };
    },
  };
  const result = await requestMarketRankJson(page, CAPTURED_URL, {
    delayRange: { minDelayMs: 1000, maxDelayMs: 2000 },
    waitBeforeRequest: async () => { events.push('guarded-delay'); return 1234; },
    assertPageSafe: async () => events.push('post-guard'),
  });
  assert.equal(result.delayMs, 1234);
  assert.deepEqual(events, ['guarded-delay', 'request:/mc/mq/mkt/item/offline/rank.json', 'post-guard']);
});

test('ranking request stops before request when the safety guard rejects', async () => {
  let requested = false;
  await assert.rejects(() => requestMarketRankJson({
    evaluate: async () => { requested = true; },
  }, CAPTURED_URL, {
    waitBeforeRequest: async () => { throw new Error('VERIFY_REQUIRED'); },
    assertPageSafe: async () => {},
  }), /VERIFY_REQUIRED/);
  assert.equal(requested, false);
});

test('page extraction accepts the live recordCount plus data shape', () => {
  assert.deepEqual(extractMarketRankPage({ success: true, data: { recordCount: 1, data: [{ id: 1 }] } }), {
    recordCount: 1,
    rows: [{ id: 1 }],
  });
});

test('server page-size cap does not corrupt ranks after item 20', async () => {
  const total = 45;
  const segment = MARKET_RANK_SEGMENTS[0];
  const calls = [];
  const result = await fetchMarketRankSegment({}, CAPTURED_URL, {
    week: { dateRange: '2026-08-24|2026-08-30' },
    segment,
    delayRange: { minDelayMs: 1000, maxDelayMs: 2000 },
  }, {
    request: async (_page, requestUrl) => {
      const pageNumber = Number(new URL(requestUrl).searchParams.get('page'));
      calls.push(pageNumber);
      const start = (pageNumber - 1) * 20;
      const count = Math.max(0, Math.min(20, total - start));
      return {
        delayMs: 1000 + pageNumber,
        payload: {
          success: true,
          data: {
            recordCount: total,
            data: Array.from({ length: count }, (_, index) => makeRow(start + index + 1)),
          },
        },
      };
    },
  });
  assert.deepEqual(calls, [1, 2, 3]);
  assert.equal(result.rows.length, 45);
  assert.equal(result.rows[20].rank, 21);
  assert.equal(result.rows[20].priceBandRank, 21);
  assert.equal(result.rows[44].rank, 45);
});

test('ranking preserves a stable platform gap instead of inventing a missing rank', async () => {
  const sourceRanks = [...Array.from({ length: 34 }, (_, index) => index + 1), ...Array.from({ length: 11 }, (_, index) => index + 36)];
  const result = await fetchMarketRankSegment({}, CAPTURED_URL, {
    week: { dateRange: '2026-08-24|2026-08-30' },
    segment: MARKET_RANK_SEGMENTS[0],
    delayRange: {},
  }, {
    request: async (_page, requestUrl) => {
      const pageNumber = Number(new URL(requestUrl).searchParams.get('page'));
      const ranks = sourceRanks.slice((pageNumber - 1) * 20, pageNumber * 20);
      return {
        payload: { data: { recordCount: sourceRanks.length, data: ranks.map(makeRow) } },
        delayMs: 1000,
      };
    },
  });
  assert.equal(result.rows[33].rank, 34);
  assert.equal(result.rows[34].rank, 36);
});

test('outer helper rank cannot override the returned cateRankId', async () => {
  const row = makeRow(21);
  row.rank = 101;
  const result = await fetchMarketRankSegment({}, CAPTURED_URL, {
    week: { dateRange: '2026-08-24|2026-08-30' },
    segment: MARKET_RANK_SEGMENTS[0],
    delayRange: {},
  }, {
    request: async () => ({ payload: { data: { recordCount: 1, data: [row] } }, delayMs: 1000 }),
  });
  assert.equal(result.rows[0].rank, 21);
});

test('workbook has exactly six price-band sheets, thirteen columns and continuous ranks', async () => {
  const segments = MARKET_RANK_SEGMENTS.map((segment) => ({
    ...segment,
    rows: Array.from({ length: 25 }, (_, index) => ({
      rank: index + 1,
      itemId: String(900000000000000000n + BigInt(index)),
      title: `商品${index + 1}`,
      shop: '测试店铺',
      shopType: '天猫',
      coreKeyword: '关键词',
      payBuyerCount: '10 ~ 50',
      uv: '100 ~ 250',
      priceBand: segment.label,
      priceBandRank: index + 1,
      itemUrl: 'https://sycm.taobao.com/item',
      shopUrl: 'https://shop.example.com/',
      imageUrl: 'https://img.example.com/a.jpg',
    })),
  }));
  const workbook = buildMarketRankWorkbook({ week: {}, segments });
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  const inspection = await inspectMarketRankWorkbook(buffer, Object.fromEntries(segments.map((segment) => [segment.sheetName, 25])));
  assert.deepEqual(inspection.sheets.map((sheet) => sheet.name), MARKET_RANK_SEGMENTS.map((segment) => segment.sheetName));
  assert.equal(workbook.getWorksheet('0-50').getRow(1).cellCount, MARKET_RANK_HEADERS.length);
  assert.equal(workbook.getWorksheet('0-50').getCell('A22').value, 21);
  assert.equal(typeof workbook.getWorksheet('0-50').getCell('B2').value, 'string');
});

test('output preflight refuses an existing workbook', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tbcli-market-rank-'));
  const target = path.join(directory, 'existing.xlsx');
  await fs.writeFile(target, Buffer.from('owned'), { flag: 'wx' });
  await assert.rejects(() => assertMarketRankOutputsAbsent([target]), /拒绝覆盖/);
});

function makeRow(rank) {
  return {
    uv: { value: '100 ~ 250' },
    itemId: { value: String(800000000000 + rank) },
    item: {
      itemId: String(800000000000 + rank),
      pictUrl: '//img.alicdn.com/test.jpg',
      detailUrl: '//sycm.taobao.com/mc/common/tb_item_redirect.htm?mi_id=test',
      title: `商品${rank}`,
    },
    coreKeyWord: { value: '关键词' },
    shop: { b2CShop: rank % 2 === 0, title: `店铺${rank}`, shopUrl: '//shop.taobao.com' },
    payByrCnt: { value: '10 ~ 50' },
    cateRankId: { value: rank },
  };
}
