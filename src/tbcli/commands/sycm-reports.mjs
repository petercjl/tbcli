import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import ExcelJS from '@excel.js/exceljs';

import { resolveApiDelayRange, waitBeforeTaobaoApiRequest } from '../api-policy.mjs';
import { withAuthenticatedTaobaoSession } from '../browser-session.mjs';
import {
  assertPageNotVerifying,
  createVerificationError,
  isVerificationSignal,
} from '../taobao-guard.mjs';

const SYCM_REPORTS_URL = 'https://sycm.taobao.com/adm/v3/micro/auto_analysis/my_space';
const SYCM_ORIGIN = 'https://sycm.taobao.com';
const FETCH_DATA_PREFIX = '/lyone/fetchData/';
const DOWNLOAD_HOST = 'one-fetch-report.oss-cn-zhangjiakou.aliyuncs.com';
const DOWNLOAD_SUCCESS = '1';
const DOWNLOAD_PROCESSING = '2';
const DOWNLOAD_FAILED = '3';

export async function runSycmCatalog(opts = {}) {
  const dataPlatform = String(opts.dataPlatform || '').trim();
  const dataType = String(opts.dataType || '').trim();
  const dataDimension = String(opts.dataDimension || '').trim();
  if ((!dataPlatform && (dataType || dataDimension)) || (!dataType && dataDimension)) {
    throw new Error('目录层级必须按 --data-platform、--data-type、--data-dimension 的顺序指定');
  }
  const delayRange = resolveApiDelayRange(opts);
  await withAuthenticatedTaobaoSession({ ...opts, startUrl: SYCM_REPORTS_URL }, async ({ context }) => {
    const page = await ensureSycmPage(context, delayRange);
    const catalog = await getSycmCatalog(page, {
      dataPlatform, dataType, dataDimension, dateType: String(opts.dateType || '').trim(), delayRange,
    });
    if (opts.json) console.log(JSON.stringify(catalog, null, 2));
    else printSycmCatalog(catalog);
  });
}

export async function runSycmReports(opts = {}) {
  const keyword = String(opts.keyword || '').trim();
  const currentPage = boundedInteger(opts.page, 1, 1, 10000, '--page');
  const pageSize = boundedInteger(opts.pageSize, 100, 1, 100, '--page-size');
  const delayRange = resolveApiDelayRange(opts);

  await withAuthenticatedTaobaoSession({ ...opts, startUrl: SYCM_REPORTS_URL }, async ({ context }) => {
    const page = await ensureSycmPage(context, delayRange);
    const payload = await listSycmReports(page, {
      keyword,
      currentPage,
      pageSize,
      delayRange,
    });
    const result = {
      currentPage: payload.currentPage,
      pageSize,
      total: payload.totalCnt,
      reports: payload.reportList.map(normalizeSycmReport),
    };

    if (opts.json) console.log(JSON.stringify(result, null, 2));
    else {
      if (!result.reports.length) {
        console.log(keyword ? `没有找到名称包含“${keyword}”的取数报表` : '没有找到取数报表');
        return;
      }
      for (const report of result.reports) {
        console.log(`${report.id}\t${report.name}\t${report.dataType}-${report.dataDimension}\t${report.startDate}～${report.endDate}\t${report.indicatorCount}个字段`);
      }
      console.log(`共 ${result.total} 个报表`);
    }
  });
}

export async function runSycmExport(opts = {}) {
  const reportId = parseReportId(opts.reportId);
  const reportName = String(opts.reportName || '').trim();
  if (!reportId && !reportName) throw new Error('必须提供 --report-id 或 --report-name');
  if (reportId && reportName) throw new Error('--report-id 与 --report-name 只能使用一个');
  if (!opts.out) throw new Error('缺少 --out；请指定新的 .xlsx 输出文件');
  const outPath = path.resolve(String(opts.out));
  if (path.extname(outPath).toLowerCase() !== '.xlsx') throw new Error('--out 必须是 .xlsx 文件');
  await assertOutputDoesNotExist(outPath);

  const timeoutMs = boundedInteger(opts.timeoutMs, 120000, 5000, 600000, '--timeout-ms');
  const delayRange = resolveApiDelayRange(opts);

  await withAuthenticatedTaobaoSession({ ...opts, startUrl: SYCM_REPORTS_URL }, async ({ context }) => {
    const page = await ensureSycmPage(context, delayRange);
    const report = reportId
      ? await getSycmReportById(page, reportId, delayRange)
      : await findSycmReportByName(page, reportName, delayRange);
    const download = await generateSycmDownload(page, report.id, {
      delayRange,
      timeoutMs,
    });
    await waitBeforeTaobaoApiRequest(page, delayRange);
    const buffer = await fetchSycmDownload(download.url, { timeoutMs });
    await assertPageNotVerifying(page);
    const written = await writeNewFile(outPath, buffer);
    const result = {
      report: normalizeSycmReport(report),
      output: outPath,
      bytes: written.size,
      mode: written.mode,
    };

    if (opts.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`生意参谋报表：${result.report.name} (${result.report.id})`);
      console.log(`维度：${result.report.dataType}-${result.report.dataDimension}`);
      console.log(`日期：${result.report.startDate} 至 ${result.report.endDate}`);
      console.log(`output: ${outPath}`);
    }
  });
}

