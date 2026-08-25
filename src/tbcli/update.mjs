import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { TBCLI_VERSION } from './version.mjs';

export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const UPDATE_NOTICE_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_UPDATE_CACHE = path.join(os.homedir(), '.cache', 'tbcli', 'update-check.json');
const LATEST_URL = 'https://registry.npmjs.org/@petercjl%2Ftbcli/latest';

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

export async function maybePrintUpdateNotice(args = {}, options = {}) {
  if (process.env.TBCLI_UPDATE_CHECK === '0' || args._?.[0] === 'update') return;
  try {
    const result = await checkForUpdate(options);
    if (!result.updateAvailable) return;
    const now = options.now || Date.now();
    const alreadyNotified = result.cache.notifiedVersion === result.latestVersion
      && Number(result.cache.notifiedAt || 0) + UPDATE_NOTICE_INTERVAL_MS > now;
    if (alreadyNotified) return;
    console.error(`notice: tbcli ${result.latestVersion} 已发布（当前 ${result.currentVersion}）。更新时请同时同步 CLI 与 Skill：tbcli update --agent <当前Agent>`);
    await writeCache(result.cacheFile, {
      ...result.cache,
      notifiedAt: now,
      notifiedVersion: result.latestVersion,
    });
  } catch {
    // Update reminders must never block business commands when npm or the network is unavailable.
  }
}
