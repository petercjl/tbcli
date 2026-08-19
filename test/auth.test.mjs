import assert from 'node:assert/strict';
import test from 'node:test';

import { waitForTaobaoLogin } from '../src/tbcli/commands/auth.mjs';

test('interactive login wait returns as soon as the fixed profile becomes authenticated', async () => {
  const states = [
    [],
    [{ name: 'cookie2' }, { name: 'tracknick' }],
  ];
  let clock = 0;
  const context = {
    cookies: async () => states.shift() || [],
  };
  const loggedIn = await waitForTaobaoLogin(context, {
    timeoutMs: 10000,
    pollIntervalMs: 1000,
    now: () => clock,
    sleepImpl: async (ms) => { clock += ms; },
  });
  assert.equal(loggedIn, true);
  assert.equal(clock, 1000);
});

test('interactive login wait stops cleanly at the timeout', async () => {
  let clock = 0;
  const context = { cookies: async () => [] };
  const loggedIn = await waitForTaobaoLogin(context, {
    timeoutMs: 2500,
    pollIntervalMs: 1000,
    now: () => clock,
    sleepImpl: async (ms) => { clock += ms; },
  });
  assert.equal(loggedIn, false);
  assert.equal(clock, 2500);
});
