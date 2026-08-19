import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { parseArgs } from '../src/tbcli/args.mjs';

import {
  exportDocumentBundle,
  isTrustedDingtalkImageUrl,
} from '../src/tbcli/commands/document.mjs';
import {
  assertDingtalkDocumentUrl,
  extractDingtalkDocument,
  renderAlidocsPackage,
} from '../src/tbcli/dingtalk-document.mjs';

const SOURCE_URL = 'https://alidocs.dingtalk.com/i/nodes/demoNode123';

test('parses the document close-tab option as an explicit opt-in', () => {
  assert.equal(parseArgs(['document', 'get', '--close-tab']).closeTab, true);
  assert.equal(parseArgs(['document', 'get']).closeTab, undefined);
});

function samplePackage() {
  const main = 'main-part';
  return {
    version: 1,
    type: 'application/x-alidocs-package',
    main,
    parts: {
      [main]: {
        type: 'application/x-alidocs-word',
        data: {
          body: ['root', {},
            ['h2', {}, ['span', {}, ['span', { 'data-type': 'leaf' }, '操作方法']]],
            ['p', {}, ['span', {}, ['span', { bold: true }, '选择计划']], ['span', {}, '并开启功能。']],
            ['table', {},
              ['tr', {}, ['tc', {}, ['p', {}, ['span', {}, '字段']]], ['tc', {}, ['p', {}, ['span', {}, '说明']]]],
              ['tr', {}, ['tc', {}, ['p', {}, ['span', {}, '模式']]], ['tc', {}, ['p', {}, ['span', {}, '智能']]]]],
            ['p', {}, ['span', {}, '界面证据'], ['img', {
              uuid: 'image-1',
              name: 'image.png',
              src: '/core/api/resources/img/demo-resource',
              size: 8,
              extraData: {
                resourceId: 'resource-1',
                metaData: { format: 'png', originWidth: 1200, originHeight: 600, size: 8 },
              },
            }]],
          ],
        },
      },
    },
    plugins: 'plugins-part',
  };
}

function samplePayload({ deltas = [] } = {}) {
  return {
    status: 200,
    isSuccess: true,
    data: {
      documentContent: {
        checkpoint: {
          content: JSON.stringify(samplePackage()),
          baseVersion: 12,
          gmtCreate: 123456789,
        },
        deltas: { list: deltas },
      },
      fileMetaInfo: {
        name: '关键词推广【AI选词】',
        dentryUuid: 'demoNode123',
        gmtModified: 123456789,
        abilities: { file: 4 },
        extMeta: { docMeta: { publicOpenPermission: 'ONLY_VIEWER' } },
      },
    },
  };
}

test('accepts only supported DingTalk document URLs', () => {
  assert.equal(assertDingtalkDocumentUrl(SOURCE_URL).hostname, 'alidocs.dingtalk.com');
  assert.throws(() => assertDingtalkDocumentUrl('https://example.com/i/nodes/demo'), /只支持/);
});

test('accepts only fixed DingTalk image resource hosts and paths', () => {
  assert.equal(
    isTrustedDingtalkImageUrl('https://alidocs.dingtalk.com/core/api/resources/img/demo-resource'),
    true,
  );
  assert.equal(
    isTrustedDingtalkImageUrl('https://alidocs.oss-cn-zhangjiakou.aliyuncs.com/lark/https://yuque.antfin.com/demo/image.png'),
    true,
  );
  assert.equal(
    isTrustedDingtalkImageUrl('https://alidocs.oss-cn-zhangjiakou.aliyuncs.com/a/159529106296/25322536524/a1714986-ad87-4aff-ad91-077286c7c4f5.jpeg'),
    true,
  );
  assert.equal(
    isTrustedDingtalkImageUrl('https://alidocs.oss-cn-zhangjiakou.aliyuncs.com/private/image.png'),
    false,
  );
  assert.equal(
    isTrustedDingtalkImageUrl('https://alidocs.oss-cn-zhangjiakou.aliyuncs.com/a/private/image.jpeg'),
    false,
  );
  assert.equal(
    isTrustedDingtalkImageUrl('https://alidocs.oss-cn-zhangjiakou.aliyuncs.com/a/159529106296/25322536524/../../private.jpeg'),
    false,
  );
  assert.equal(
    isTrustedDingtalkImageUrl('http://alidocs.oss-cn-zhangjiakou.aliyuncs.com/lark/image.png'),
    false,
  );
  assert.equal(
    isTrustedDingtalkImageUrl('http://alidocs.oss-cn-zhangjiakou.aliyuncs.com/a/159529106296/25322536524/a1714986-ad87-4aff-ad91-077286c7c4f5.jpeg'),
    false,
  );
  assert.equal(
    isTrustedDingtalkImageUrl('https://alidocs.oss-cn-zhangjiakou.aliyuncs.com.evil.example/lark/image.png'),
    false,
  );
});

