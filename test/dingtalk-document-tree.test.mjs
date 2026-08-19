import assert from 'node:assert/strict';
import test from 'node:test';

import { cleanDentryName, countTree, inferDentrySourceKind, normalizeDingtalkListing, safeDentry } from '../src/tbcli/dingtalk-document-tree.mjs';
import { selectDingtalkListingHeaders } from '../src/tbcli/commands/document-tree.mjs';

test('keeps only safe DingTalk directory fields', () => {
  const item = safeDentry({
    dentryUuid: 'ABC123',
    name: '测试文档',
    dentryType: 'DOC',
    contentType: 'DINGDOC',
    hasChildren: true,
    dentryStatistic: { childrenCount: 2 },
    updatedTime: 123456,
    creator: { name: 'private', uid: 'secret' },
    corpId: 'secret',
  });
  assert.deepEqual(item, {
    id: 'ABC123',
    name: '测试文档',
    url: 'https://alidocs.dingtalk.com/i/nodes/ABC123',
    sourceKind: 'document',
    type: 'DOC',
    contentType: 'DINGDOC',
    hasChildren: true,
    childrenCount: 2,
    updatedAtEpochMs: 123456,
  });
  assert.equal('creator' in item, false);
  assert.equal('corpId' in item, false);
});

test('removes DingTalk internal filename suffixes from user-facing names', () => {
  assert.equal(cleanDentryName('关键词推广.adoc'), '关键词推广');
  assert.equal(cleanDentryName('报名表.axls'), '报名表');
  assert.equal(cleanDentryName('普通标题'), '普通标题');
});

test('classifies documents, links and table-like nodes before cleaning names', () => {
  assert.equal(inferDentrySourceKind('产品说明.adoc', 'alidoc'), 'document');
  assert.equal(inferDentrySourceKind('活动说明.dlink', 'link'), 'link');
  assert.equal(inferDentrySourceKind('报名表.axls', 'alidoc'), 'sheet');
  assert.equal(inferDentrySourceKind('收集表.able', 'alidoc'), 'table');
});

test('normalizes a successful directory listing and validates its root', () => {
  const listing = normalizeDingtalkListing({
    status: 200,
    isSuccess: true,
    data: {
      dentryUuid: 'ROOT1',
      name: '根目录',
      hasMore: false,
      loadMoreId: '',
      children: [{ dentryUuid: 'CHILD1', name: '子文档' }],
    },
  }, 'ROOT1');
  assert.equal(listing.node.id, 'ROOT1');
  assert.equal(listing.children[0].id, 'CHILD1');
  assert.throws(() => normalizeDingtalkListing({ status: 200, isSuccess: true, data: { dentryUuid: 'OTHER' } }, 'ROOT1'), /节点不匹配/);
});

test('counts all descendants in a document tree', () => {
  assert.equal(countTree([
    { children: [{ children: [] }, { children: [{ children: [] }] }] },
    { children: [] },
  ]), 5);
});

test('keeps temporary directory headers in memory without cookies or authorization', () => {
  const selected = selectDingtalkListingHeaders({
    'a-token': 'temporary',
    'x-xsrf-token': 'xsrf',
    'bx-v': 'version',
    cookie: 'private',
    authorization: 'private',
  });
  assert.deepEqual(selected, {
    'a-token': 'temporary',
    'x-xsrf-token': 'xsrf',
    'bx-v': 'version',
  });
  assert.throws(() => selectDingtalkListingHeaders({}), /临时访问凭据/);
});
