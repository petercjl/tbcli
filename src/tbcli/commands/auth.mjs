import {
  DEFAULT_CHROME_PATH,
  DEFAULT_PROFILE_DIR,
} from '../config.mjs';
import {
  ensureStartPage,
  hasTaobaoLoginCookies,
  withBrowserSession,
} from '../browser-session.mjs';

const TAOBAO_LOGIN_URL = 'https://login.taobao.com/';

export async function runAuthLogin(opts = {}) {
  const timeoutMs = boundedInteger(opts.timeoutMs, 300000, 10000, 900000, '--timeout-ms');
  const result = await withBrowserSession({ ...opts, startUrl: 'about:blank', url: '' }, async ({ context, sessionMode }) => {
    if (await isLoggedIn(context)) return authResult(true, sessionMode, opts);

    await ensureStartPage(context, TAOBAO_LOGIN_URL);
    process.stderr.write('请在打开的 Chrome 中完成淘宝/天猫登录；tbcli 正在等待登录成功…\n');
    if (await waitForTaobaoLogin(context, { timeoutMs })) return authResult(true, sessionMode, opts);
    throw new Error(`等待登录超时（${timeoutMs}ms）。请重新运行 tbcli auth login；不会保存或输出 Cookie。`);
  });
  printAuthResult(result, opts);
  return result;
}

export async function runAuthStatus(opts = {}) {
  const result = await withBrowserSession({ ...opts, startUrl: 'about:blank', url: '' }, async ({ context, sessionMode }) => (
    authResult(await isLoggedIn(context), sessionMode, opts)
  ));
  printAuthResult(result, opts);
  if (!result.taobaoLoggedIn) process.exitCode = 1;
  return result;
}

async function isLoggedIn(context) {
  const cookies = await context.cookies(['https://www.taobao.com', 'https://www.tmall.com']);
  return hasTaobaoLoginCookies(cookies);
}

export async function waitForTaobaoLogin(context, {
  timeoutMs = 300000,
  pollIntervalMs = 1000,
  now = Date.now,
  sleepImpl = sleep,
} = {}) {
  const deadline = now() + timeoutMs;
  while (true) {
    if (await isLoggedIn(context)) return true;
    const remaining = deadline - now();
    if (remaining <= 0) return false;
    await sleepImpl(Math.min(pollIntervalMs, remaining));
  }
}

function authResult(taobaoLoggedIn, sessionMode, opts) {
  return {
    taobaoLoggedIn,
    sessionMode,
    profileDir: opts.profileDir || DEFAULT_PROFILE_DIR,
    chromePath: opts.chromePath || DEFAULT_CHROME_PATH,
    checkedAt: new Date().toISOString(),
  };
}

function printAuthResult(result, opts) {
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`淘宝登录状态：${result.taobaoLoggedIn ? '已登录' : '未登录'}`);
  console.log(`会话模式：${result.sessionMode}`);
  console.log(`profile: ${result.profileDir}`);
  if (!result.taobaoLoggedIn) console.log('请运行：tbcli auth login');
}

function boundedInteger(value, fallback, min, max, option) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${option} 必须是 ${min}-${max} 的整数`);
  }
  return parsed;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
