import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { performUnifiedUpdate, resolveNpmInvocation } from '../src/tbcli/commands/update.mjs';
import { checkForUpdate, compareVersions, maybePrintUpdateNotice } from '../src/tbcli/update.mjs';

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

test('prints one throttled reminder for each newer version', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tbcli-update-notice-'));
  const cacheFile = path.join(dir, 'update.json');
  const messages = [];
  const previousError = console.error;
  console.error = (message) => messages.push(message);
  const options = {
    currentVersion: '0.6.4', cacheFile, now: 1000,
    fetchImpl: async () => ({ ok: true, async json() { return { version: '0.6.5' }; } }),
  };
  try {
    await maybePrintUpdateNotice({ _: ['doctor'] }, options);
    await maybePrintUpdateNotice({ _: ['doctor'] }, { ...options, now: 2000 });
  } finally {
    console.error = previousError;
  }
  assert.equal(messages.length, 1);
  assert.match(messages[0], /tbcli update --agent <当前Agent>/);
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
