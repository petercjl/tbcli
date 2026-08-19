import assert from 'node:assert/strict';
import test from 'node:test';
import ExcelJS from '@excel.js/exceljs';

import {
  assertRequestedDateRange,
  buildDirectSycmMaster,
  buildTemporaryReportPayload,
  deleteTemporarySycmReport,
  fetchSycmDownload,
  findSycmReportByName,
  generateSycmDownload,
  getSycmCatalog,
  getSycmValidDateRange,
  inspectSycmWorkbook,
  normalizeSycmReport,
  parseItemIds,
  requestSycmJson,
  filterFieldsByDevice,
  resolveDeviceSelection,
  resolveFieldSelection,
} from '../src/tbcli/commands/sycm-reports.mjs';

test('normalizeSycmReport exposes business metadata without account identifiers', () => {
  const result = normalizeSycmReport({
    id: 5767985,
    reportName: '店铺-整体-全周期',
    datasource: '电商后台',
    channelName: '天猫淘宝',
    dataPlatform: '生意参谋',
    dataType: '店铺',
    dataDimension: '整体',
    dateType: 'day',
    startDate: '2025-07-15T00:00:00.000+08:00',
    endDate: '2026-08-18T00:00:00.000+08:00',
    indicators: '["uv_1d_001","pay_ord_amt_1d_001"]',
    dims: '{"device":["all"]}',
    isAutoUpdate: '0',
    creator: { accountId: 123 },
  });
  assert.equal(result.id, 5767985);
  assert.equal(result.indicatorCount, 2);
  assert.deepEqual(result.filters, { device: ['all'] });
  assert.equal(result.startDate, '2025-07-15');
  assert.equal('creator' in result, false);
});

test('requestSycmJson applies the guarded delay before every request', async () => {
  const events = [];
  const page = {
    evaluate: async (_fn, request) => {
      events.push(`request:${new URL(request.requestUrl).pathname}`);
      return {
        status: 200,
        redirected: false,
        responseUrl: request.requestUrl,
        body: JSON.stringify({ code: 200, ok: true, data: { value: 1 } }),
      };
    },
  };
  const result = await requestSycmJson(page, '/lyone/fetchData/test.json', {
    delayRange: { minDelayMs: 1000, maxDelayMs: 2000 },
    waitBeforeRequest: async () => events.push('guarded-delay'),
    assertPageSafe: async () => events.push('post-guard'),
  });
  assert.equal(result.data.value, 1);
  assert.deepEqual(events, ['guarded-delay', 'request:/lyone/fetchData/test.json', 'post-guard']);
});

test('requestSycmJson sends JSON POST bodies through the same guarded path', async () => {
  let browserRequest;
  const page = {
    evaluate: async (_fn, request) => {
      browserRequest = request;
      return {
        status: 200,
        redirected: false,
        responseUrl: request.requestUrl,
        body: JSON.stringify({ code: 200, ok: true, data: { id: 1 } }),
      };
    },
  };
  await requestSycmJson(page, '/lyone/fetchData/createReport.json', {
    method: 'POST',
    body: { startDate: '2026-08-18' },
    waitBeforeRequest: async () => {},
    assertPageSafe: async () => {},
  });
  assert.equal(browserRequest.requestMethod, 'POST');
  assert.deepEqual(browserRequest.requestBody, { startDate: '2026-08-18' });
});

test('requestSycmJson stops before the request when the guard rejects', async () => {
  let requested = false;
  await assert.rejects(() => requestSycmJson({
    evaluate: async () => { requested = true; },
  }, '/lyone/fetchData/test.json', {
    delayRange: { minDelayMs: 1000, maxDelayMs: 2000 },
    waitBeforeRequest: async () => { throw new Error('VERIFY_REQUIRED'); },
    assertPageSafe: async () => {},
  }), /VERIFY_REQUIRED/);
  assert.equal(requested, false);
});