export async function runSycmFetch(opts = {}) {
  const reportId = parseReportId(opts.reportId);
  const reportName = String(opts.reportName || '').trim();
  const direct = parseDirectReportOptions(opts);
  if (!reportId && !reportName && !direct) {
    throw new Error('请提供母版的 --report-id/--report-name，或直接提供 --data-platform、--data-type、--data-dimension');
  }
  if (reportId && reportName) throw new Error('--report-id 与 --report-name 只能使用一个');
  if ((reportId || reportName) && direct) throw new Error('母版模式与直接维度模式不能同时使用');
  const useAllHistory = Boolean(opts.allHistory);
  if (useAllHistory && (opts.startDate || opts.endDate)) {
    throw new Error('--all-history 不能与 --start-date/--end-date 同时使用');
  }
  let startDate = useAllHistory ? '' : parseIsoDate(opts.startDate, '--start-date');
  let endDate = useAllHistory ? '' : parseIsoDate(opts.endDate, '--end-date');
  if (!useAllHistory && startDate > endDate) throw new Error('--start-date 不能晚于 --end-date');
  if ((reportId || reportName) && (opts.itemIds || opts.device)) {
    throw new Error('--item-ids/--device 仅支持直接维度模式');
  }
  if (!opts.out) throw new Error('缺少 --out；请指定新的 .xlsx 输出文件');
  const outPath = path.resolve(String(opts.out));
  if (path.extname(outPath).toLowerCase() !== '.xlsx') throw new Error('--out 必须是 .xlsx 文件');
  await assertOutputDoesNotExist(outPath);

  const timeoutMs = boundedInteger(opts.timeoutMs, 120000, 5000, 600000, '--timeout-ms');
  const delayRange = resolveApiDelayRange(opts);

  await withAuthenticatedTaobaoSession({ ...opts, startUrl: SYCM_REPORTS_URL }, async ({ context }) => {
    const page = await ensureSycmPage(context, delayRange);
    let master = reportId
      ? await getSycmReportById(page, reportId, delayRange)
      : reportName
        ? await findSycmReportByName(page, reportName, delayRange)
        : await buildDirectSycmMaster(page, {
          ...direct,
          fields: opts.fields,
          filters: opts.filters,
          itemIds: opts.itemIds,
          device: opts.device,
          delayRange,
        });
    if ((reportId || reportName) && opts.fields) {
      master = await selectSycmReportFields(page, master, opts.fields, delayRange);
    }
    const validRange = await getSycmValidDateRange(page, master, delayRange);
    if (useAllHistory) {
      startDate = validRange.startDate;
      endDate = validRange.endDate;
    }
    assertRequestedDateRange({ startDate, endDate, validRange });

    const temporaryName = `tbcli-temp-${randomUUID().slice(0, 8)}`;
    let temporary = null;
    let output = null;
    let operationError = null;
    try {
      temporary = await createTemporarySycmReport(page, {
        master,
        startDate,
        endDate,
        reportName: temporaryName,
        delayRange,
      });
      const download = await generateSycmDownload(page, temporary.id, {
        delayRange,
        timeoutMs,
      });
      await waitBeforeTaobaoApiRequest(page, delayRange);
      const buffer = await fetchSycmDownload(download.url, { timeoutMs });
      await assertPageNotVerifying(page);
      const workbookSummary = await inspectSycmWorkbook(buffer, parseJsonArray(master.itemIds), {
        dateType: master.dateType,
      });
      const written = await writeNewFile(outPath, buffer);
      output = {
        masterReport: master.id ? normalizeSycmReport(master) : normalizeDirectSycmReport(master),
        requestedPeriod: { startDate, endDate },
        allHistory: useAllHistory,
        validPeriod: validRange,
        output: outPath,
        bytes: written.size,
        mode: written.mode,
        workbook: workbookSummary,
        temporaryReportDeleted: false,
      };
    } catch (error) {
      operationError = error;
    }

    let cleanupError = null;
    if (temporary) {
      try {
        await deleteTemporarySycmReport(page, temporary, delayRange);
        if (output) output.temporaryReportDeleted = true;
      } catch (error) {
        cleanupError = error;
      }
    }
    if (operationError) {
      if (cleanupError) operationError.message += `；临时报表 ${temporary.reportName} (${temporary.id}) 清理也失败：${cleanupError.message}`;
      throw operationError;
    }
    if (cleanupError) {
      throw new Error(`数据文件已生成，但临时报表 ${temporary.reportName} (${temporary.id}) 清理失败：${cleanupError.message}；output: ${outPath}`);
    }

    if (opts.json) console.log(JSON.stringify(output, null, 2));
    else {
      console.log(output.masterReport.id
        ? `生意参谋母版：${output.masterReport.name} (${output.masterReport.id})`
        : `取数维度：${output.masterReport.dataPlatform}-${output.masterReport.dataType}-${output.masterReport.dataDimension}`);
      console.log(`日期：${startDate} 至 ${endDate}`);
      console.log(`临时报表已清理：${output.temporaryReportDeleted ? '是' : '否'}`);
      console.log(`output: ${outPath}`);
    }
  });
}

