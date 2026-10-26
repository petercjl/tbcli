import {resolveApiDelayRange, waitBeforeTaobaoApiRequest} from './api-policy.mjs';
import {assertPageNotVerifying, createVerificationError, isVerificationSignal} from './taobao-guard.mjs';

export const dmpError = (code, message) => Object.assign(new Error(message), {code});
export const DMP_PATHS = Object.freeze({
  login: '/api_2/login/loginuserinfo',
  items: '/api/goods/item/list',
  itemInfo: '/api/goods/item/info',
  successItems: '/api/goods/grow/define/success/item/list',
  latestDay: '/api/latestDay',
  costs: '/api/goods/grow/define/line/data',
  metrics: '/dataplatform/dataset/report/query.json',
  scenes: '/api/goods/grow/comparison/scene',
  keywords: '/api/goods/grow/comparison/scene/keyword',
  crowd: '/api/goods/grow/comparison/crowd',
});
export const COST_FIELDS = Object.freeze({
  keyword: '关键词推广消耗占比', wholeSite: '货品全站推消耗占比',
  audience: '人群推广消耗占比', content: '内容运营消耗占比', leads: '线索推广消耗占比',
});
export const METRIC_FIELDS = Object.freeze({
  transactionCount: 6986, avgOrderValue: 6895, ipv: 6813, paidClicks: 8291, freeClicks: 8290,
});
export const DMP_CATALOG = Object.freeze({
  schemaVersion: 1, commands: ['dmp catalog', 'dmp items', 'dmp report', 'dmp snapshot', 'dmp item-info'],
  authentication: 'Dedicated Chrome session; login check and DMP identity; credentials stay in browser memory.',
  endpoints: {
    items: {method: 'GET', path: DMP_PATHS.items, inputs: {page: 'positive integer', pageSize: '1–100 (CLI bound)'}, output: 'data.list + data.pager; one page only'},
    costs: {method: 'GET', path: DMP_PATHS.costs, inputs: {itemId: 'owned anchor ID', successItemId: 'one target ID', startDate: 'YYYY-MM-DD, inclusive', endDate: 'YYYY-MM-DD, inclusive'}, output: 'data.lineInfo + data.stages', fields: COST_FIELDS, unit: 'unverified; CNY is the supplied method’s assumption, not independently confirmed'},
    metrics: {method: 'POST', path: DMP_PATHS.metrics, inputs: {datasetId: 156, type: 'INDEX_CARD', conf: 'JSON string: columnList, conditionList, indexList, rowList, userPageSize', filterCondition: 'JSON string: date field 6794 and item field 6797'}, fields: METRIC_FIELDS, output: 'data.INDEX_CARD.fields + values; data.rangeDesc'},
  },
  itemInfo: {command:'dmp item-info', version:1, input:'one target itemId; selected owned anchorId for competitor lookup; new JSON output', output:'DMP product identity, main image, item/shop links when available; no retail-page fallback'},
  snapshot: {command: 'dmp snapshot', version: 1, input: 'one itemId, explicit anchorId, paired dates or days, new out.json', modules: ['metrics7', 'scenes', 'keywords', 'crowdRanges', 'crowdTable'], metricFields: [6986,6895,6813,8291,8290,6896,6897], crowdDataset: 175, output: 'request and scrubbed response per module; empty/provider failure remains explicit; no retries'},
  commonQuery: {bizCode: 'dmp', _tb_token_: 'browser cookie', _csrf: 'loginuserinfo.data.csrfId', csrfId: 'same csrfId'},
  reportInputs: {itemIds: '1–20 distinct numeric strings (CLI batch bound); one request per item/module', anchorId: 'required for costs/all; omitted for metrics', modules: 'all (default), costs, metrics', dates: 'paired start/end or days 1–366; default last 30 completed Asia/Shanghai days; bounds are CLI limits, not promised platform retention', out: 'new .json file; never overwrite'},
  guarantees: ['No automatic anchor choice or saved-success-item changes', 'Independent module status; empty/denied/missing values remain unknown', 'Every request is paced and guarded; verification stops the whole batch; no automatic retries', 'Requested period and returned date coverage are separate; no silent date changes'],
  evidence: {date: '2026-10-24', costs: '7, 30 and 31 inclusive days returned; a single-day and an earlier seven-day request returned system-busy, not an explicit date limit', metrics: 'one-day and 30-day INDEX_CARD returned', scope: 'Not guaranteed for arbitrary IDs or categories; no independent exact-spend verification'},
});