test('requestSycmJson refuses endpoints outside the pinned SYCM fetch-data path', async () => {
  await assert.rejects(() => requestSycmJson({}, 'https://example.com/data.json', {
    waitBeforeRequest: async () => {},
    assertPageSafe: async () => {},
  }), /拒绝访问非生意参谋取数接口/);
});

test('findSycmReportByName requires an exact unique name', async () => {
  const list = async () => ({
    reportList: [
      { id: 1, reportName: '店铺-整体-全周期' },
      { id: 2, reportName: '店铺-整体-30日' },
    ],
  });
  const report = await findSycmReportByName({}, '店铺-整体-全周期', {}, { list });
  assert.equal(report.id, 1);
  await assert.rejects(
    () => findSycmReportByName({}, '店铺', {}, { list }),
    /没有找到名称完全匹配/,
  );
});

test('temporary report payload reuses the mother report and changes only runtime fields', () => {
  const payload = buildTemporaryReportPayload({
    datasource: '电商后台',
    channelName: '天猫淘宝',
    dataPlatform: '生意参谋',
    shopIds: '["2053"]',
    dataType: '店铺',
    dataDimension: '整体',
    dateType: 'day',
    indicators: '["uv_1d_001","pay_ord_amt_1d_001"]',
    dims: '',
    customFilters: '',
    itemIds: null,
    isAutoUpdate: '1',
    autoUpdateCycle: 30,
    isDataFormat: 'N',
  }, {
    startDate: '2025-10-10',
    endDate: '2026-07-10',
    reportName: 'tbcli-temp-12345678',
  });
  assert.deepEqual(payload.shopIds, ['2053']);
  assert.deepEqual(payload.indicators, ['uv_1d_001', 'pay_ord_amt_1d_001']);
  assert.equal(payload.startDate, '2025-10-10');
  assert.equal(payload.endDate, '2026-07-10');
  assert.equal(payload.reportName, 'tbcli-temp-12345678');
  assert.equal(payload.isAutoUpdate, '0');
  assert.equal('id' in payload, false);
});

test('field selection accepts exact Chinese names or codes and rejects ambiguity', () => {
  const fields = [
    { code: 'shop_id', name: '店铺ID', bizType: 'dim' },
    { code: 'scene_name', name: '场景名称', bizType: 'index', dataType: 'STRING' },
    { code: 'uv_1d_001', name: '访客数', bizType: 'index' },
    { code: 'pay_amt', name: '支付金额', bizType: 'index' },
    { code: 'pay_amt_pc', name: '支付金额', bizType: 'index' },
  ];
  assert.deepEqual(resolveFieldSelection('访客数,pay_amt', fields).map((field) => field.code), [
    'shop_id', 'scene_name', 'uv_1d_001', 'pay_amt',
  ]);
  assert.equal(resolveFieldSelection('all', fields).length, 5);
  assert.throws(() => resolveFieldSelection('支付金额', fields), /对应多个字段/);
  assert.throws(() => resolveFieldSelection('不存在', fields), /没有字段/);
});

test('item ID selection accepts comma, Chinese comma, and whitespace with a 100-item limit', () => {
  assert.deepEqual(parseItemIds('631249289145，635607974988 650978994929,631249289145'), [
    '631249289145', '635607974988', '650978994929',
  ]);
  assert.throws(() => parseItemIds('631249289145,bad-id'), /只能包含数字商品 ID/);
  assert.throws(() => parseItemIds(Array.from({ length: 101 }, (_, index) => index + 1).join(',')), /最多支持 100/);
});