export async function getSycmCatalog(page, {
  dataPlatform = '', dataType = '', dataDimension = '', dateType = '', delayRange, request = requestSycmJson,
} = {}) {
  const base = { channelName: '天猫淘宝' };
  if (!dataPlatform) {
    const response = await request(page, `${FETCH_DATA_PREFIX}getDataPlatformMap.json?${new URLSearchParams(base)}`, { delayRange });
    return { level: 'platform', values: objectKeysOrArray(response.data) };
  }
  if (!dataType) {
    const query = new URLSearchParams({ ...base, dataPlatform });
    const response = await request(page, `${FETCH_DATA_PREFIX}getDataTypeMapList.json?${query}`, { delayRange });
    return { level: 'dataType', dataPlatform, values: objectKeysOrArray(response.data) };
  }
  if (!dataDimension) {
    const query = new URLSearchParams({ ...base, dataPlatform, dataType });
    const response = await request(page, `${FETCH_DATA_PREFIX}getDataDimensionMapList.json?${query}`, { delayRange });
    return { level: 'dataDimension', dataPlatform, dataType, values: objectKeysOrArray(response.data) };
  }
  const config = { ...base, dataPlatform, dataType, dataDimension };
  const query = new URLSearchParams(config);
  const dateTypes = await request(page, `${FETCH_DATA_PREFIX}getDateTypeList.json?${query}`, { delayRange });
  const filters = await request(page, `${FETCH_DATA_PREFIX}getDimFilterList.json?${query}`, { delayRange });
  const supportedDateTypes = dateTypes.data || [];
  const resolvedDateType = dateType || (supportedDateTypes.includes('day') ? 'day' : supportedDateTypes[0]);
  if (!resolvedDateType || !supportedDateTypes.includes(resolvedDateType)) {
    throw new Error(`该维度不支持 --date-type ${dateType || '(自动)'}；可用值：${supportedDateTypes.join('、')}`);
  }
  const dims = defaultDims(filters.data);
  const indicators = await request(page, `${FETCH_DATA_PREFIX}getIndicatorListByDimsAndDevice.json`, {
    method: 'POST', body: { ...config, dateType: resolvedDateType, dims }, delayRange,
  });
  const validDate = await request(page, `${FETCH_DATA_PREFIX}getValidDate.json?${new URLSearchParams({ ...config, dateType: resolvedDateType })}`, { delayRange });
  return {
    level: 'fields', dataPlatform, dataType, dataDimension,
    dateType: resolvedDateType, dateTypes: supportedDateTypes,
    validPeriod: {
      startDate: firstFullDate(validDate.data?.dateStart),
      endDate: datePart(validDate.data?.dateEnd),
    },
    filters: normalizeFilters(filters.data),
    needFilterDeviceType: Boolean(indicators.data?.needFilterDeviceType),
    fields: normalizeIndicators(indicators.data?.indicators),
  };
}