const id = (value, label) => {
  const text = String(value ?? '').trim();
  if (!/^[1-9]\d{0,29}$/.test(text)) throw dmpError('DMP_INVALID_INPUT', `${label} 必须是正整数商品 ID 字符串。`);
  return text;
};
const integer = (value, fallback, min, max, label) => {
  const n = value === undefined ? fallback : Number(value);
  if (value === '' || !Number.isInteger(n) || n < min || n > max) throw dmpError('DMP_INVALID_INPUT', `${label} 必须是 ${min}–${max} 的整数。`);
  return n;
};
function date(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? '') || !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) throw dmpError('DMP_INVALID_INPUT', '日期必须是有效 YYYY-MM-DD。');
  return value;
}
const shift = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
export function dmpPeriod(opts, now = new Date()) {
  const today = new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'}).format(now);
  let startDate, endDate;
  if (opts.startDate !== undefined || opts.endDate !== undefined) {
    if (opts.days !== undefined || !opts.startDate || !opts.endDate) throw dmpError('DMP_INVALID_INPUT', '成对提供 --start-date/--end-date，或仅提供 --days。');
    startDate = date(opts.startDate); endDate = date(opts.endDate);
  } else {
    const days = integer(opts.days, 30, 1, 366, '--days');
    endDate = shift(today, -1); startDate = shift(endDate, 1 - days);
  }
  const days = (Date.parse(endDate) - Date.parse(startDate)) / 86400000 + 1;
  if (days < 1 || days > 366 || endDate >= today) throw dmpError('DMP_INVALID_INPUT', '日期须为过去已完成的 1–366 天，开始日不晚于结束日。');
  return {startDate, endDate, days, timeZone: 'Asia/Shanghai', inclusive: true};
}
export function prepareDmpReport(opts, now) {
  if ((opts.itemId !== undefined) === (opts.itemIds !== undefined)) throw dmpError('DMP_INVALID_INPUT', '提供 --item-id 或 --item-ids，二选一。');
  const itemIds = [...new Set(String(opts.itemId ?? opts.itemIds).split(/[,，\s]+/).filter(Boolean).map(v => id(v, '商品 ID')))];
  if (!itemIds.length || itemIds.length > 20) throw dmpError('DMP_INVALID_INPUT', '每批支持 1–20 个商品 ID。');
  const modules = opts.modules ?? 'all';
  if (!['all', 'costs', 'metrics'].includes(modules)) throw dmpError('DMP_INVALID_INPUT', '--modules 只能是 all、costs、metrics。');
  const anchorId = opts.anchorId === undefined ? null : id(opts.anchorId, '--anchor-id');
  if (modules !== 'metrics' && !anchorId) throw dmpError('DMP_INVALID_INPUT', '查询推广明细须明确提供本店 --anchor-id；先用 dmp items 发现候选。');
  if (modules === 'metrics' && anchorId) throw dmpError('DMP_INVALID_INPUT', '--modules metrics 不使用锚点，请省略 --anchor-id。');
  return {itemIds, anchorId, modules, period: dmpPeriod(opts, now), delayRange: resolveApiDelayRange(opts), timeoutMs: integer(opts.timeoutMs, 30000, 1000, 120000, '--timeout-ms')};
}
export function prepareDmpItems(opts) {
  return {page: integer(opts.page, 1, 1, 100000, '--page'), pageSize: integer(opts.pageSize, 20, 1, 100, '--page-size'), delayRange: resolveApiDelayRange(opts), timeoutMs: integer(opts.timeoutMs, 30000, 1000, 120000, '--timeout-ms')};
}
export function metricsBody(itemId, period) {
  return {
    datasetId: 156, type: 'INDEX_CARD',
    conf: JSON.stringify({columnList: [], conditionList: [{fieldId: 6794}, {fieldId: 6797}], indexList: Object.values(METRIC_FIELDS).map(fieldId => ({aggr: 'SUM', fieldId})), rowList: [], userPageSize: 10}),
    filterCondition: JSON.stringify([
      {id: 6794, fieldId: 6794, name: 'thedate', type: 'dim', dataType: 'date', expression: 'thedate', displayType: 'DATE_RANGE', dataFormat: 'yyyyMMdd', status: 1, datasetId: 156, values: [period.startDate, period.endDate]},
      {id: 6797, fieldId: 6797, name: '宝贝ID', type: 'dim', dataType: 'number', expression: 'item_id', displayType: 'MULTI_SELECTOR', status: 1, datasetId: 156, values: [itemId]},
    ]),
  };
}

