import {DMP_PATHS, dmpError, prepareDmpItems, dmpPeriod, dmpResponseFailure, dmpEvidence} from './dmp.mjs';

export const DMP_RANK_TYPES = Object.freeze(['SALES_STAR', 'SEARCH_HOT', 'MARKETING_STAR']);
const identifier = (value, label, zero = false) => {
  const text = String(value ?? '');
  if (!(zero ? /^(0|[1-9]\d{0,29})$/ : /^[1-9]\d{0,29}$/).test(text)) throw dmpError('DMP_INVALID_INPUT', `${label} 必须是数字ID。`);
  return text;
};
const text = (value, fallback = '') => {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || value.length > 500 || /[\u0000-\u001f]/.test(value)) throw dmpError('DMP_INVALID_INPUT', '筛选文本无效。');
  return value.trim();
};

export function prepareDmpDiscovery(command, opts, now) {
  const common = prepareDmpItems(opts);
  if (command === 'analysis-items') {
    const orderType = text(opts.orderType);
    if (!['', 'asc', 'desc'].includes(orderType)) throw dmpError('DMP_INVALID_INPUT', '--order-type 只能是 asc 或 desc。');
    return {...common, command, kind: 'analysisItems', query: {page: String(common.page), pageSize: String(common.pageSize), keyword: text(opts.keyword), lifeStageCodes: text(opts.lifeStageCodes), orderIndicator: text(opts.orderIndicator), orderType}};
  }
  if (command === 'competitors') {
    const keyword = text(opts.keyword);
    if (!keyword) throw dmpError('DMP_INVALID_INPUT', '竞品搜索需要 --keyword 商品ID或搜索词。');
    const anchorId = identifier(opts.anchorId, '--anchor-id');
    const cateId = identifier(opts.cateId ?? '0', '--cate-id', true);
    if (!Number.isSafeInteger(Number(cateId))) throw dmpError('DMP_INVALID_INPUT', '--cate-id 超出安全整数范围。');
    return {...common, command, kind: 'benchmarkItems', query: {}, body: {keyword, itemId: anchorId, cateId: Number(cateId), page: common.page, pageSize: common.pageSize, competitionSceneType: 1}};
  }
  if (command === 'market-rank') {
    const cateId = identifier(opts.cateId, '--cate-id');
    const rankType = opts.rankType ?? 'SALES_STAR';
    if (!DMP_RANK_TYPES.includes(rankType)) throw dmpError('DMP_INVALID_INPUT', '--rank-type 不在支持的榜单范围内。');
    if (!opts.date) throw dmpError('DMP_INVALID_INPUT', '榜单需要明确的 --date YYYY-MM-DD。');
    dmpPeriod({startDate: opts.date, endDate: opts.date}, now);
    if (opts.page !== undefined || opts.pageSize !== undefined) throw dmpError('DMP_INVALID_INPUT', '榜单不支持客户端分页参数。');
    return {...common, command, kind: 'marketRanking', query: {}, body: {cateId, periodType: '1', date: opts.date, subjectType: 'ITEM', rankType, properties: [], options: []}};
  }
  throw dmpError('DMP_INVALID_INPUT', '未知DMP发现命令。');
}

export function normalizeDmpDiscovery(response, plan) {
  const request = {method: plan.body ? 'POST' : 'GET', path: DMP_PATHS[plan.kind], query: plan.query, ...(plan.body ? {body: plan.body} : {})};
  const source = {...dmpEvidence(response), request};
  const base = {schemaVersion: 1, command: `dmp ${plan.command}`, source};
  const error = dmpResponseFailure(response);
  if (error) return {...base, status: 'unavailable', error, items: [], coverage: null};
  const data = response.body.data;
  const list = plan.command === 'market-rank' ? data?.rankList : data?.list;
  if (!Array.isArray(list) || list.some(r => !r || typeof r !== 'object' || Array.isArray(r))) return {...base, status: 'unavailable', error: 'DMP_SCHEMA_CHANGED', items: [], coverage: null};
  const items = list.map(r => {
    const rawId = r.itemId ?? r.id;
    if (typeof rawId === 'number' && !Number.isSafeInteger(rawId)) throw dmpError('DMP_SCHEMA_CHANGED', '商品ID超出安全整数范围。');
    return {itemId: rawId == null ? null : identifier(String(rawId), '返回商品ID'), title: r.itemName ?? r.name ?? null, cateId: r.cateId ?? null, mainImageUrl: r.imgUrl ?? r.pictUrl ?? null, itemUrl: r.detailUrl ?? null, shopName: r.shopName ?? null, shopId: r.shopId == null ? null : String(r.shopId), rank: r.rank ?? null, startsDays: r.startsDays ?? null};
  });
  const pager = data.pager ?? null;
  if (pager && (Number(pager.currentPage ?? pager.page) !== plan.page || Number(pager.pageSize) !== plan.pageSize)) throw dmpError('DMP_PAGE_MISMATCH', '返回分页与请求不符。');
  return {...base, status: list.length ? 'returned' : 'empty', items, coverage: {returnedCount: list.length, scope: plan.command === 'market-rank' ? 'provider-ranking-snapshot' : 'one-page-only', ...(plan.command === 'market-rank' ? {requestedDate: plan.body.date, rankType: plan.body.rankType, dateVerified: false} : {requestedPage: plan.page, requestedPageSize: plan.pageSize, pager})}};
}
