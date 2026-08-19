import assert from 'node:assert/strict';
import test from 'node:test';

import { hasTaobaoLoginCookies } from '../src/tbcli/browser-session.mjs';
import { sanitizeCapturedUrl } from '../src/tbcli/commands/dev.mjs';
import { randomDelayMs, waitBeforeTaobaoApiRequest } from '../src/tbcli/api-policy.mjs';

test('requires both a session and an identity cookie', () => {
  assert.equal(hasTaobaoLoginCookies([{ name: 'cookie2' }, { name: 'tracknick' }]), true);
  assert.equal(hasTaobaoLoginCookies([{ name: 'cookie2' }]), false);
  assert.equal(hasTaobaoLoginCookies([{ name: 'tracknick' }]), false);
});

test('redacts sensitive captured URL parameters', () => {
  const value = sanitizeCapturedUrl('https://h5api.m.taobao.com/h5/demo?api=x&sign=secret&token=secret');
  const url = new URL(value);
  assert.equal(url.searchParams.get('api'), 'x');
  assert.equal(url.searchParams.get('sign'), '[redacted]');
  assert.equal(url.searchParams.get('token'), '[redacted]');
});

test('generates inclusive random API delays', () => {
  assert.equal(randomDelayMs(1000, 2000, () => 0), 1000);
  assert.equal(randomDelayMs(1000, 2000, () => 0.999999), 2000);
  assert.equal(randomDelayMs(1500, 1500, () => 0.5), 1500);
});

test('shared API policy waits before a request', async () => {
  const page = {
    evaluate: async () => ({ url: 'https://demo.tmall.com/', title: '测试店', text: '商品列表' }),
  };
  const waits = [];
  const delay = await waitBeforeTaobaoApiRequest(
    page,
    { minDelayMs: 1000, maxDelayMs: 2000 },
    { random: () => 0.5, sleepImpl: async (ms) => waits.push(ms) },
  );
  assert.equal(delay, 1500);
  assert.deepEqual(waits, [1500]);
});

test('shared API policy stops before waiting when verification is visible', async () => {
  const page = {
    evaluate: async () => ({ url: 'https://sec.taobao.com/', title: '安全验证', text: '请完成滑块验证' }),
  };
  let waited = false;
  await assert.rejects(
    waitBeforeTaobaoApiRequest(
      page,
      { minDelayMs: 1000, maxDelayMs: 2000 },
      { sleepImpl: async () => { waited = true; } },
    ),
    /立即停止所有请求/,
  );
  assert.equal(waited, false);
});
