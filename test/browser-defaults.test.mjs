import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {resolveSessionMode} from '../src/tbcli/browser-session.mjs';
import {inspectBrowserStatus} from '../src/tbcli/commands/browser.mjs';
import {maybeAutoUpdate} from '../src/tbcli/update.mjs';

for (const browserRole of ['merchant', 'buyer']) {
  test(`${browserRole} auto stays CDP even without a prepared browser`, async () => {
    let probed = false;
    assert.equal(await resolveSessionMode({browserRole}, {cdpReachable: async () => {probed = true; return false;}}), 'cdp');
    assert.equal(probed, false);
    assert.equal(await resolveSessionMode({browserRole, sessionMode: 'managed'}), 'managed');
  });
}
test('read-only browser status distinguishes stopped, ready and profile conflict', async () => {
  const opts = {browserRole: 'merchant'};
  const stopped = await inspectBrowserStatus(opts, {reachable: async () => false, verifyProfile: async (_, x) => assert.equal(x.allowStopped, true)});
  assert.equal(stopped.state, 'stopped'); assert.equal(stopped.profileVerified, false);
  const ready = await inspectBrowserStatus(opts, {reachable: async () => true, verifyProfile: async (_, x) => assert.equal(x.allowStopped, false)});
  assert.equal(ready.state, 'ready'); assert.equal(ready.ok, true); assert.equal(ready.profileVerified, true);
  const conflict = await inspectBrowserStatus(opts, {reachable: async () => false, verifyProfile: async () => {throw Object.assign(Error('profile is held by another mode'), {code: 'BROWSER_PROFILE_CONFLICT'});}});
  assert.equal(conflict.state, 'conflict'); assert.equal(conflict.ok, false); assert.equal(conflict.error.code, 'BROWSER_PROFILE_CONFLICT');
});
test('remote browser status does not attest or inspect a local profile', async () => {
  const result = await inspectBrowserStatus({cdpUrl: 'http://192.0.2.1:9223'}, {reachable: async () => true, verifyProfile: async () => assert.fail('remote profile cannot be verified locally')});
  assert.equal(result.state, 'ready'); assert.equal(result.profileVerified, null);
});
test('browser status skips update checks even with automatic installation enabled', async () => {
  const result = await maybeAutoUpdate({_: ['browser', 'status']}, {environment: {TBCLI_AUTO_INSTALL: '1'}, isPackagedInstall: () => assert.fail('metadata check must not reach package detection')});
  assert.equal(result.checked, false); assert.equal(result.updated, false);
});
test('CLI status reports a stopped endpoint without creating its Profile or launching Chrome', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tbcli-status-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const profile = path.join(dir, 'new profile');
  const stdout = execFileSync(process.execPath, ['scripts/tbcli.mjs', 'browser', 'status', '--browser-role', 'merchant', '--cdp-url', 'http://127.0.0.1:1', '--profile-dir', profile, '--chrome-path', path.join(dir, 'missing-chrome'), '--json'], {encoding: 'utf8', timeout: 15000, env: {...process.env, TBCLI_UPDATE_CHECK: '0'}});
  const result = JSON.parse(stdout);
  assert.equal(result.state, 'stopped'); assert.equal(result.ok, false); assert.equal(fs.existsSync(profile), false);
});