// Guard all calls, including identity, before/after the shared request delay.
export async function guardedDmpRequest(page, range, perform, {wait = waitBeforeTaobaoApiRequest, check = assertPageNotVerifying} = {}) {
  await check(page); await wait(page, range); await check(page);
  const response = await perform();
  await check(page);
  if ([401, 403, 429].includes(response.httpStatus) || response.verification || isVerificationSignal(JSON.stringify(response.body?.info ?? {}))) throw createVerificationError('DMP 要求登录、验证或限制访问');
  return response;
}

// This function runs only in Chrome. Tokens are never serialized to the CLI.
async function browserDmpRequest(state, spec) {
  const paths = {login: '/api_2/login/loginuserinfo', items: '/api/goods/item/list', itemInfo: '/api/goods/item/info', successItems: '/api/goods/grow/define/success/item/list', latestDay: '/api/latestDay', costs: '/api/goods/grow/define/line/data', metrics: '/dataplatform/dataset/report/query.json', scenes: '/api/goods/grow/comparison/scene', keywords: '/api/goods/grow/comparison/scene/keyword', crowd: '/api/goods/grow/comparison/crowd'};
  const token = (document.cookie.match(/_tb_token_=([^;]+)/) ?? [])[1] ?? '';
  const query = new URLSearchParams({bizCode: 'dmp', _tb_token_: token, ...(spec.kind === 'login' ? {} : {_csrf: state.csrf, csrfId: state.csrf}), ...spec.query});
  const origin = spec.kind === 'login' ? 'https://dmp.taobao.com' : 'https://dmp.advgateway.taobao.com';
  try {
    const r = await fetch(origin + paths[spec.kind] + '?' + query, {credentials: 'include', signal: AbortSignal.timeout(spec.timeoutMs), ...(spec.body ? {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(spec.body)} : {})});
    const text = await r.text(); let body = null;
    try { body = JSON.parse(text); } catch { /* retain no arbitrary HTML */ }
    const verification = /login\.taobao\.com|login\.tmall\.com|sec\.taobao\.com|captcha|punish|_____tmd_____/.test(r.url) || (!body && /验证码|滑块|安全验证|重新登录|_____tmd_____|captcha/i.test(text));
    if (spec.kind === 'login') {
      state.csrf = body?.data?.csrfId ?? '';
      body = {loggedIn: !!state.csrf && body?.data?.availableUser !== false, account: body?.data?.loginUser?.nickname ?? null, info: body?.info ?? null};
    }
    return {httpStatus: r.status, verification, body};
  } catch (error) {
    return {httpStatus: 0, error: /Timeout|Abort/.test(error.name) ? 'DMP_REQUEST_TIMEOUT' : 'DMP_NETWORK_ERROR', body: null};
  }
}
export async function createDmpClient(context, plan) {
  let page = context.pages().find(p => { try { return new URL(p.url()).origin === 'https://dmp.taobao.com'; } catch { return false; } });
  if (!page) {
    page = await context.newPage();
    await guardedDmpRequest(page, plan.delayRange, async () => { await page.goto('https://dmp.taobao.com/index_new.html', {waitUntil: 'domcontentloaded', timeout: plan.timeoutMs}); return {httpStatus: 200}; });
  }
  const state = await page.evaluateHandle(() => ({csrf: ''}));
  // JSHandle travels as an argument, never through JSON serialization.
  const call = async (kind, query = {}, body) => {
    if (!Object.hasOwn(DMP_PATHS, kind)) throw dmpError('DMP_INVALID_INPUT', '未知 DMP 操作。');
    return guardedDmpRequest(page, plan.delayRange, () => state.evaluate(browserDmpRequest, {kind, query, body, timeoutMs: plan.timeoutMs}));
  };
  try {
    const login = await call('login');
    if (login.httpStatus !== 200 || !login.body?.loggedIn) throw dmpError('DMP_AUTH_REQUIRED', '达摩盘登录不可用，请在同一浏览器完成达摩盘登录。');
    return {account: login.body.account, request: call, dispose: () => state.dispose()};
  } catch (error) { await state.dispose(); throw error; }
}

