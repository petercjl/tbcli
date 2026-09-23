import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { TBCLI_VERSION } from './version.mjs';

export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const DEFAULT_UPDATE_CACHE = path.join(os.homedir(), '.cache', 'tbcli', 'update-check.json');
const LATEST_URL = 'https://registry.npmjs.org/@petercjl%2Ftbcli/latest';
const PACKAGE_ROOT = fileURLToPath(new URL('../..', import.meta.url));

export function compareVersions(left, right) {
  const parse = (value) => String(value || '').split('-')[0].split('.').map((part) => Number(part) || 0);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] || 0) > (b[index] || 0)) return 1;
    if ((a[index] || 0) < (b[index] || 0)) return -1;
  }
  return 0;
}

async function readCache(cacheFile) {
  try { return JSON.parse(await fs.readFile(cacheFile, 'utf8')); } catch { return {}; }
}

async function writeCache(cacheFile, value) {
  await fs.mkdir(path.dirname(cacheFile), { recursive: true });
  const temporary = `${cacheFile}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, cacheFile);
  if (process.platform !== 'win32') await fs.chmod(cacheFile, 0o600);
}

export async function checkForUpdate({
  currentVersion = TBCLI_VERSION,
  cacheFile = DEFAULT_UPDATE_CACHE,
  now = Date.now(),
  fetchImpl = globalThis.fetch,
  force = false,
} = {}) {
  const cache = await readCache(cacheFile);
  let latestVersion = cache.latestVersion || '';
  const cacheFresh = Boolean(cache.checkedAt)
    && Number(cache.checkedAt) + UPDATE_CHECK_INTERVAL_MS > now;
  if (force || !cacheFresh) {
    const response = await fetchImpl(LATEST_URL, { signal: AbortSignal.timeout(1800) });
    if (!response.ok) throw new Error(`npm 版本检查失败：HTTP ${response.status}`);
    const body = await response.json();
    latestVersion = String(body.version || '');
    if (!latestVersion) throw new Error('npm 版本检查未返回版本号');
    cache.checkedAt = now;
    cache.latestVersion = latestVersion;
    await writeCache(cacheFile, cache);
  }
  return {
    currentVersion,
    latestVersion,
    updateAvailable: Boolean(latestVersion) && compareVersions(latestVersion, currentVersion) > 0,
    cacheFile,
    cache,
  };
}

export function isPackagedNpmInstall(packageRoot = PACKAGE_ROOT) {
  const normalized = path.resolve(packageRoot).split(path.sep).map((part) => part.toLowerCase());
  const nodeModules = normalized.lastIndexOf('node_modules');
  return nodeModules >= 0 && normalized[nodeModules + 1] === '@petercjl' && normalized[nodeModules + 2] === 'tbcli';
}

export async function maybeAutoUpdate(args = {}, options = {}) {
  const environment = options.environment || process.env;
  if (environment.TBCLI_UPDATE_CHECK === '0' || environment.TBCLI_AUTO_UPDATE_REEXEC === '1'
    || args._?.[0] === 'update') return { checked: false, updated: false, reason: 'disabled-or-update-command' };
  const packaged = options.isPackagedInstall ? options.isPackagedInstall() : isPackagedNpmInstall(options.packageRoot);
  if (!packaged) return { checked: false, updated: false, reason: 'source-checkout' };
  try {
    const result = await checkForUpdate(options);
    if (!result.updateAvailable) return { checked: true, updated: false, ...result };
    const updater = options.performUpdate || (await import('./commands/update.mjs')).performAutomaticUpdate;
    const update = await updater(options.updateDependencies || {});
    return { checked: true, updated: true, latestVersion: result.latestVersion, update };
  } catch (error) {
    return { checked: true, updated: false, warning: String(error.message || error) };
  }
}

export async function relaunchWithUpdatedCli(argv, options = {}) {
  const node = options.node || process.execPath;
  const entry = options.entry || process.argv[1];
  const spawnImpl = options.spawnImpl || spawn;
  return new Promise((resolve, reject) => {
    const child = spawnImpl(node, [entry, ...argv], {
      stdio: 'inherit', env: { ...process.env, TBCLI_AUTO_UPDATE_REEXEC: '1' },
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code: code ?? 1, signal: signal || null }));
  });
}