test('extracts safe document metadata and rejects unapplied deltas', () => {
  const extracted = extractDingtalkDocument(samplePayload(), SOURCE_URL, '2026-08-03T00:00:00.000Z');
  assert.equal(extracted.metadata.title, '关键词推广【AI选词】');
  assert.equal(extracted.metadata.nodeId, 'demoNode123');
  assert.equal(extracted.metadata.canRead, true);
  assert.equal(extracted.packageData.type, 'application/x-alidocs-package');
  assert.throws(
    () => extractDingtalkDocument(samplePayload({ deltas: [{ op: 'demo' }] }), SOURCE_URL),
    /未合并增量/,
  );
});

test('renders headings, paragraphs, tables, text and image inventory', () => {
  const rendered = renderAlidocsPackage(samplePackage(), {
    title: '关键词推广【AI选词】',
    sourceUrl: SOURCE_URL,
  });
  assert.match(rendered.markdown, /^# 关键词推广【AI选词】/);
  assert.match(rendered.markdown, /## 操作方法/);
  assert.match(rendered.markdown, /\*\*选择计划\*\*并开启功能/);
  assert.match(rendered.markdown, /\| 字段 \| 说明 \|/);
  assert.match(rendered.markdown, /!\[文档图片 IMG-01\]\(images\/01\.png\)/);
  assert.match(rendered.text, /模式\t智能/);
  assert.equal(rendered.tables.length, 1);
  assert.deepEqual(rendered.images[0], {
    id: 'IMG-01',
    resourceId: 'resource-1',
    originalWidth: 1200,
    originalHeight: 600,
    expectedSize: 8,
    format: 'png',
    sourcePath: '/core/api/resources/img/demo-resource',
    localPath: 'images/01.png',
  });
});

test('exports an atomic text bundle without overwriting an existing directory', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'tbcli-dingtalk-test-'));
  const outputDir = path.join(base, 'bundle');
  try {
    const metadata = extractDingtalkDocument(samplePayload(), SOURCE_URL).metadata;
    const packageData = samplePackage();
    const rendered = renderAlidocsPackage(packageData, { title: metadata.title, sourceUrl: SOURCE_URL });
    const result = await exportDocumentBundle({
      context: {},
      page: {},
      outputDir,
      timeoutMs: 30000,
      capturedImages: new Map(),
      metadata,
      packageData,
      rendered,
      includeImages: false,
    });
    assert.equal(result.downloadedImages, 0);
    assert.match(await fs.readFile(path.join(outputDir, 'content.md'), 'utf8'), /操作方法/);
    assert.equal((await fs.stat(path.join(outputDir, 'document-package.json'))).isFile(), true);
    assert.equal((await fs.stat(path.join(outputDir, 'images.json'))).isFile(), true);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test('keeps document text and skips a malformed image URL that points back to a document', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'tbcli-dingtalk-test-'));
  const outputDir = path.join(base, 'bundle');
  try {
    const metadata = extractDingtalkDocument(samplePayload(), SOURCE_URL).metadata;
    const packageData = samplePackage();
    const rendered = renderAlidocsPackage(packageData, { title: metadata.title, sourceUrl: SOURCE_URL });
    rendered.images[0].sourcePath = SOURCE_URL;
    const result = await exportDocumentBundle({
      context: {},
      page: {},
      outputDir,
      timeoutMs: 30000,
      capturedImages: new Map(),
      metadata,
      packageData,
      rendered,
      includeImages: true,
    });
    assert.equal(result.downloadedImages, 0);
    assert.equal(result.skippedImages, 1);
    const inventory = JSON.parse(await fs.readFile(path.join(outputDir, 'images.json'), 'utf8'));
    assert.equal(inventory[0].downloaded, false);
    assert.equal(inventory[0].skippedReason, 'invalid-or-non-image-resource-url');
    assert.match(await fs.readFile(path.join(outputDir, 'content.md'), 'utf8'), /操作方法/);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});
