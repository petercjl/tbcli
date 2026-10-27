import fs from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import {promisify} from 'node:util';
import {chromium} from 'playwright-core';
import {resolveBrowserTarget} from '../browser-target.mjs';
const exec = promisify(execFile);
function fail(code, message) { return Object.assign(new Error(message), {code}); }
import {
  DEFAULT_CDP,
  DEFAULT_CHROME_PATH,
  DEFAULT_DEBUGGING_PORT,
  DEFAULT_PROFILE_DIR,
  DEFAULT_START_URL,
} from '../config.mjs';

export async function inspectBrowserStatus(opts = {}, {
  reachable = isCdpReachable, verifyProfile = verifyLocalProfile,
} = {}) {
  const target = resolveBrowserTarget(opts);
  const connected = await reachable(target.cdpUrl);
  let error;
  if (target.local) {
    try { await verifyProfile(target, {allowStopped: !connected}); }
    catch (cause) { error = {code: cause.code || 'BROWSER_PROFILE_CONFLICT', message: cause.message}; }
  }
  return {ok: connected && !error, ...target,
    state: error ? 'conflict' : connected ? 'ready' : 'stopped',
    sessionMode: 'cdp', profileVerified: target.local ? connected && !error : null,
    ...(error ? {error} : {}),
  };
}
export async function runBrowserStatus(opts = {}) {
  const result = await inspectBrowserStatus(opts);
  if (opts.json) console.log(JSON.stringify(result));
  else console.log(`${result.label}浏览器：${result.state} (${result.cdpUrl})${result.error ? '\n' + result.error.message : ''}`);
  return result;
}

export async function runBrowserOpen(opts = {}) {
  const target = resolveBrowserTarget(opts);
  const started = await ensureBrowserOpen({...opts, ...target});
  if (!started && opts.url) await openCdpPage(target.cdpUrl, opts.url);
  const result = {ok: true, ...target, started};
  if (opts.json) console.log(JSON.stringify(result));
  else { console.log(`${target.label}浏览器已就绪: ${target.cdpUrl}`); console.log(`profile: ${target.profileDir}`); }
  return result;
}

export async function runBrowserTheme(opts = {}) {
  const target = resolveBrowserTarget(opts);
  await ensureBrowserOpen({...opts, ...target});
  const browser = await chromium.connectOverCDP(target.cdpUrl);
  let page;
  try {
    page = await browser.contexts()[0].newPage();
    await page.goto('chrome://settings/manageProfile', {waitUntil:'domcontentloaded', timeout:10000});
    // Use Chrome's own visible profile settings; never edit live Preferences files.
    const color = page.locator('cr-theme-color-picker').getByRole('radio', {name: target.theme === 'blue' ? /^(蓝色|Blue)$/i : /^(橙色|Orange)$/i});
    await color.click({timeout:10000});
    await page.waitForFunction(() => {
      const visit = root => [...root.querySelectorAll('*')].flatMap(e => [e, ...(e.shadowRoot ? visit(e.shadowRoot) : [])]);
      return visit(document).some(e => e.matches?.('cr-theme-color.chrome-color[aria-checked="true"]'));
    }, null, {timeout:5000});
    if (await color.getAttribute('aria-checked') !== 'true') throw fail('BROWSER_THEME_NOT_APPLIED', 'Chrome 未确认主题颜色。');
    const result = {ok:true, browserRole:target.browserRole, cdpUrl:target.cdpUrl, profileDir:target.profileDir, theme:target.theme, colorLabel:await color.getAttribute('aria-label')};
    console.log(JSON.stringify(result));
    return result;
  } finally { await page?.close(); await browser.close(); }
}

export async function openCdpPage(cdpUrl, url) {
  const endpoint = `${cdpUrl.replace(/\/$/, '')}/json/new?${encodeURIComponent(url)}`;
  const response = await fetch(endpoint, { method: 'PUT' });
  if (!response.ok) {
    throw new Error(`电商浏览器已连接，但打开页面失败：HTTP ${response.status}`);
  }
  return response.json();
}

export async function ensureBrowserOpen(opts = {}) {
  const target = resolveBrowserTarget(opts);
  const {cdpUrl, port, profileDir} = target;
  if (await isCdpReachable(cdpUrl)) {
    if (target.local) await verifyLocalProfile(target);
    return false;
  }
  if (!target.local) throw fail('CDP_UNREACHABLE', '远程 CDP 未连接；请检查指定浏览器。');
  await verifyLocalProfile(target, {allowStopped:true});
  const chromePath = opts.chromePath || DEFAULT_CHROME_PATH;
  const startUrl = opts.startUrl || opts.url || DEFAULT_START_URL;

  if (!chromePath || !fs.existsSync(chromePath)) {
    const detected = chromePath || '未检测到默认路径';
    throw new Error(`找不到 Chrome：${detected}。请先安装 Google Chrome，或用 --chrome-path / TBCLI_CHROME_PATH 指定。`);
  }
  fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });

  const child = spawn(chromePath, [
    '--remote-debugging-address=127.0.0.1',
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
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref();

  await waitForCdp(cdpUrl);
  await verifyLocalProfile(target);
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
    const response = await fetch(`${cdpUrl.replace(/\/$/, '')}/json/version`, {signal:AbortSignal.timeout(1500), redirect:'error'});
    const value = await response.json();
    return response.ok && Boolean(value.Browser?.includes('Chrome/') && value.webSocketDebuggerUrl);
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function matchesBrowserCommand(command, {port, profileDir}) {
  const arg = value => command.includes(` ${value} `) || command.endsWith(` ${value}`) || command.includes(` "${value}" `) || command.endsWith(` "${value}"`);
  return /(?:Google Chrome|chrome(?:\.exe)?)/i.test(command)
    && arg(`--remote-debugging-port=${port}`)
    && (arg(`--user-data-dir=${profileDir}`) || command.includes(`--user-data-dir="${profileDir}"`))
    && !/(?:^|\s)--no-sandbox(?:\s|$)/.test(command);
}
export async function verifyLocalProfile(target, {allowStopped=false} = {}) {
  let output;
  if (process.platform === 'win32') {
    output = (await exec('powershell.exe', ['-NoProfile','-NonInteractive','-Command', "Get-CimInstance Win32_Process -Filter \"name='chrome.exe'\" | ForEach-Object { $_.CommandLine }"], {timeout:20000,maxBuffer:8*1024*1024})).stdout;
  } else {
    output = (await exec('ps', ['-ax','-o','command='], {timeout:5000,maxBuffer:8*1024*1024})).stdout;
  }
  const commands = output.split(/\r?\n/).map(s=>s.trim()).filter(s=>/(?:Google Chrome|chrome(?:\.exe)?)/i.test(s));
  if (commands.some(command=>matchesBrowserCommand(command,target))) return;
  const relevant = commands.some(command=>command.includes(`--remote-debugging-port=${target.port}`) || command.includes(`--user-data-dir=${target.profileDir}`));
  if (allowStopped && !relevant) return;
  throw fail('BROWSER_PROFILE_CONFLICT', '调试端口与指定角色的 Chrome Profile 不匹配，或 Profile 已被其他会话占用；请检查两个独立浏览器。');
}
