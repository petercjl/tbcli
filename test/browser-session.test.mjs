import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import {
  hasTaobaoLoginCookies,
  managedChromeLaunchOptions,
  normalizeManagedLaunchError,
  resolveSessionMode,
} from '../src/tbcli/browser-session.mjs';
import { sanitizeCapturedUrl } from '../src/tbcli/commands/dev.mjs';
import { openCdpPage } from '../src/tbcli/commands/browser.mjs';
import { randomDelayMs, waitBeforeTaobaoApiRequest } from '../src/tbcli/api-policy.mjs';

test('requires both a session and an identity cookie', () => {
  assert.equal(hasTaobaoLoginCookies([{ name: 'cookie2' }, { name: 'tracknick' }]), true);
  assert.equal(hasTaobaoLoginCookies([{ name: 'cookie2' }]), false);
  assert.equal(hasTaobaoLoginCookies([{ name: 'tracknick' }]), false);
});

test('auto session mode reuses a running legacy browser or launches managed Chrome', async () => {
  assert.equal(await resolveSessionMode({}, { cdpReachable: async () => true }), 'cdp');
  assert.equal(await resolveSessionMode({}, { cdpReachable: async () => false }), 'managed');
});

test('browser open creates a page when reusing a running CDP browser', async (t) => {
  let request;
  const server = http.createServer((req, res) => {
    request = { method: req.method, url: req.url };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'new-tab' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const address = server.address();
  const result = await openCdpPage(
    `http://127.0.0.1:${address.port}`,
    'https://192.168.100.1:8443/',
  );

  assert.deepEqual(result, { id: 'new-tab' });
  assert.equal(request.method, 'PUT');
  assert.equal(request.url, '/json/new?https%3A%2F%2F192.168.100.1%3A8443%2F');
});

test('explicit managed mode never requires the CDP probe', async () => {
  let probed = false;
  const mode = await resolveSessionMode({ sessionMode: 'managed' }, {
    cdpReachable: async () => { probed = true; return true; },
  });
  assert.equal(mode, 'managed');
  assert.equal(probed, false);
});

test('managed Chrome keeps the browser sandbox enabled', () => {
  const options = managedChromeLaunchOptions('/Applications/Google Chrome');
  assert.equal(options.chromiumSandbox, true);
  assert.equal(options.headless, false);
  assert.doesNotMatch(options.args.join(' '), /--no-sandbox/);
});

test('explicit CDP configuration keeps the compatibility mode', async () => {
  assert.equal(await resolveSessionMode({ cdpUrl: 'http://127.0.0.1:9333' }), 'cdp');
  assert.equal(await resolveSessionMode({ sessionMode: 'cdp' }), 'cdp');
});

test('rejects invalid browser session modes', async () => {
  await assert.rejects(resolveSessionMode({ sessionMode: 'detached' }), /auto、managed 或 cdp/);
});

test('explains when the fixed profile is already open', () => {
  const error = normalizeManagedLaunchError(
    new Error('Failed to create a ProcessSingleton for your profile directory'),
    '/tmp/tbcli-profile',
  );
  assert.match(error.message, /Profile 正被另一个 Chrome 占用/);
  assert.match(error.message, /不会复制或读取浏览器 Cookie/);

  const localized = normalizeManagedLaunchError(
    new Error('Target page has been closed\n正在现有的浏览器会话中打开。'),
    '/tmp/tbcli-profile',
  );
  assert.match(localized.message, /Profile 正被另一个 Chrome 占用/);
});

test('never recommends falling back to an unsafe browser sandbox mode', () => {
  const error = normalizeManagedLaunchError(
    new Error('Chromium sandboxing failed!'),
    '/tmp/tbcli-profile',
  );
  assert.match(error.message, /不会使用不安全的 --no-sandbox/);
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
