import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

export const BUYER_COMMANDS = Object.freeze(['item media', 'item detail', 'search products', 'shop products']);
const HELPERS = new Set(['browser', 'auth', 'dev', 'doctor']);
function fail(code, message) { return Object.assign(new Error(message), {code}); }
export function forBrowserRole(opts = {}, role) {
  if (opts.browserRole && opts.browserRole !== role) throw fail('BROWSER_ROLE_CONFLICT', `此取数入口需要 ${role} 浏览器；请使用对应账号的独立会话。`);
  const selected = {...opts, browserRole: role};
  resolveBrowserTarget(selected);
  return selected;
}
export function resolveBrowserTarget(opts = {}, {env = process.env, home = os.homedir()} = {}) {
  const command = (opts._ || []).slice(0, 2).join(' ');
  const required = BUYER_COMMANDS.includes(command) ? 'buyer' : command && !HELPERS.has(opts._[0]) ? 'merchant' : null;
  const browserRole = opts.browserRole || required || 'merchant';
  if (!['buyer', 'merchant'].includes(browserRole)) throw fail('INVALID_BROWSER_ROLE', '--browser-role 只能是 buyer 或 merchant');
  if (required && required !== browserRole) throw fail('BROWSER_ROLE_CONFLICT', `${command} 需要 ${required} 浏览器。`);
  const buyer = browserRole === 'buyer';
  const prefix = buyer ? 'TBCLI_BUYER_' : 'TBCLI_';
  const defaultPort = Number(env[`${prefix}REMOTE_DEBUGGING_PORT`] || (buyer ? 9224 : 9223));
  const defaultProfile = env[`${prefix}CHROME_PROFILE`] || path.join(home, buyer ? '.taobao-user-chrome-profile' : '.dianshang-chrome-profile');
  const cdpUrl = opts.cdpUrl || (opts.port ? `http://127.0.0.1:${opts.port}` : env[`${prefix}CDP_URL`] || `http://127.0.0.1:${defaultPort}`);
  let url; try { url = new URL(cdpUrl); } catch { throw fail('INVALID_CDP_URL', 'CDP URL 无效。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw fail('INVALID_CDP_URL', 'CDP URL 必须是无内嵌凭据的 HTTP(S) 地址。');
  const port = Number(opts.port || url.port || (url.protocol === 'https:' ? 443 : 80));
  if (!Number.isInteger(port) || port < 1 || port > 65535 || (opts.port && port !== Number(url.port || (url.protocol === 'https:' ? 443 : 80)))) throw fail('INVALID_BROWSER_PORT', '调试端口无效或与 --cdp-url 不一致。');
  const profileDir = path.resolve(opts.profileDir || defaultProfile);
  const opposite = buyer ? 'TBCLI_' : 'TBCLI_BUYER_';
  const otherPort = Number(env[`${opposite}REMOTE_DEBUGGING_PORT`] || (buyer ? 9223 : 9224));
  const otherProfile = path.resolve(env[`${opposite}CHROME_PROFILE`] || path.join(home, buyer ? '.dianshang-chrome-profile' : '.taobao-user-chrome-profile'));
  const otherCdp = env[`${opposite}CDP_URL`] || `http://127.0.0.1:${otherPort}`;
  const localHosts = ['127.0.0.1', 'localhost', '[::1]'];
  const local = localHosts.includes(url.hostname);
  let otherUrl; try { otherUrl = new URL(otherCdp); } catch {}
  const otherEndpointPort = otherUrl && localHosts.includes(otherUrl.hostname) ? Number(otherUrl.port || (otherUrl.protocol === 'https:' ? 443 : 80)) : otherPort;
  const canonical = p => { try { return fs.realpathSync(p); } catch { return p; } };
  if (canonical(profileDir) === canonical(otherProfile) || cdpUrl.replace(/\/$/, '') === otherCdp.replace(/\/$/, '') || (local && [otherPort, otherEndpointPort, buyer ? 9223 : 9224].includes(port))) throw fail('BROWSER_TARGET_CONFLICT', `${browserRole} 浏览器不能使用另一角色的端口或 Profile；请保留独立登录状态。`);
  return {browserRole, cdpUrl: cdpUrl.replace(/\/$/, ''), port, profileDir, theme: buyer ? 'orange' : 'blue', label: buyer ? '淘宝普通用户' : '电商商家', local};
}