test('device selection keeps identity fields and the requested terminal metrics', () => {
  const fields = [
    { code: 'item_id', deviceType: 'none' },
    { code: 'overall_uv', deviceType: '0' },
    { code: 'wireless_uv', deviceType: '2' },
    { code: 'pc_uv', deviceType: '1' },
  ];
  assert.equal(resolveDeviceSelection('所有终端', true), 'all');
  assert.equal(resolveDeviceSelection('无线端', true), 'wireless');
  assert.deepEqual(filterFieldsByDevice(fields, 'pc').map((field) => field.code), ['item_id', 'pc_uv']);
  assert.throws(() => resolveDeviceSelection('pc', false), /不支持终端类型筛选/);
});

test('direct product master carries selected item IDs and all terminal fields', async () => {
  const responses = [
    { data: ['day'] },
    { data: [{ columnName: 'is_online', columnNameZh: '商品状态', filterType: 'enum', columnEnums: ['Y', 'N'] }] },
    { data: { needFilterDeviceType: true, indicators: {
      item_id: { columnNameZh: '商品ID', dataType: 'STRING', bizType: 'index', deviceType: 'none', columnIndex: 1 },
      overall_uv: { columnNameZh: '总体访客数', dataType: 'BIGINT', bizType: 'index', deviceType: '0', columnIndex: 2 },
      wireless_uv: { columnNameZh: '无线访客数', dataType: 'BIGINT', bizType: 'index', deviceType: '2', columnIndex: 3 },
      pc_uv: { columnNameZh: 'PC访客数', dataType: 'BIGINT', bizType: 'index', deviceType: '1', columnIndex: 4 },
    } } },
    { data: [{ id: 2053, haveAuth: true }] },
  ];
  const master = await buildDirectSycmMaster({}, {
    dataPlatform: '生意参谋', dataType: '商品', dataDimension: '整体', dateType: 'day',
    fields: 'all', device: 'all', itemIds: '631249289145,635607974988,650978994929',
    request: async () => responses.shift(),
  });
  assert.deepEqual(JSON.parse(master.itemIds), ['631249289145', '635607974988', '650978994929']);
  assert.deepEqual(JSON.parse(master.indicators), ['item_id', 'overall_uv', 'wireless_uv', 'pc_uv']);
  assert.deepEqual(JSON.parse(master.dims), { is_online: ['Y', 'N'] });
  assert.equal(master.directDevice, 'all');
});

test('requested date range must stay inside the live SYCM allowance', () => {
  const validRange = { startDate: '2025-07-15', endDate: '2026-08-18' };
  assert.doesNotThrow(() => assertRequestedDateRange({
    startDate: '2025-10-10',
    endDate: '2026-07-10',
    validRange,
  }));
  assert.throws(() => assertRequestedDateRange({
    startDate: '2015-10-10',
    endDate: '2026-07-10',
    validRange,
  }), /当前可取范围/);
});

test('valid range rounds a late-night lower boundary up to the first full day', async () => {
  const result = await getSycmValidDateRange({}, {
    channelName: '天猫淘宝',
    dataPlatform: '生意参谋',
    dataType: '店铺',
    dataDimension: '整体',
    dateType: 'day',
  }, {}, {
    request: async () => ({
      data: {
        dateStart: '2025-07-14 23:59:59',
        dateEnd: '2026-08-18 23:59:59',
      },
    }),
  });
  assert.deepEqual(result, { startDate: '2025-07-15', endDate: '2026-08-18' });
});

test('full catalog returns fields, selected date type, filters, and valid period', async () => {
  const responses = [
    { data: ['day', 'week'] },
    { data: [] },
    { data: { needFilterDeviceType: false, indicators: { uv: { columnNameZh: '访客数', dataType: 'BIGINT', bizType: 'index' } } } },
    { data: { dateStart: '2025-07-14 23:59:59', dateEnd: '2026-08-18 23:59:59' } },
  ];
  const result = await getSycmCatalog({}, {
    dataPlatform: '生意参谋', dataType: '店铺', dataDimension: '整体', dateType: 'day',
    request: async () => responses.shift(),
  });
  assert.equal(result.dateType, 'day');
  assert.deepEqual(result.validPeriod, { startDate: '2025-07-15', endDate: '2026-08-18' });
  assert.equal(result.fields[0].name, '访客数');
});

