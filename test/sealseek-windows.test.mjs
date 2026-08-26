import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { performSealseekSetup, finalizeSealseekSetup } from '../src/tbcli/commands/setup.mjs';
import {
  configureSealseekWindows,
  disablePowerShellTbcliShims,
  inspectSealseekWindows,
  mergePathPrepend,
  resolveSealseekWindowsPaths,
} from '../src/tbcli/sealseek-windows.mjs';

test('resolves Windows SealSeek paths without a fixed user or Node version', () => {
  const result = resolveSealseekWindowsPaths({ platform: 'win32', homeDir: 'D:\\Users\\worker', systemRoot: 'D:\\Windows' });
  assert.equal(result.runtimeInfoPath, 'D:\\Users\\worker\\.sealseek\\binaries\\runtime-info.json');
  assert.equal(result.configPath, 'D:\\Users\\worker\\.sealseek\\sealseek.json');
});

test('puts the canonical npm directory first and deduplicates Windows paths', () => {
  assert.deepEqual(
    mergePathPrepend(['C:\\Node', 'C:\\Tools'], ['C:\\Global\\', 'c:\\node\\']),
    ['C:\\Global', 'c:\\node', 'C:\\Tools'],
  );
});

test('backs up SealSeek config and changes only tools.exec.pathPrepend', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tbcli-sealseek-config-'));
  const configPath = path.join(dir, 'sealseek.json');
  const original = { gateway: { token: 'preserve-me' }, tools: { exec: { timeout: 90, pathPrepend: ['C:\\Old'] } } };
  await fs.writeFile(configPath, `${JSON.stringify(original, null, 2)}\n`, { mode: 0o600 });
  const result = await configureSealseekWindows({
    environment: { configPath, desiredPathPrepend: ['C:\\Global', 'C:\\Node'] },
    now: new Date('2026-08-26T01:02:03.000Z'),
  });
  const updated = JSON.parse(await fs.readFile(configPath, 'utf8'));
  const backup = JSON.parse(await fs.readFile(result.backupPath, 'utf8'));
  assert.equal(result.changed, true);
  assert.equal(updated.gateway.token, 'preserve-me');
  assert.equal(updated.tools.exec.timeout, 90);
  assert.deepEqual(updated.tools.exec.pathPrepend, ['C:\\Global', 'C:\\Node', 'C:\\Old']);
  assert.deepEqual(backup, original);
});

test('disables only PowerShell shims owned by tbcli', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tbcli-sealseek-shim-'));
  const canonicalPs1 = path.join(dir, 'tbcli.ps1');
  const legacyPs1 = path.join(dir, 'foreign.ps1');
  await fs.writeFile(canonicalPs1, "& node 'node_modules/@petercjl/tbcli/scripts/tbcli.mjs'\n");
  await fs.writeFile(legacyPs1, "Write-Output 'foreign'\n");
  const disabled = await disablePowerShellTbcliShims({ canonicalPs1, legacyPs1 });
  assert.equal(disabled.length, 1);
  await assert.rejects(fs.access(canonicalPs1));
  await fs.access(`${canonicalPs1}.disabled-by-tbcli`);
  await fs.access(legacyPs1);
});

test('doctor inspection verifies the configured canonical environment', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tbcli-sealseek-doctor-'));
  const targets = Object.fromEntries(['configPath', 'runtimeInfoPath', 'nodePath', 'npmCli', 'canonicalPackageJson', 'canonicalCmd', 'canonicalPs1'].map((key) => [key, path.join(dir, key)]));
  await fs.writeFile(targets.configPath, JSON.stringify({ tools: { exec: { pathPrepend: ['C:\\Global', 'C:\\Node'] } } }));
  await fs.writeFile(targets.nodePath, 'node');
  await fs.writeFile(targets.runtimeInfoPath, '{}');
  await fs.writeFile(targets.npmCli, 'npm');
  await fs.writeFile(targets.canonicalPackageJson, JSON.stringify({ version: '0.7.0' }));
  await fs.writeFile(targets.canonicalCmd, 'cmd');
  const result = await inspectSealseekWindows({ environment: {
    ...targets, nodeVersion: '22.0.0', npmGlobalDir: 'C:\\Global', canonicalEntry: 'entry',
    desiredPathPrepend: ['C:\\Global', 'C:\\Node'],
  } });
  assert.equal(result.ok, true);
  assert.equal(result.installedVersion, '0.7.0');
});

test('clean setup installs to the runtime-info prefix and finalizes through the canonical entry', async () => {
  const environment = {
    nodePath: 'C:\\Managed\\node.exe', npmCli: 'C:\\Managed\\npm-cli.js', npmGlobalDir: 'C:\\Global',
    canonicalEntry: 'C:\\Global\\node_modules\\@petercjl\\tbcli\\scripts\\tbcli.mjs', canonicalCmd: 'C:\\Global\\tbcli.cmd',
  };
  const calls = [];
  const run = async (command, args) => {
    calls.push({ command, args });
    if (args.includes('--finalize')) return { stdout: JSON.stringify({ ok: true, restartRequired: true, nextStep: 'restart', skill: { current: true } }) };
    if (args.includes('--version')) return { stdout: '0.7.0\n' };
    return { stdout: '' };
  };
  const result = await performSealseekSetup({}, { platform: 'win32', environment, run, exists: async () => false });
  assert.deepEqual(calls[0].args, [environment.npmCli, 'install', '--global', '--prefix', environment.npmGlobalDir, '@petercjl/tbcli@latest']);
  assert.deepEqual(calls[1].args, [environment.canonicalEntry, 'setup', 'sealseek', '--finalize', '--json']);
  assert.equal(result.cli.version, '0.7.0');
});

test('setup does not reinstall an already canonical package', async () => {
  const environment = {
    nodePath: 'C:\\Managed\\node.exe', npmCli: 'C:\\Managed\\npm-cli.js', npmGlobalDir: 'C:\\Global',
    canonicalEntry: 'C:\\Global\\node_modules\\@petercjl\\tbcli\\scripts\\tbcli.mjs', canonicalCmd: 'C:\\Global\\tbcli.cmd',
  };
  const calls = [];
  const run = async (command, args) => {
    calls.push({ command, args });
    if (args.includes('--finalize')) return { stdout: JSON.stringify({ ok: true, skill: { current: true } }) };
    return { stdout: '0.7.0\n' };
  };
  await performSealseekSetup({}, { platform: 'win32', environment, run, exists: async () => true });
  assert.equal(calls.some(({ args }) => args.includes('install')), false);
});

test('setup finalization composes config, Skill, shim and diagnosis results', async () => {
  const result = await finalizeSealseekSetup({}, {
    environment: { canonicalPs1: 'unused', legacyPs1: 'unused' },
    configure: async () => ({ changed: true, backupPath: 'backup' }),
    ensureSkill: async () => ({ action: 'installed', state: 'current', current: true, destination: 'skill' }),
    disableShims: async () => [{ target: 'tbcli.ps1' }],
    inspect: async () => ({ ok: true, checks: {} }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.restartRequired, true);
  assert.equal(result.skill.current, true);
});