const number = value => (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')) && Number.isFinite(Number(value)) ? Number(value) : null;
const round = value => Math.round((value + Number.EPSILON) * 100) / 100;
export function scrubDmpRaw(value) {
  if (Array.isArray(value)) return value.map(scrubDmpRaw);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([k]) => !/token|csrf|cookie|authorization|headers/i.test(k)).map(([k, v]) => [k, scrubDmpRaw(v)]));
  return typeof value === 'string' ? value.replace(/([?&](?:_tb_token_|_csrf|csrfId)=)[^&\s"<>]+/gi, '$1[redacted]') : value;
}
function failure(response) {
  if (response.error) return response.error;
  if (response.httpStatus !== 200) return `HTTP_${response.httpStatus}`;
  if (!response.body || !Object.keys(response.body).length) return 'DMP_EMPTY_RESPONSE';
  if (response.body.info?.ok !== true) return /无权|权限/.test(response.body.info?.message ?? '') ? 'DMP_PERMISSION_DENIED' : 'DMP_PROVIDER_FAILURE';
  return null;
}
function evidence(response) {
  return {httpStatus: response.httpStatus, raw: scrubDmpRaw(response.body), fetchedAt: new Date().toISOString()};
}
export function normalizeDmpCosts(response, period) {
  const source = evidence(response), error = failure(response);
  if (error) return {status: 'unavailable', error, source};
  const rows = response.body.data?.lineInfo;
  if (!Array.isArray(rows)) return {status: 'unavailable', error: 'DMP_SCHEMA_CHANGED', source};
  const expected = Array.from({length: period.days}, (_, i) => shift(period.startDate, i));
  const seen = new Set(), duplicates = [], outside = [], invalid = [], missingFields = [];
  const daily = [], observedTotals = Object.fromEntries(Object.keys(COST_FIELDS).map(k => [k, 0]));
  for (const [index, row] of rows.entries()) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) { invalid.push(index); continue; }
    const rawDate = String(row.date ?? ''); let day = rawDate.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3');
    try { date(day); } catch { invalid.push(index); continue; }
    if (seen.has(day)) { duplicates.push(day); continue; }
    seen.add(day);
    if (day < period.startDate || day > period.endDate) { outside.push(day); continue; }
    const values = Object.fromEntries(Object.entries(COST_FIELDS).map(([key, name]) => [key, number(row[name])]));
    for (const [key, n] of Object.entries(values)) { if (n === null) missingFields.push({date: day, field: key}); else observedTotals[key] += n; }
    daily.push({date: day, values, total: Object.values(values).every(v => v !== null) ? round(Object.values(values).reduce((a, b) => a + b, 0)) : null, normalizedGmv: number(row.gmv)});
  }
  for (const key of Object.keys(observedTotals)) observedTotals[key] = round(observedTotals[key]);
  observedTotals.total = round(Object.values(observedTotals).reduce((a, b) => a + b, 0));
  const missingDates = expected.filter(d => !seen.has(d));
  const complete = rows.length > 0 && ![duplicates, outside, invalid, missingFields, missingDates].some(x => x.length);
  return {status: !rows.length ? 'empty' : complete ? 'complete' : 'partial', unit: 'unverified', assumedUnit: 'CNY', unitBasis: 'supplied-method-not-independently-verified', daily, totals: complete ? observedTotals : null, observedTotals, coverage: {requestedDays: period.days, returnedRows: rows.length, validDays: daily.length, missingDates, duplicateDates: duplicates, outsideDates: outside, invalidRows: invalid, missingFields}, stages: response.body.data.stages ?? [], source};
}
export function normalizeDmpMetrics(response, period) {
  const source = evidence(response), error = failure(response);
  if (error) return {status: 'unavailable', error, source};
  const card = response.body.data?.INDEX_CARD;
  if (!Array.isArray(card?.fields) || !Array.isArray(card.values) || card.fields.length !== card.values.length) return {status: 'unavailable', error: 'DMP_SCHEMA_CHANGED', source};
  if (card.fields.some(f => !f || f.id == null)) return {status: 'unavailable', error: 'DMP_SCHEMA_CHANGED', source};
  const ids = card.fields.map(f => String(f.id));
  if (new Set(ids).size !== ids.length) return {status: 'unavailable', error: 'DMP_SCHEMA_CHANGED', source};
  const values = Object.fromEntries(Object.entries(METRIC_FIELDS).map(([key, fieldId]) => [key, number(card.values[ids.indexOf(String(fieldId))]?.value)]));
  const rangeDesc = response.body.data.rangeDesc ?? null, returnedDates = String(rangeDesc ?? '').match(/\d{4}-\d{2}-\d{2}/g) ?? [];
  const periodMatches = returnedDates[0] === period.startDate && (returnedDates[1] ?? returnedDates[0]) === period.endDate;
  return {status: !card.values.length ? 'empty' : Object.values(values).every(v => v !== null) && periodMatches ? 'complete' : 'partial', values, rangeDesc, periodMatches, missingFields: Object.keys(values).filter(k => values[k] === null), source};
}
export function dmpComputed(entry) {
  const m = entry.metrics, c = entry.costs, out = {};
  if (m?.status !== 'complete') return out;
  const v = m.values;
  out.estimatedGmv = round(v.transactionCount * v.avgOrderValue);
  out.totalClicks = v.paidClicks + v.freeClicks;
  out.transactionsPerIpvPercent = v.ipv > 0 ? round(v.transactionCount / v.ipv * 100) : null;
  if (c?.status === 'complete') out.assumingCostsAreCny = {costShareOfGmvPercent: out.estimatedGmv > 0 ? round(c.totals.total / out.estimatedGmv * 100) : null, blendedCpc: v.paidClicks > 0 ? round(c.totals.total / v.paidClicks) : null};
  return out;
}
export async function collectDmpReport(client, plan, report, checkpoint = async () => {}) {
  report.account = client.account;
  for (const itemId of plan.itemIds) {
    const entry = {itemId, costs: {status: 'not-requested'}, metrics: {status: 'not-requested'}, computed: {}};
    report.items.push(entry);
    for (const module of ['costs', 'metrics'].filter(k => plan.modules === 'all' || plan.modules === k)) {
      const query = module === 'costs' ? {itemId: plan.anchorId, successItemId: itemId, startDate: plan.period.startDate, endDate: plan.period.endDate} : {};
      const body = module === 'metrics' ? metricsBody(itemId, plan.period) : undefined;
      const response = await client.request(module, query, body);
      entry[module] = module === 'costs' ? normalizeDmpCosts(response, plan.period) : normalizeDmpMetrics(response, plan.period);
      entry[module].source.request = {method: module === 'costs' ? 'GET' : 'POST', path: DMP_PATHS[module], query, ...(body ? {body} : {}), identityEvidence: 'request-filter; response does not echo target item ID'};
      entry.computed = dmpComputed(entry); await checkpoint();
    }
  }
  report.status = report.items.every(e => ['costs', 'metrics'].every(k => ['complete', 'not-requested'].includes(e[k].status))) ? 'complete' : 'partial';
  return report;
}
export function normalizeDmpItems(response, plan) {
  const error = failure(response);
  if (error) throw dmpError(error, '达摩盘本店商品列表不可用。');
  const data = response.body.data;
  if (!Array.isArray(data?.list) || !data.pager) throw dmpError('DMP_SCHEMA_CHANGED', '达摩盘商品列表结构变化。');
  if (Number(data.pager.currentPage ?? data.pager.page) !== plan.page || Number(data.pager.pageSize) !== plan.pageSize) throw dmpError('DMP_PAGE_MISMATCH', '达摩盘返回页码或页大小与请求不符。');
  const items = data.list.map(row => {
    if (typeof row.id === 'number' && !Number.isSafeInteger(row.id)) throw dmpError('DMP_SCHEMA_CHANGED', '商品 ID 超过安全整数范围。');
    return {itemId: id(row.id, '返回商品 ID'), title: row.name ?? null, cateId: row.cateId ?? null, cateName: row.cateName ?? null, gmv: number(row.gmv)};
  });
  return {schemaVersion: 1, command: 'dmp items', page: plan.page, pageSize: plan.pageSize, items, pager: data.pager, scope: 'one-page-only; no global ranking or automatic anchor selection', source: evidence(response)};
}