test('temporary cleanup verifies both the tbcli prefix and current report identity', async () => {
  const calls = [];
  await deleteTemporarySycmReport({}, {
    id: 99,
    reportName: 'tbcli-temp-12345678',
  }, {}, {
    getReport: async () => ({ id: 99, reportName: 'tbcli-temp-12345678' }),
    request: async (_page, endpoint, options) => calls.push({ endpoint, options }),
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, 'POST');
  assert.deepEqual(calls[0].options.body, { reportId: '99' });
  await assert.rejects(() => deleteTemporarySycmReport({}, {
    id: 100,
    reportName: '用户报表',
  }, {}, {
    getReport: async () => ({ id: 100, reportName: '用户报表' }),
    request: async () => {},
  }), /拒绝删除非 tbcli 临时报表/);
});

test('generateSycmDownload delays through the shared request helper on every poll', async () => {
  const endpoints = [];
  const responses = [
    { code: 200, data: true },
    { code: 200, data: { status: '2', url: null } },
    { code: 200, data: { status: '1', url: 'https://one-fetch-report.oss-cn-zhangjiakou.aliyuncs.com/reports/test.xlsx?Signature=x' } },
  ];
  const result = await generateSycmDownload({}, '5767985', {
    delayRange: { minDelayMs: 1000, maxDelayMs: 2000 },
    timeoutMs: 5000,
    now: () => 0,
    request: async (_page, endpoint) => {
      endpoints.push(endpoint);
      return responses.shift();
    },
  });
  assert.equal(result.status, '1');
  assert.deepEqual(endpoints.map((endpoint) => new URL(endpoint, 'https://sycm.taobao.com').pathname), [
    '/lyone/fetchData/download.json',
    '/lyone/fetchData/queryDownloadUrl.json',
    '/lyone/fetchData/queryDownloadUrl.json',
  ]);
});

test('fetchSycmDownload pins the official download host and validates XLSX magic bytes', async () => {
  const buffer = await fetchSycmDownload(
    'https://one-fetch-report.oss-cn-zhangjiakou.aliyuncs.com/reports/test.xlsx?Signature=x',
    {
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        arrayBuffer: async () => Uint8Array.from([0x50, 0x4b, 0x03, 0x04]).buffer,
      }),
    },
  );
  assert.deepEqual([...buffer], [0x50, 0x4b, 0x03, 0x04]);
  await assert.rejects(
    () => fetchSycmDownload('https://example.com/reports/test.xlsx'),
    /不受信任的下载地址/,
  );
});

test('downloaded workbook summary reconciles requested and returned product IDs', async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('data');
  sheet.addRow(['统计日期', '店铺名称', '商品ID', '支付金额']);
  sheet.addRow(['2025-07-15', '测试店', '635607974988', 0]);
  sheet.addRow(['2025-08-01', '测试店', '635607974988', 1]);
  const summary = await inspectSycmWorkbook(Buffer.from(await workbook.xlsx.writeBuffer()), [
    '631249289145', '635607974988', '650978994929',
  ], { dateType: 'day' });
  assert.equal(summary.rows, 2);
  assert.deepEqual(summary.returnedItemIds, ['635607974988']);
  assert.deepEqual(summary.itemIdsWithoutRows, ['631249289145', '650978994929']);
  assert.deepEqual(summary.dataPeriod, { startDate: '2025-07-15', endDate: '2025-08-01' });
});

test('downloaded workbook validation requires daily and requested product identity columns', async () => {
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('data').addRow(['店铺名称', '支付金额']);
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  await assert.rejects(() => inspectSycmWorkbook(buffer, [], { dateType: 'day' }), /缺少“统计日期”列/);
  await assert.rejects(() => inspectSycmWorkbook(buffer, ['635607974988']), /缺少“商品ID”列/);
});
