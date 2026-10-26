import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EventEmitter } from 'node:events';

import { performAutomaticUpdate, performUnifiedUpdate, resolveNpmInvocation } from '../src/tbcli/commands/update.mjs';
import {
  checkForUpdate, compareVersions, isPackagedNpmInstall, maybeAutoUpdate,
  relaunchWithUpdatedCli,
} from '../src/tbcli/update.mjs';

test('compares ordinary release versions', () => {
  assert.equal(compareVersions('0.6.4', '0.6.3'), 1);
  assert.equal(compareVersions('0.6.3', '0.6.3'), 0);
  assert.equal(compareVersions('0.6.2', '0.6.3'), -1);
  assert.equal(compareVersions('1.0.0', '0.99.99'), 1);
});

test('checks npm at most once per cache interval', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tbcli-update-cache-'));
  const cacheFile = path.join(dir, 'update.json');
  let fetches = 0;
  const fetchImpl = async () => {
    fetches += 1;
    return { ok: true, async json() { return { version: '0.6.5' }; } };
  };
  const first = await checkForUpdate({ currentVersion: '0.6.4', cacheFile, now: 1000, fetchImpl });
  const second = await checkForUpdate({ currentVersion: '0.6.4', cacheFile, now: 2000, fetchImpl });
  assert.equal(first.updateAvailable, true);
  assert.equal(second.latestVersion, '0.6.5');
  assert.equal(fetches, 1);
});

test('automatic update runs only for packaged installs and fetches a newer release', async () => {
  assert.equal(isPackagedNpmInstall('/usr/local/lib/node_modules/@petercjl/tbcli'), true);
  assert.equal(isPackagedNpmInstall('/workspace/tbcli'), false);
  const skipped = await maybeAutoUpdate({ _: ['doctor'] }, { isPackagedInstall: () => false });
  assert.equal(skipped.reason, 'source-checkout');
  let updates = 0;
  const result = await maybeAutoUpdate({ _: ['doctor'] }, {
    isPackagedInstall: () => true,
    environment:{TBCLI_AUTO_INSTALL:'1'},
    currentVersion: '0.9.0', cacheFile: path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'tbcli-auto-update-')), 'update.json'),
    now: 1000,
    fetchImpl: async () => ({ ok: true, async json() { return { version: '0.10.0' }; } }),
    performUpdate: async () => { updates += 1; return { updated: true, cli: { afterVersion: '0.10.0' } }; },
  });
  assert.equal(result.updated, true);
  assert.equal(updates, 1);
});

test('automatic update failure is non-blocking and re-exec is guarded', async () => {
  const failed = await maybeAutoUpdate({ _: ['doctor'] }, {
    isPackagedInstall: () => true,
    environment:{TBCLI_AUTO_INSTALL:'1'},
    currentVersion: '0.9.0', cacheFile: path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'tbcli-auto-fail-')), 'update.json'),
    now: 1000,
    fetchImpl: async () => ({ ok: true, async json() { return { version: '0.10.0' }; } }),
    performUpdate: async () => { throw new Error('offline'); },
  });
  assert.equal(failed.updated, false);
  assert.match(failed.warning, /offline/);
  const guarded = await maybeAutoUpdate({ _: ['doctor'] }, { environment: { TBCLI_AUTO_UPDATE_REEXEC: '1' } });
  assert.equal(guarded.checked, false);
});

test('successful automatic update relaunches the original command once', async () => {
  let spawned;
  const result = await relaunchWithUpdatedCli(['db', 'status', '--json'], {
    node: '/node', entry: '/tbcli.mjs',
    spawnImpl(command, args, options) {
      spawned = { command, args, options };
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('exit', 0, null));
      return child;
    },
  });
  assert.deepEqual(spawned.args, ['/tbcli.mjs', 'db', 'status', '--json']);
  assert.equal(spawned.options.env.TBCLI_AUTO_UPDATE_REEXEC, '1');
  assert.equal(result.code, 0);
});

test('uses the managed Node runtime to launch npm on Windows without relying on PATH', async () => {
  const nodePath = 'C:\\SealSeek\\node\\node.exe';
  const npmCli = 'C:\\SealSeek\\node\\node_modules\\npm\\bin\\npm-cli.js';
  const result = await resolveNpmInvocation({
    platform: 'win32', nodePath, environment: {}, existsImpl: async (candidate) => candidate === npmCli,
  });
  assert.deepEqual(result, { command: nodePath, prefixArgs: [npmCli], shell: false });
});

test('automatic installation requires a selected target and never sweeps Agents',async()=>{let called=false;const r=await performAutomaticUpdate({agents:['codex','arbitrary-host'],run:async()=>{called=true;}});assert.equal(r.updated,false);assert.equal(r.reason,'selected-target-required');assert.equal(called,false);});
test('package update refuses an unresolved target before acquisition',async()=>{await assert.rejects(performUnifiedUpdate({agent:'arbitrary-host'}),{code:'TARGET_REQUIRED'});});
