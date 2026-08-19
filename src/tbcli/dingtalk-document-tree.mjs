import { cleanDocumentTitle } from './dingtalk-document.mjs';

export function normalizeDingtalkListing(payload, expectedNodeId = '') {
  if (!payload || payload.isSuccess !== true || Number(payload.status) !== 200 || !payload.data) {
    throw new Error('钉钉文档目录返回失败');
  }
  const data = payload.data;
  const nodeId = String(data.dentryUuid || expectedNodeId || '');
  if (expectedNodeId && nodeId && nodeId !== expectedNodeId) {
    throw new Error(`钉钉文档目录节点不匹配：${nodeId}`);
  }
  return {
    node: safeDentry(data),
    children: Array.isArray(data.children) ? data.children.map(safeDentry) : [],
    hasMore: Boolean(data.hasMore),
    loadMoreId: String(data.loadMoreId || ''),
  };
}

export function safeDentry(value = {}) {
  const id = String(value.dentryUuid || '');
  if (!id) throw new Error('钉钉目录项缺少节点编号');
  const rawName = String(value.name || '未命名文档');
  return {
    id,
    name: cleanDentryName(rawName),
    url: `https://alidocs.dingtalk.com/i/nodes/${id}`,
    sourceKind: inferDentrySourceKind(rawName, value.contentType),
    type: String(value.dentryType || ''),
    contentType: String(value.contentType || ''),
    hasChildren: Boolean(value.hasChildren),
    childrenCount: nonnegativeInteger(value.dentryStatistic?.childrenCount),
    updatedAtEpochMs: positiveNumberOrNull(value.updatedTime),
  };
}

export function inferDentrySourceKind(name, contentType = '') {
  if (/\.dlink$/i.test(name) || String(contentType).toLowerCase() === 'link') return 'link';
  if (/\.axls$/i.test(name)) return 'sheet';
  if (/\.able$/i.test(name)) return 'table';
  if (/\.adoc$/i.test(name) || ['alidoc', 'dingdoc'].includes(String(contentType).toLowerCase())) return 'document';
  return 'unknown';
}

export function cleanDentryName(value) {
  return cleanDocumentTitle(value).replace(/\.(?:adoc|dlink|axls|able)$/i, '');
}

export function countTree(nodes) {
  let count = 0;
  for (const node of nodes || []) count += 1 + countTree(node.children || []);
  return count;
}

function nonnegativeInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

function positiveNumberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}