export async function buildDirectSycmMaster(page, {
  dataPlatform, dataType, dataDimension, dateType = '', fields, filters, itemIds, device, delayRange,
  request = requestSycmJson,
} = {}) {
  const config = { channelName: '天猫淘宝', dataPlatform, dataType, dataDimension };
  const query = new URLSearchParams(config);
  const dateTypesResponse = await request(page, `${FETCH_DATA_PREFIX}getDateTypeList.json?${query}`, { delayRange });
  const dateTypes = dateTypesResponse.data || [];
  const resolvedDateType = dateType || (dateTypes.includes('day') ? 'day' : dateTypes[0]);
  if (!resolvedDateType) throw new Error('该维度没有可用的时间粒度');
  if (!dateTypes.includes(resolvedDateType)) throw new Error(`该维度不支持 --date-type ${resolvedDateType}；可用值：${dateTypes.join('、')}`);
  const filterResponse = await request(page, `${FETCH_DATA_PREFIX}getDimFilterList.json?${query}`, { delayRange });
  const dims = applyFilterOptions(filterResponse.data, filters);
  const indicatorResponse = await request(page, `${FETCH_DATA_PREFIX}getIndicatorListByDimsAndDevice.json`, {
    method: 'POST', body: { ...config, dateType: resolvedDateType, dims }, delayRange,
  });
  const availableFields = normalizeIndicators(indicatorResponse.data?.indicators);
  const resolvedDevice = resolveDeviceSelection(device, Boolean(indicatorResponse.data?.needFilterDeviceType));
  const deviceFields = filterFieldsByDevice(availableFields, resolvedDevice);
  const selected = resolveFieldSelection(fields, deviceFields);
  const selectedItemIds = parseItemIds(itemIds);
  if (selectedItemIds.length && dataType !== '商品') {
    throw new Error('--item-ids 仅支持商品数据粒度');
  }
  const shopsResponse = await request(page, `${FETCH_DATA_PREFIX}getAllShopListWithNoAuth.json`, { delayRange });
  const shopIds = (shopsResponse.data || []).filter((shop) => shop.haveAuth !== false).map((shop) => String(shop.id));
  if (!shopIds.length) throw new Error('当前账号没有可用于取数的已授权店铺');
  return {
    datasource: '电商后台', channelName: '天猫淘宝', dataPlatform, dataType, dataDimension, dateType: resolvedDateType,
    shopIds: JSON.stringify(shopIds), indicators: JSON.stringify(selected.map((field) => field.code)),
    dims: JSON.stringify(dims), customFilters: '{}', itemIds: JSON.stringify(selectedItemIds), isAutoUpdate: '0',
    autoUpdateCycle: 1, isDataFormat: 'N', directFieldNames: selected.map((field) => field.name),
    directDevice: resolvedDevice, directItemIds: selectedItemIds,
  };
}

export async function selectSycmReportFields(page, master, fields, delayRange, { request = requestSycmJson } = {}) {
  const config = {
    channelName: master.channelName, dataPlatform: master.dataPlatform,
    dataType: master.dataType, dataDimension: master.dataDimension,
  };
  const response = await request(page, `${FETCH_DATA_PREFIX}getIndicatorListByDimsAndDevice.json`, {
    method: 'POST', body: { ...config, dateType: master.dateType, dims: parseJsonObject(master.dims) }, delayRange,
  });
  const selected = resolveFieldSelection(fields, normalizeIndicators(response.data?.indicators));
  return { ...master, indicators: JSON.stringify(selected.map((field) => field.code)) };
}

export async function listSycmReports(page, {
  keyword = '',
  currentPage = 1,
  pageSize = 100,
  delayRange,
  request = requestSycmJson,
} = {}) {
  const query = new URLSearchParams({
    pageSize: String(pageSize),
    currentPage: String(currentPage),
    keyword,
    space: 'personal',
  });
  const response = await request(page, `${FETCH_DATA_PREFIX}getReportList.json?${query}`, { delayRange });
  const data = response?.data;
  if (!data || !Array.isArray(data.reportList)) throw new Error('生意参谋报表列表返回结构异常');
  return data;
}

export async function getSycmReportById(page, reportId, delayRange, {
  request = requestSycmJson,
} = {}) {
  const response = await request(page, `${FETCH_DATA_PREFIX}getReportById.json?reportId=${encodeURIComponent(reportId)}`, { delayRange });
  if (!response?.data?.id) throw new Error(`没有找到生意参谋取数报表：${reportId}`);
  return response.data;
}

export async function findSycmReportByName(page, reportName, delayRange, {
  list = listSycmReports,
} = {}) {
  const result = await list(page, {
    keyword: reportName,
    currentPage: 1,
    pageSize: 100,
    delayRange,
  });
  const matches = result.reportList.filter((report) => report.reportName === reportName);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(`存在 ${matches.length} 个同名报表“${reportName}”，请改用 --report-id`);
  }
  const candidates = result.reportList.slice(0, 5).map((report) => `${report.reportName} (${report.id})`).join('、');
  throw new Error(candidates
    ? `没有找到名称完全匹配“${reportName}”的报表；相近结果：${candidates}`
    : `没有找到名称完全匹配“${reportName}”的报表`);
}

