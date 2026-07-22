import { chromium } from 'playwright-core';

import { DEFAULT_CDP } from './config.mjs';
import { ensureBrowserOpen } from './commands/browser.mjs';
import { createVerificationError } from './taobao-guard.mjs';

const LOGIN_COOKIE_NAMES = new Set(['_nk_', 'lgc', 'tracknick', 'sn']);

export async function withBrowserSession(opts, callback) {
  await ensureBrowserOpen(opts);
  const browser = await chromium.connectOverCDP(opts.cdpUrl || DEFAULT_CDP);
  try {
    const context = browser.contexts()[0];
    if (!context) throw new Error('没有可用的浏览器上下文');
    return await callback({ browser, context });
  } finally {
    await browser.close();
  }
}

export function hasTaobaoLoginCookies(cookies) {
  const names = new Set(cookies.map((cookie) => cookie.name));
  return names.has('cookie2') && [...LOGIN_COOKIE_NAMES].some((name) => names.has(name));
}

export async function assertTaobaoLoggedIn(context) {
  const cookies = await context.cookies(['https://www.taobao.com', 'https://www.tmall.com']);
  if (!hasTaobaoLoginCookies(cookies)) {
    throw createVerificationError('未检测到淘宝/天猫登录状态');
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
