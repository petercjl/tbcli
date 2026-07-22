import assert from 'node:assert/strict';
import test from 'node:test';

import { hasTaobaoLoginCookies } from '../src/tbcli/browser-session.mjs';
import { sanitizeCapturedUrl } from '../src/tbcli/commands/dev.mjs';
import { randomDelayMs } from '../src/tbcli/commands/shop-products.mjs';

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
