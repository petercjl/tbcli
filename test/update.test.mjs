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

test('unified update upgrades npm package, refreshes stale Skill, and verifies current state', async () => {
  const calls = [];
  let statusChecks = 0;
  const run = async (command, args) => {
    calls.push({ command, args });
    if (command === '/npm') return { stdout: '', stderr: '' };
    if (args[1] === '--version') return { stdout: '0.6.5\n', stderr: '' };
    if (args.includes('status')) {
      statusChecks += 1;
      return { stdout: JSON.stringify(statusChecks === 1
        ? { state: 'stale', current: false, targetRoot: '/skills', destination: '/skills/tbcli' }
        : { state: 'current', current: true, targetRoot: '/skills', destination: '/skills/tbcli' }) };
    }
    if (args.includes('update')) return { stdout: JSON.stringify({ state: 'current', current: true, targetRoot: '/skills' }) };
    throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
  };
  const result = await performUnifiedUpdate(
    { agent: 'sealseek' },
    { run, npm: { command: '/npm', prefixArgs: [], shell: false }, node: '/node', cliEntry: '/tbcli.mjs' },
  );
  assert.equal(result.cli.afterVersion, '0.6.5');
  assert.equal(result.skill.action, 'updated');
  assert.equal(result.skill.current, true);
  assert.deepEqual(calls[0].args, ['install', '-g', '@petercjl/tbcli@latest']);
  assert.ok(calls.some((call) => call.args.join(' ').includes('skill update --agent sealseek')));
});

test('unified update installs a missing managed Skill', async () => {
  let statusChecks = 0;
  const run = async (command, args) => {
    if (command === '/npm') return { stdout: '', stderr: '' };
    if (args[1] === '--version') return { stdout: '0.6.5\n', stderr: '' };
    if (args.includes('status')) {
      statusChecks += 1;
      return { stdout: JSON.stringify(statusChecks === 1
        ? { state: 'absent', current: false, targetRoot: '/skills', destination: '/skills/tbcli' }
        : { state: 'current', current: true, targetRoot: '/skills', destination: '/skills/tbcli' }) };
    }
    if (args.includes('install')) return { stdout: JSON.stringify({ state: 'current', current: true, targetRoot: '/skills' }) };
    throw new Error('unexpected command');
  };
  const result = await performUnifiedUpdate(
    { agent: 'sealseek' },
    { run, npm: { command: '/npm', prefixArgs: [], shell: false }, node: '/node', cliEntry: '/tbcli.mjs' },
  );
  assert.equal(result.skill.action, 'installed');
});

test('automatic package update refreshes every installed managed Skill copy', async () => {
  const updated = [];
  const result = await performAutomaticUpdate({
    platform: 'darwin', npm: { command: '/npm', prefixArgs: [], shell: false }, node: '/node', cliEntry: '/tbcli.mjs',
    agents: ['codex'], skills: ['tbcli', 'ecommerce-monthly-profit-report'],
    resolveRoot: () => '/skills',
    getStatus: async (_root, skill) => skill === 'tbcli'
      ? { skill, state: 'stale', managed: true, current: false }
      : { skill, state: 'current', managed: true, current: true },
    updateInstalledSkill: async (opts) => { updated.push(opts); return { skill: opts.skill, state: 'current', managed: true, current: true, action: 'updated' }; },
    run: async (command, args) => {
      if (command === '/npm') return { stdout: '', stderr: '' };
      if (args.includes('--version')) return { stdout: '0.10.0\n', stderr: '' };
      throw new Error('unexpected command');
    },
  });
  assert.deepEqual(updated, [{ agent: 'codex', skill: 'tbcli' }]);
  assert.equal(result.cli.afterVersion, '0.10.0');
  assert.equal(result.skills.length, 2);
});

test('automatic package update keeps going when one managed Skill refresh fails', async () => {
  const result = await performAutomaticUpdate({
    platform: 'darwin', npm: { command: '/npm', prefixArgs: [], shell: false }, node: '/node', cliEntry: '/tbcli.mjs',
    agents: ['codex'], skills: ['tbcli'], resolveRoot: () => '/skills',
    getStatus: async () => ({ skill: 'tbcli', state: 'stale', managed: true, current: false }),
    updateInstalledSkill: async () => { throw new Error('read only destination'); },
    run: async (command, args) => {
      if (command === '/npm') return { stdout: '', stderr: '' };
      if (args.includes('--version')) return { stdout: '0.10.0\n', stderr: '' };
      throw new Error('unexpected command');
    },
  });
  assert.equal(result.updated, true);
  assert.equal(result.skills[0].action, 'warning');
  assert.match(result.skills[0].warning, /read only destination/);
});

test('Windows SealSeek update uses the canonical prefix and newly installed entry', async () => {
  const environment = {
    nodePath: 'C:\\Managed\\node.exe', npmCli: 'C:\\Managed\\npm-cli.js', npmGlobalDir: 'C:\\Global',
    canonicalEntry: 'C:\\Global\\node_modules\\@petercjl\\tbcli\\scripts\\tbcli.mjs', canonicalCmd: 'C:\\Global\\tbcli.cmd',
  };
  const calls = [];
  const run = async (command, args) => {
    calls.push({ command, args });
    if (args.includes('--finalize')) return { stdout: JSON.stringify({ ok: true, restartRequired: false, skill: { action: 'updated', state: 'current', current: true, destination: 'C:\\Skills\\tbcli' } }) };
    if (args.includes('--version')) return { stdout: '0.7.0\n' };
    return { stdout: '' };
  };
  const result = await performUnifiedUpdate({ agent: 'sealseek' }, { platform: 'win32', environment, run });
  assert.deepEqual(calls[0].args, [environment.npmCli, 'install', '--global', '--prefix', environment.npmGlobalDir, '@petercjl/tbcli@latest']);
  assert.deepEqual(calls[1].args, [environment.canonicalEntry, 'setup', 'sealseek', '--finalize', '--json']);
  assert.equal(result.cli.afterVersion, '0.7.0');
  assert.equal(result.skill.current, true);
});