export function normalizeDmpItemInfo(response, itemId) {
 const source=evidence(response),error=failure(response);
 if(error)return {schemaVersion:1,command:'dmp item-info',itemId,status:'unavailable',error,product:null,source};
 const d=response.body.data;
 if(!d||typeof d!=='object'||Array.isArray(d))return {schemaVersion:1,command:'dmp item-info',itemId,status:'unavailable',error:'DMP_ITEM_INFO_EMPTY',product:null,source};
 if(String(d.id??d.itemId)!==itemId)throw dmpError('DMP_ITEM_ID_MISMATCH','达摩盘商品资料返回ID与请求不符，已停止。');
 const url=(v,images=false)=>{try{const u=new URL(v,'https://dmp.taobao.com');if(typeof v!=='string'||!v||u.protocol!=='https:'||u.username||u.password||!/(^|\.)(taobao\.com|tmall\.com|alicdn\.com|taobaocdn\.com|tbcdn\.cn)$/.test(u.hostname))return null;return u.href;}catch{return null;}};
 const shopId=d.shopId!=null&&/^[1-9]\d*$/.test(String(d.shopId))?String(d.shopId):null;
 const shopUrl=url(d.shopUrl)??(shopId?'https://shop'+shopId+'.taobao.com':null);
 const product={itemId,title:typeof (d.name??d.itemTitle)==='string'?(d.name??d.itemTitle):null,mainImageUrl:url(d.pictUrl??d.itemPictUrl,true),itemUrl:url(d.detailUrl)??("https://item.taobao.com/item.htm?id="+itemId),category:typeof d.cateName==='string'?d.cateName:null,shop:{shopId,shopName:typeof d.shopName==='string'?d.shopName:null,url:shopUrl,urlSource:d.shopUrl?'returned':shopUrl?'constructed-from-shopId':null}};
 return {schemaVersion:1,command:'dmp item-info',itemId,status:product.title&&product.mainImageUrl&&product.itemUrl?'available':'partial',product,source};
}
