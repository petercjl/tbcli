import fs from 'node:fs';
import { spawn } from 'node:child_process';
import {
  DEFAULT_CDP,
  DEFAULT_CHROME_PATH,
  DEFAULT_DEBUGGING_PORT,
  DEFAULT_PROFILE_DIR,
  DEFAULT_START_URL,
} from '../config.mjs';

export async function runBrowserOpen(opts = {}) {
  const cdpUrl = opts.cdpUrl || DEFAULT_CDP;
  const port = Number(opts.port || new URL(cdpUrl).port || DEFAULT_DEBUGGING_PORT);
  const profileDir = opts.profileDir || DEFAULT_PROFILE_DIR;
  const chromePath = opts.chromePath || DEFAULT_CHROME_PATH;
  const startUrl = opts.url || DEFAULT_START_URL;

  await ensureBrowserOpen({ cdpUrl, port, profileDir, chromePath, startUrl });
  console.log(`电商浏览器已就绪: ${cdpUrl}`);
  console.log(`profile: ${profileDir}`);
}

export async function ensureBrowserOpen(opts = {}) {
  const cdpUrl = opts.cdpUrl || DEFAULT_CDP;
  if (await isCdpReachable(cdpUrl)) return false;

  const port = Number(opts.port || new URL(cdpUrl).port || DEFAULT_DEBUGGING_PORT);
  const profileDir = opts.profileDir || DEFAULT_PROFILE_DIR;
  const chromePath = opts.chromePath || DEFAULT_CHROME_PATH;
  const startUrl = opts.startUrl || opts.url || DEFAULT_START_URL;

  if (!chromePath || !fs.existsSync(chromePath)) {
    const detected = chromePath || '未检测到默认路径';
    throw new Error(`找不到 Chrome：${detected}。请先安装 Google Chrome，或用 --chrome-path / TBCLI_CHROME_PATH 指定。`);
  }
  fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });

  const child = spawn(chromePath, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    startUrl,
  ], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();

  await waitForCdp(cdpUrl);
  return true;
}

async function waitForCdp(cdpUrl) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await isCdpReachable(cdpUrl)) return;
    await sleep(300);
  }
  throw new Error(`电商浏览器已启动但 CDP 未就绪：${cdpUrl}`);
}

export async function isCdpReachable(cdpUrl) {
  try {
    const response = await fetch(`${cdpUrl.replace(/\/$/, '')}/json/version`);
    return response.ok;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
