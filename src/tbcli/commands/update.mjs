import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { resolveTargetRoot } from './skill.mjs';
import { TBCLI_VERSION } from '../version.mjs';

const execFileAsync = promisify(execFile);

async function exists(target) {
  try { await fs.access(target); return true; } catch { return false; }
}

export async function resolveNpmInvocation({
  platform = process.platform,
  nodePath = process.execPath,
  environment = process.env,
  existsImpl = exists,
} = {}) {
  const pathApi = platform === 'win32' ? path.win32 : path;
  const explicit = String(environment.TBCLI_NPM_PATH || '').trim();
  if (explicit) {
    if (explicit.endsWith('.js')) return { command: nodePath, prefixArgs: [explicit], shell: false };
    return { command: explicit, prefixArgs: [], shell: platform === 'win32' && /\.cmd$/i.test(explicit) };
  }
  const nodeDir = pathApi.dirname(nodePath);
  const cliCandidates = [
    pathApi.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    pathApi.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  for (const candidate of cliCandidates) {
    if (await existsImpl(candidate)) return { command: nodePath, prefixArgs: [candidate], shell: false };
  }
  const sibling = pathApi.join(nodeDir, platform === 'win32' ? 'npm.cmd' : 'npm');
  if (await existsImpl(sibling)) return { command: sibling, prefixArgs: [], shell: platform === 'win32' };
  return { command: platform === 'win32' ? 'npm.cmd' : 'npm', prefixArgs: [], shell: platform === 'win32' };
}

async function runCaptured(command, args, options = {}) {
  try {
    const result = await execFileAsync(command, args, {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, TBCLI_UPDATE_CHECK: '0' },
      ...options,
    });
    return { stdout: result.stdout || '', stderr: result.stderr || '' };
  } catch (error) {
    const detail = String(error.stderr || error.stdout || error.message || '').trim().slice(-3000);
    throw new Error(`更新命令执行失败：${detail}`);
  }
}

function targetArgs(opts) {
  resolveTargetRoot(opts);
  return opts.agent ? ['--agent', opts.agent] : ['--target-dir', opts.targetDir];
}

function parseJsonOutput(output, label) {
  try { return JSON.parse(String(output).trim()); } catch {
    throw new Error(`${label} 未返回有效 JSON`);
  }
}

export async function performUnifiedUpdate(opts = {}, dependencies = {}) {
  const run = dependencies.run || runCaptured;
  const npm = dependencies.npm || await resolveNpmInvocation();
  const cliEntry = dependencies.cliEntry || process.argv[1];
  const node = dependencies.node || process.execPath;
  const selector = targetArgs(opts);

  await run(npm.command, [...npm.prefixArgs, 'install', '-g', '@petercjl/tbcli@latest'], { shell: npm.shell });
  const versionResult = await run(node, [cliEntry, '--version']);
  const afterVersion = versionResult.stdout.trim().split(/\r?\n/).at(-1);
  if (!afterVersion) throw new Error('CLI 升级后无法读取版本');

  let status = parseJsonOutput((await run(node, [cliEntry, 'skill', 'status', ...selector])).stdout, 'Skill 状态检查');
  let skillAction = 'unchanged';
  if (status.state === 'absent') {
    status = parseJsonOutput((await run(node, [cliEntry, 'skill', 'install', ...selector])).stdout, 'Skill 安装');
    skillAction = 'installed';
  } else if (status.state === 'stale') {
    status = parseJsonOutput((await run(node, [cliEntry, 'skill', 'update', ...selector])).stdout, 'Skill 更新');
    skillAction = 'updated';
  } else if (status.state !== 'current') {
    throw new Error(`CLI 已升级到 ${afterVersion}，但 Skill 状态为 ${status.state}，为保护非受管目录已停止；请让管理员检查 ${status.destination}`);
  }

  const verified = parseJsonOutput((await run(node, [cliEntry, 'skill', 'status', ...selector])).stdout, 'Skill 最终验证');
  if (verified.state !== 'current' || !verified.current) {
    throw new Error(`CLI 已升级到 ${afterVersion}，但 Skill 最终状态不是 current`);
  }
  return {
    updated: true,
    cli: { beforeVersion: TBCLI_VERSION, afterVersion },
    skill: { agent: opts.agent || null, targetDir: verified.targetRoot, action: skillAction, state: verified.state, current: verified.current },
  };
}

export async function runUnifiedUpdate(opts = {}) {
  const result = await performUnifiedUpdate(opts);
  console.log(JSON.stringify(result, null, 2));
}