export async function generateSycmDownload(page, reportId, {
  delayRange,
  timeoutMs = 120000,
  request = requestSycmJson,
  now = Date.now,
} = {}) {
  await request(page, `${FETCH_DATA_PREFIX}download.json?reportId=${encodeURIComponent(reportId)}`, { delayRange });
  const deadline = now() + timeoutMs;
  while (now() <= deadline) {
    const response = await request(page, `${FETCH_DATA_PREFIX}queryDownloadUrl.json?reportId=${encodeURIComponent(reportId)}`, { delayRange });
    const status = String(response?.data?.status || '');
    const url = String(response?.data?.url || '');
    if (status === DOWNLOAD_SUCCESS && url) return { status, url };
    if (status === DOWNLOAD_FAILED) throw new Error('生意参谋报表生成失败');
    if (status && status !== DOWNLOAD_PROCESSING) throw new Error(`未知的生意参谋下载状态：${status}`);
  }
  throw new Error(`等待生意参谋生成报表超时（${timeoutMs}ms）`);
}

export async function getSycmValidDateRange(page, report, delayRange, {
  request = requestSycmJson,
} = {}) {
  const query = new URLSearchParams({
    channelName: report.channelName,
    dataPlatform: report.dataPlatform,
    dataType: report.dataType,
    dataDimension: report.dataDimension,
    dateType: report.dateType,
  });
  const response = await request(page, `${FETCH_DATA_PREFIX}getValidDate.json?${query}`, { delayRange });
  const startDate = firstFullDate(response?.data?.dateStart);
  const endDate = datePart(response?.data?.dateEnd);
  if (!startDate || !endDate) throw new Error('生意参谋没有返回有效取数日期范围');
  return { startDate, endDate };
}

export function assertRequestedDateRange({ startDate, endDate, validRange }) {
  if (startDate < validRange.startDate || endDate > validRange.endDate) {
    throw new Error(`所选日期超出生意参谋当前可取范围：${validRange.startDate} 至 ${validRange.endDate}`);
  }
}

export async function createTemporarySycmReport(page, {
  master,
  startDate,
  endDate,
  reportName,
  delayRange,
  request = requestSycmJson,
} = {}) {
  const payload = buildTemporaryReportPayload(master, { startDate, endDate, reportName });
  const response = await request(page, `${FETCH_DATA_PREFIX}createReport.json`, {
    method: 'POST',
    body: payload,
    delayRange,
  });
  if (!response?.data?.id) throw new Error('生意参谋没有返回临时报表编号');
  return response.data;
}

export function buildTemporaryReportPayload(master, { startDate, endDate, reportName }) {
  return {
    datasource: master.datasource,
    channelName: master.channelName,
    dataPlatform: master.dataPlatform,
    shopIds: parseJsonArray(master.shopIds),
    dataType: master.dataType,
    dataDimension: master.dataDimension,
    dateType: master.dateType,
    startDate,
    endDate,
    indicators: parseJsonArray(master.indicators),
    dims: parseJsonObject(master.dims),
    customFilters: parseJsonObject(master.customFilters),
    reportName,
    itemIds: parseJsonArray(master.itemIds),
    isAutoUpdate: '0',
    autoUpdateCycle: Number(master.autoUpdateCycle || 1),
    isDataFormat: master.isDataFormat || 'N',
  };
}

export async function deleteTemporarySycmReport(page, temporary, delayRange, {
  getReport = getSycmReportById,
  request = requestSycmJson,
} = {}) {
  const id = parseReportId(temporary?.id);
  const expectedName = String(temporary?.reportName || '');
  if (!id || !expectedName.startsWith('tbcli-temp-')) {
    throw new Error('拒绝删除非 tbcli 临时报表');
  }
  const current = await getReport(page, id, delayRange);
  if (String(current.reportName || '') !== expectedName) {
    throw new Error(`临时报表身份校验失败：${id}`);
  }
  await request(page, `${FETCH_DATA_PREFIX}delReportById.json`, {
    method: 'POST',
    body: { reportId: id },
    delayRange,
  });
}

