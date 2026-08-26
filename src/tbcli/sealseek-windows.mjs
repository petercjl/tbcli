import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function normalizeWindowsPath(value) {
  return path.win32.normalize(String(value || '').trim()).replace(/[\\/]+$/, '').toLowerCase();
}

async function pathExists(target, fsImpl = fs) {
  try { await fsImpl.access(target); return true; } catch { return false; }
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 必须是 JSON 对象`);
  return value;
}

function requiredString(value, label) {
  const result = String(value || '').trim();
  if (!result) throw new Error(`SealSeek runtime-info 缺少 ${label}`);
  return result;
}

function stamp(now = new Date()) {
  return now.toISOString().replace(/[-:TZ]/g, '').replace('.', '-');
}

export function resolveSealseekWindowsPaths({
  platform = process.platform,
  homeDir = process.env.USERPROFILE || os.homedir(),
  systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows',
} = {}) {
  if (platform !== 'win32') throw new Error('此命令仅适用于 Windows SealSeek');
  const root = path.win32.join(homeDir, '.sealseek');
  return {
    homeDir,
    root,
    configPath: path.win32.join(root, 'sealseek.json'),
    runtimeInfoPath: path.win32.join(root, 'binaries', 'runtime-info.json'),
    skillRoot: path.win32.join(root, 'skill_pool'),
    system32: path.win32.join(systemRoot, 'System32'),
    powershellDir: path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0'),
  };
}

export async function discoverSealseekWindows(options = {}) {
  const fsImpl = options.fsImpl || fs;
  const locations = resolveSealseekWindowsPaths(options);
  let runtimeInfo;
  try {
    runtimeInfo = JSON.parse(await fsImpl.readFile(locations.runtimeInfoPath, 'utf8'));
  } catch (error) {
    throw new Error(`无法读取 SealSeek 托管运行时：${locations.runtimeInfoPath}；请先启动一次 SealSeek。${error.message ? ` ${error.message}` : ''}`);
  }
  const node = requireObject(runtimeInfo.node, 'runtime-info.node');
  const nodePath = requiredString(node.executablePath, 'node.executablePath');
  const nodeInstallDir = requiredString(node.installPath, 'node.installPath');
  const npmGlobalDir = requiredString(node.npmGlobalDir, 'node.npmGlobalDir');
  const npmCli = path.win32.join(nodeInstallDir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const canonicalEntry = path.win32.join(npmGlobalDir, 'node_modules', '@petercjl', 'tbcli', 'scripts', 'tbcli.mjs');
  const desiredPathPrepend = [npmGlobalDir, nodeInstallDir, locations.powershellDir, locations.system32];
  return {
    ...locations,
    nodeVersion: String(node.version || ''),
    nodePath,
    nodeInstallDir,
    npmGlobalDir,
    npmCli,
    canonicalEntry,
    canonicalPackageJson: path.win32.join(npmGlobalDir, 'node_modules', '@petercjl', 'tbcli', 'package.json'),
    canonicalCmd: path.win32.join(npmGlobalDir, 'tbcli.cmd'),
    canonicalPs1: path.win32.join(npmGlobalDir, 'tbcli.ps1'),
    legacyCmd: path.win32.join(nodeInstallDir, 'tbcli.cmd'),
    legacyPs1: path.win32.join(nodeInstallDir, 'tbcli.ps1'),
    desiredPathPrepend,
  };
}

export function mergePathPrepend(existing = [], desired = []) {
  if (!Array.isArray(existing)) throw new Error('tools.exec.pathPrepend 必须是字符串数组');
  const result = [];
  const seen = new Set();
  for (const item of [...desired, ...existing]) {
    if (typeof item !== 'string' || !item.trim()) throw new Error('tools.exec.pathPrepend 只能包含非空字符串');
    const key = normalizeWindowsPath(item);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(path.win32.normalize(item.trim()).replace(/[\\/]+$/, ''));
    }
  }
  return result;
}

export async function configureSealseekWindows(options = {}) {
  const fsImpl = options.fsImpl || fs;
  const now = options.now || new Date();
  const environment = options.environment || await discoverSealseekWindows(options);
  let raw;
  let config;
  let metadata;
  try {
    [raw, metadata] = await Promise.all([
      fsImpl.readFile(environment.configPath, 'utf8'),
      fsImpl.stat(environment.configPath),
    ]);
    config = requireObject(JSON.parse(raw), 'sealseek.json');
  } catch (error) {
    throw new Error(`SealSeek 配置不可安全更新：${environment.configPath}；${error.message}`);
  }
  if (config.tools !== undefined) requireObject(config.tools, 'tools');
  if (config.tools?.exec !== undefined) requireObject(config.tools.exec, 'tools.exec');
  const current = config.tools?.exec?.pathPrepend || [];
  const merged = mergePathPrepend(current, environment.desiredPathPrepend);
  const before = JSON.stringify(current);
  const after = JSON.stringify(merged);
  if (before === after) {
    return { changed: false, configPath: environment.configPath, backupPath: null, pathPrepend: merged };
  }

  const next = structuredClone(config);
  next.tools ||= {};
  next.tools.exec ||= {};
  next.tools.exec.pathPrepend = merged;
  const serialized = `${JSON.stringify(next, null, 2)}\n`;
  JSON.parse(serialized);
  const backupPath = `${environment.configPath}.bak-${stamp(now)}`;
  const temporaryPath = `${environment.configPath}.tmp-${process.pid}-${stamp(now)}`;
  const displacedPath = `${environment.configPath}.replacing-${process.pid}-${stamp(now)}`;
  if (await pathExists(backupPath, fsImpl)) throw new Error(`配置备份路径已存在：${backupPath}`);
  await fsImpl.copyFile(environment.configPath, backupPath);
  try {
    await fsImpl.writeFile(temporaryPath, serialized, { flag: 'wx', mode: metadata.mode });
    await fsImpl.rename(environment.configPath, displacedPath);
    try {
      await fsImpl.rename(temporaryPath, environment.configPath);
      await fsImpl.rm(displacedPath, { force: true });
    } catch (error) {
      try { await fsImpl.rename(displacedPath, environment.configPath); } catch {}
      throw error;
    }
  } catch (error) {
    try { await fsImpl.rm(temporaryPath, { force: true }); } catch {}
    throw new Error(`SealSeek 配置写入失败；原文件和备份均已保留：${error.message}`);
  }
  return { changed: true, configPath: environment.configPath, backupPath, pathPrepend: merged };
}

async function ownedTbcliShim(target, fsImpl) {
  try {
    const content = await fsImpl.readFile(target, 'utf8');
    return /@petercjl[\\/]tbcli/i.test(content);
  } catch { return false; }
}

export async function disablePowerShellTbcliShims(environment, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const disabled = [];
  for (const target of [environment.canonicalPs1, environment.legacyPs1]) {
    if (!await ownedTbcliShim(target, fsImpl)) continue;
    const backup = `${target}.disabled-by-tbcli`;
    if (await pathExists(backup, fsImpl)) await fsImpl.rm(target, { force: true });
    else await fsImpl.rename(target, backup);
    disabled.push({ target, backup });
  }
  return disabled;
}

export async function inspectSealseekWindows(options = {}) {
  const fsImpl = options.fsImpl || fs;
  const environment = options.environment || await discoverSealseekWindows(options);
  let config = null;
  let configError = null;
  try { config = requireObject(JSON.parse(await fsImpl.readFile(environment.configPath, 'utf8')), 'sealseek.json'); }
  catch (error) { configError = error.message; }
  const pathPrepend = config?.tools?.exec?.pathPrepend;
  const merged = Array.isArray(pathPrepend) ? mergePathPrepend(pathPrepend, environment.desiredPathPrepend) : [];
  const pathConfigured = Array.isArray(pathPrepend) && JSON.stringify(pathPrepend) === JSON.stringify(merged);
  let installedVersion = null;
  try {
    const packageJson = JSON.parse(await fsImpl.readFile(environment.canonicalPackageJson, 'utf8'));
    installedVersion = String(packageJson.version || '') || null;
  } catch {}
  const checks = {
    runtimeInfo: await pathExists(environment.runtimeInfoPath, fsImpl),
    nodeExecutable: await pathExists(environment.nodePath, fsImpl),
    npmCli: await pathExists(environment.npmCli, fsImpl),
    configValid: !configError,
    pathConfigured,
    canonicalPackage: Boolean(installedVersion),
    canonicalCmd: await pathExists(environment.canonicalCmd, fsImpl),
    powershellShimDisabled: !await pathExists(environment.canonicalPs1, fsImpl),
  };
  return {
    platform: 'windows-sealseek',
    nodeVersion: environment.nodeVersion,
    installedVersion,
    paths: {
      config: environment.configPath,
      runtimeInfo: environment.runtimeInfoPath,
      node: environment.nodePath,
      npmGlobalDir: environment.npmGlobalDir,
      canonicalEntry: environment.canonicalEntry,
      canonicalCmd: environment.canonicalCmd,
    },
    config: { valid: !configError, error: configError, pathPrepend: Array.isArray(pathPrepend) ? pathPrepend : null },
    checks,
    ok: Object.values(checks).every(Boolean),
    restartRequired: false,
  };
}
