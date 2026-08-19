import { chromium } from 'playwright-core';
import fs from 'node:fs';

import {
  DEFAULT_CDP,
  DEFAULT_CHROME_PATH,
  DEFAULT_PROFILE_DIR,
  DEFAULT_SESSION_MODE,
} from './config.mjs';
import { ensureBrowserOpen, isCdpReachable } from './commands/browser.mjs';
import { createVerificationError } from './taobao-guard.mjs';

const LOGIN_COOKIE_NAMES = new Set(['_nk_', 'lgc', 'tracknick', 'sn']);

export async function withBrowserSession(opts = {}, callback) {
  const sessionMode = await resolveSessionMode(opts);
  if (sessionMode === 'cdp') return withCdpSession(opts, callback);
  return withManagedSession(opts, callback);
}

async function withCdpSession(opts, callback) {
  const cdpUrl = opts.cdpUrl || DEFAULT_CDP;
  if (!await isCdpReachable(cdpUrl)) await ensureBrowserOpen({ ...opts, cdpUrl });
  const browser = await chromium.connectOverCDP(cdpUrl);
  try {
    const context = browser.contexts()[0];
    if (!context) throw new Error('没有可用的浏览器上下文');
    await ensureStartPage(context, opts.startUrl || opts.url);
    return await callback({ browser, context, sessionMode: 'cdp' });
  } finally {
    await browser.close();
  }
}

async function withManagedSession(opts, callback) {
  const profileDir = opts.profileDir || DEFAULT_PROFILE_DIR;
  const chromePath = opts.chromePath || DEFAULT_CHROME_PATH;
  if (!chromePath || !fs.existsSync(chromePath)) {
    const detected = chromePath || '未检测到默认路径';
    throw new Error(`找不到 Chrome：${detected}。请先安装 Google Chrome，或用 --chrome-path / TBCLI_CHROME_PATH 指定。`);
  }
  fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });

  let context;
  try {
    context = await chromium.launchPersistentContext(profileDir, {
      executablePath: chromePath,
      headless: false,
      ignoreDefaultArgs: ['--use-mock-keychain', '--password-store=basic'],
      args: [
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-session-crashed-bubble',
      ],
    });
  } catch (error) {
    throw normalizeManagedLaunchError(error, profileDir);
  }

  try {
    await ensureStartPage(context, opts.startUrl || opts.url);
    return await callback({
      browser: context.browser(),
      context,
      sessionMode: 'managed',
    });
  } finally {
    await context.close();
  }
}

export async function withAuthenticatedTaobaoSession(opts, callback) {
  return withBrowserSession({ ...opts, startUrl: 'about:blank', url: '' }, async (session) => {
    await assertTaobaoLoggedIn(session.context);
    return callback(session);
  });
}

export async function resolveSessionMode(opts = {}, {
  cdpReachable = isCdpReachable,
} = {}) {
  const requested = String(opts.sessionMode || DEFAULT_SESSION_MODE || 'auto').trim().toLowerCase();
  if (!['auto', 'managed', 'cdp'].includes(requested)) {
    throw new Error('--session-mode / TBCLI_SESSION_MODE 只能是 auto、managed 或 cdp');
  }
  if (opts.cdpUrl || requested === 'cdp') return 'cdp';
  if (requested === 'managed') return 'managed';
  return await cdpReachable(DEFAULT_CDP) ? 'cdp' : 'managed';
}

export async function ensureStartPage(context, targetUrl = '') {
  const normalized = String(targetUrl || '').trim();
  if (!normalized || normalized === 'about:blank') {
    return context.pages()[0] || await context.newPage();
  }
  const targetHost = new URL(normalized).hostname;
  const matching = context.pages().find((page) => {
    try { return new URL(page.url()).hostname === targetHost; } catch { return false; }
  });
  if (matching) return matching;
  const blank = context.pages().find((page) => page.url() === 'about:blank');
  const page = blank || await context.newPage();
  await page.goto(normalized, { waitUntil: 'domcontentloaded' });
  return page;
}

export function normalizeManagedLaunchError(error, profileDir) {
  const message = String(error?.message || error || '');
  if (/user data directory is already in use|processSingleton|SingletonLock|profile.*in use|existing browser session|现有的浏览器会话/i.test(message)) {
    return new Error(`固定浏览器 Profile 正被另一个 Chrome 占用：${profileDir}。请先关闭使用该 Profile 的 Chrome，再重新执行；tbcli 不会复制或读取浏览器 Cookie。`);
  }
  return error instanceof Error ? error : new Error(message);
}

export function hasTaobaoLoginCookies(cookies) {
  const names = new Set(cookies.map((cookie) => cookie.name));
  return names.has('cookie2') && [...LOGIN_COOKIE_NAMES].some((name) => names.has(name));
}

export async function assertTaobaoLoggedIn(context) {
  const cookies = await context.cookies(['https://www.taobao.com', 'https://www.tmall.com']);
  if (!hasTaobaoLoginCookies(cookies)) {
    throw createVerificationError('未检测到淘宝/天猫登录状态；请先运行 tbcli auth login');
  }
}

export function findTaobaoPage(pages, preferredUrl = '') {
  if (preferredUrl) {
    try {
      const preferredHost = new URL(preferredUrl).hostname;
      const preferred = pages.find((page) => {
        try { return new URL(page.url()).hostname === preferredHost; } catch { return false; }
      });
      if (preferred) return preferred;
    } catch {}
  }
  return pages.find((page) => isTaobaoUrl(page.url())) || null;
}

export function isTaobaoUrl(value) {
  try {
    const hostname = new URL(value).hostname;
    return hostname === 'taobao.com'
      || hostname.endsWith('.taobao.com')
      || hostname === 'tmall.com'
      || hostname.endsWith('.tmall.com');
  } catch {
    return false;
  }
}