export async function requestSycmJson(page, endpoint, {
  delayRange,
  method = 'GET',
  body,
  waitBeforeRequest = waitBeforeTaobaoApiRequest,
  assertPageSafe = assertPageNotVerifying,
} = {}) {
  const url = new URL(endpoint, SYCM_ORIGIN);
  if (url.origin !== SYCM_ORIGIN || !url.pathname.startsWith(FETCH_DATA_PREFIX)) {
    throw new Error(`拒绝访问非生意参谋取数接口：${url.origin}${url.pathname}`);
  }
  const requestMethod = String(method || 'GET').toUpperCase();
  if (!['GET', 'POST'].includes(requestMethod)) throw new Error(`不支持的生意参谋请求方法：${requestMethod}`);
  await waitBeforeRequest(page, delayRange);
  const result = await page.evaluate(async ({ requestUrl, requestMethod, requestBody }) => {
    const response = await fetch(requestUrl, {
      method: requestMethod,
      credentials: 'include',
      headers: {
        accept: 'application/json',
        ...(requestMethod === 'POST' ? { 'content-type': 'application/json' } : {}),
      },
      ...(requestMethod === 'POST' ? { body: JSON.stringify(requestBody ?? {}) } : {}),
    });
    return {
      status: response.status,
      redirected: response.redirected,
      responseUrl: response.url,
      body: await response.text(),
    };
  }, { requestUrl: url.toString(), requestMethod, requestBody: body });
  await assertPageSafe(page);
  if (result.redirected || isVerificationSignal(`${result.responseUrl}\n${result.body}`)) {
    throw createVerificationError(result.responseUrl || '生意参谋接口验证信号');
  }
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`生意参谋取数接口失败：HTTP ${result.status}`);
  }
  let payload;
  try {
    payload = JSON.parse(result.body);
  } catch {
    throw new Error('生意参谋取数接口没有返回 JSON');
  }
  if (payload?.ok === false || ![0, 200].includes(Number(payload?.code))) {
    throw new Error(`生意参谋取数接口返回异常：${payload?.message || payload?.code || 'unknown'}`);
  }
  return payload;
}

export function normalizeSycmReport(report) {
  const indicators = parseJsonArray(report.indicators);
  return {
    id: Number(report.id),
    name: String(report.reportName || ''),
    source: [report.datasource, report.channelName, report.dataPlatform].filter(Boolean).join('-'),
    dataType: String(report.dataType || ''),
    dataDimension: String(report.dataDimension || ''),
    dateType: String(report.dateType || ''),
    startDate: datePart(report.startDate),
    endDate: datePart(report.endDate),
    indicatorCount: indicators.length,
    indicators,
    filters: parseJsonObject(report.dims),
    autoUpdate: String(report.isAutoUpdate || '') === '1',
    autoUpdateCycle: Number(report.autoUpdateCycle || 0),
    createdAt: String(report.gmtCreate || ''),
    modifiedAt: String(report.gmtModify || ''),
  };
}

export async function fetchSycmDownload(value, {
  timeoutMs = 120000,
  fetchImpl = fetch,
} = {}) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== DOWNLOAD_HOST || !url.pathname.startsWith('/reports/')) {
    throw new Error('生意参谋返回了不受信任的下载地址');
  }
  const response = await fetchImpl(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`下载生意参谋报表失败：HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    throw new Error('下载结果不是有效的 Excel 文件');
  }
  return buffer;
}

export async function inspectSycmWorkbook(buffer, requestedItemIds = [], { dateType = '' } = {}) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error('生意参谋 Excel 没有工作表');
  const headers = [];
  for (let column = 1; column <= sheet.columnCount; column += 1) {
    headers.push(String(sheet.getCell(1, column).text || '').trim());
  }
  const dateColumn = headers.indexOf('统计日期') + 1;
  const itemIdColumn = headers.indexOf('商品ID') + 1;
  if (dateType === 'day' && !dateColumn) throw new Error('生意参谋分日 Excel 缺少“统计日期”列');
  if (requestedItemIds.length && !itemIdColumn) throw new Error('生意参谋指定商品 Excel 缺少“商品ID”列');
  const returnedItemIds = new Set();
  const dates = [];
  let dataRows = 0;
  for (let row = 2; row <= sheet.rowCount; row += 1) {
    const values = sheet.getRow(row).values;
    if (!Array.isArray(values) || values.slice(1).every((value) => value == null || String(value).trim() === '')) continue;
    dataRows += 1;
    if (itemIdColumn) {
      const itemId = String(sheet.getCell(row, itemIdColumn).text || '').trim();
      if (itemId) returnedItemIds.add(itemId);
    }
    if (dateColumn) {
      const date = String(sheet.getCell(row, dateColumn).text || '').trim().slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(date)) dates.push(date);
    }
  }
  const requested = [...new Set((requestedItemIds || []).map(String))];
  dates.sort();
  return {
    sheet: sheet.name,
    rows: dataRows,
    columns: headers.length,
    headers,
    returnedItemIds: [...returnedItemIds],
    itemIdsWithoutRows: requested.filter((itemId) => !returnedItemIds.has(itemId)),
    dataPeriod: dates.length ? { startDate: dates[0], endDate: dates.at(-1) } : null,
  };
}

async function ensureSycmPage(context, delayRange) {
  let page = context.pages().find((candidate) => {
    try { return new URL(candidate.url()).hostname === 'sycm.taobao.com'; } catch { return false; }
  });
  if (!page) {
    page = await context.newPage();
    await waitBeforeTaobaoApiRequest(page, delayRange);
    await page.goto(SYCM_REPORTS_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  }
  await assertPageNotVerifying(page);
  return page;
}

async function assertOutputDoesNotExist(target) {
  try {
    const stat = await fs.stat(target);
    throw new Error(`输出文件已存在，拒绝覆盖：${target}（${stat.size} bytes）`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function writeNewFile(target, buffer) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, buffer, { flag: 'wx', mode: 0o600 });
  const stat = await fs.stat(target);
  if (stat.size !== buffer.length) throw new Error(`报表写入不完整：${target}`);
  return {
    size: stat.size,
    mode: `0${(stat.mode & 0o777).toString(8)}`,
  };
}

function parseReportId(value) {
  if (value == null || value === '') return '';
  const text = String(value);
  if (!/^\d+$/.test(text)) throw new Error('--report-id 必须是数字');
  return text;
}

function parseDirectReportOptions(opts) {
  const values = {
    dataPlatform: String(opts.dataPlatform || '').trim(),
    dataType: String(opts.dataType || '').trim(),
    dataDimension: String(opts.dataDimension || '').trim(),
    dateType: String(opts.dateType || '').trim(),
  };
  const supplied = [values.dataPlatform, values.dataType, values.dataDimension].filter(Boolean).length;
  if (!supplied) return null;
  if (supplied !== 3) throw new Error('直接维度模式必须同时提供 --data-platform、--data-type、--data-dimension');
  return values;
}

function normalizeDirectSycmReport(report) {
  const indicators = parseJsonArray(report.indicators);
  return {
    id: null,
    name: '',
    source: [report.datasource, report.channelName, report.dataPlatform].filter(Boolean).join('-'),
    dataPlatform: String(report.dataPlatform || ''),
    dataType: String(report.dataType || ''),
    dataDimension: String(report.dataDimension || ''),
    dateType: String(report.dateType || ''),
    indicatorCount: indicators.length,
    indicators,
    fieldNames: report.directFieldNames || [],
    device: report.directDevice || 'all',
    itemIds: report.directItemIds || parseJsonArray(report.itemIds),
    filters: parseJsonObject(report.dims),
  };
}

function objectKeysOrArray(value) {
  if (Array.isArray(value)) return value.map((entry) => {
    if (entry && typeof entry === 'object') {
      return String(entry.platform ?? entry.name ?? entry.label ?? entry.value ?? entry.type ?? '');
    }
    return String(entry);
  }).filter(Boolean);
  if (value && typeof value === 'object') return Object.keys(value);
  return [];
}

function normalizeIndicators(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.entries(value)
    .map(([code, field]) => ({
      code,
      name: String(field?.columnNameZh || code),
      description: String(field?.columnDesc || ''),
      dataType: String(field?.dataType || ''),
      bizType: String(field?.bizType || ''),
      deviceType: field?.deviceType == null ? null : String(field.deviceType),
      index: Number(field?.columnIndex || 0),
    }))
    .sort((left, right) => left.index - right.index || left.name.localeCompare(right.name, 'zh-CN'));
}

function normalizeFilters(filters) {
  if (!Array.isArray(filters)) return [];
  return filters.map((filter) => ({
    code: String(filter.columnName || ''),
    name: String(filter.columnNameZh || filter.columnName || ''),
    type: String(filter.filterType || ''),
    values: objectKeysOrArray(filter.columnEnums),
  }));
}

function defaultDims(filters) {
  const dims = {};
  for (const filter of normalizeFilters(filters)) {
    if (filter.type === 'enum') dims[filter.code] = filter.values;
  }
  return dims;
}

function applyFilterOptions(filterDefinitions, rawOptions) {
  const normalized = normalizeFilters(filterDefinitions);
  const dims = defaultDims(filterDefinitions);
  for (const raw of rawOptions || []) {
    const text = String(raw || '');
    const separator = text.indexOf('=');
    if (separator < 1) throw new Error('--filter 必须是“筛选项=值1,值2”');
    const key = text.slice(0, separator).trim();
    const values = text.slice(separator + 1).split(',').map((value) => value.trim()).filter(Boolean);
    const definition = normalized.find((filter) => filter.code === key || filter.name === key);
    if (!definition) throw new Error(`未知筛选项：${key}`);
    const invalid = values.filter((value) => !definition.values.includes(value));
    if (invalid.length) throw new Error(`${definition.name} 不支持：${invalid.join('、')}；可用值：${definition.values.join('、')}`);
    dims[definition.code] = values;
  }
  return dims;
}

export function parseItemIds(value) {
  if (value == null || String(value).trim() === '') return [];
  const tokens = String(value).split(/[\s,，]+/).map((token) => token.trim()).filter(Boolean);
  const unique = [...new Set(tokens)];
  const invalid = unique.filter((token) => !/^\d+$/.test(token));
  if (invalid.length) throw new Error(`--item-ids 只能包含数字商品 ID：${invalid.join('、')}`);
  if (unique.length > 100) throw new Error('--item-ids 最多支持 100 个商品 ID');
  return unique;
}

export function resolveDeviceSelection(value, needFilterDeviceType = false) {
  const normalized = String(value || 'all').trim().toLowerCase();
  const aliases = new Map([
    ['all', 'all'], ['所有终端', 'all'], ['全部终端', 'all'],
    ['overall', 'overall'], ['总体', 'overall'], ['整体', 'overall'],
    ['wireless', 'wireless'], ['无线', 'wireless'], ['无线端', 'wireless'],
    ['pc', 'pc'], ['pc端', 'pc'],
  ]);
  const selected = aliases.get(normalized);
  if (!selected) throw new Error('--device 只能是 all、overall、wireless、pc（也接受对应中文名称）');
  if (!needFilterDeviceType && selected !== 'all') {
    throw new Error('该维度不支持终端类型筛选');
  }
  return selected;
}

export function filterFieldsByDevice(fields, device) {
  if (device === 'all') return fields;
  const deviceType = { overall: '0', wireless: '2', pc: '1' }[device];
  return fields.filter((field) => field.deviceType == null || field.deviceType === 'none' || field.deviceType === deviceType);
}

export function resolveFieldSelection(rawFields, availableFields) {
  const requested = String(rawFields || 'all').trim();
  if (!requested || requested.toLowerCase() === 'all' || requested === '全部') return availableFields;
  const tokens = requested.split(',').map((token) => token.trim()).filter(Boolean);
  if (!tokens.length) throw new Error('--fields 不能为空');
  const selected = availableFields.filter((field) => (
    (field.bizType && field.bizType !== 'index') || ['STRING', 'VARCHAR'].includes(String(field.dataType || '').toUpperCase())
  ));
  for (const token of tokens) {
    const byCode = availableFields.filter((field) => field.code === token);
    const matches = byCode.length ? byCode : availableFields.filter((field) => field.name === token);
    if (!matches.length) throw new Error(`该维度没有字段：${token}；可先运行 tbcli sycm catalog 查看字段`);
    if (matches.length > 1) throw new Error(`字段名称“${token}”对应多个字段，请改用字段代码：${matches.map((field) => field.code).join('、')}`);
    if (!selected.some((field) => field.code === matches[0].code)) selected.push(matches[0]);
  }
  return selected;
}

function printSycmCatalog(catalog) {
  if (catalog.level !== 'fields') {
    for (const value of catalog.values) console.log(value);
    console.log(`共 ${catalog.values.length} 项`);
    return;
  }
  console.log(`${catalog.dataPlatform} > ${catalog.dataType} > ${catalog.dataDimension}`);
  console.log(`时间粒度：${catalog.dateTypes.join('、') || '无'}（当前：${catalog.dateType}）`);
  console.log(`可取日期：${catalog.validPeriod.startDate} 至 ${catalog.validPeriod.endDate}`);
  for (const filter of catalog.filters) console.log(`筛选：${filter.name} (${filter.code}) = ${filter.values.join('、')}`);
  for (const field of catalog.fields) console.log(`${field.code}\t${field.name}`);
  console.log(`共 ${catalog.fields.length} 个字段`);
}

function parseIsoDate(value, option) {
  const text = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error(`${option} 必须是 YYYY-MM-DD`);
  const date = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== text) {
    throw new Error(`${option} 不是有效日期`);
  }
  return text;
}

function parseJsonArray(value) {
  if (!value) return [];
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value) {
  if (!value) return {};
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function datePart(value) {
  return String(value || '').slice(0, 10);
}

function firstFullDate(value) {
  const text = String(value || '');
  const date = datePart(text);
  const time = text.slice(11, 19);
  if (!date || !time || time === '00:00:00') return date;
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

function boundedInteger(value, fallback, min, max, option) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${option} 必须是 ${min}-${max} 的整数`);
  }
  return parsed;
}
