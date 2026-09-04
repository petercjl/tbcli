import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
export const DATABASE_NETWORK_PROVIDERS = Object.freeze(['none', 'zxvpn']);

export function normalizeDatabaseNetworkAccess(value = undefined) {
  const provider = typeof value === 'string' ? value : value?.provider;
  const normalized = String(provider || 'none').trim().toLowerCase();
  if (!DATABASE_NETWORK_PROVIDERS.includes(normalized)) {
    throw new Error(`不支持的数据库网络适配器：${normalized}；可用值：${DATABASE_NETWORK_PROVIDERS.join(', ')}`);
  }
  return { provider: normalized };
}

async function invokeZxvpn(action, options = {}) {
  const command = options.command || process.env.TBCLI_ZXVPN_BIN || 'zxvpn';
  const runner = options.execFileImpl || execFileAsync;
  let stdout;
  try {
    ({ stdout } = await runner(command, [action, '--json'], {
      timeout: Number(options.timeoutMillis || 20000),
      maxBuffer: 1024 * 1024,
      encoding: 'utf8',
    }));
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error('DATABASE_NETWORK_UNAVAILABLE：已配置 zxvpn，但当前 PATH 中找不到 zxvpn 命令');
    }
    throw new Error(`DATABASE_NETWORK_UNAVAILABLE：zxvpn ${action} 执行失败（${error.code || 'UNKNOWN'}）`);
  }
  let result;
  try { result = JSON.parse(String(stdout).trim()); }
  catch { throw new Error(`DATABASE_NETWORK_UNAVAILABLE：zxvpn ${action} 未返回有效 JSON`); }
  if (!result?.ok) {
    throw new Error(`DATABASE_NETWORK_UNAVAILABLE：${result?.code || 'ZXVPN_FAILED'} ${result?.message || 'zxvpn 未能准备数据库网络'}`);
  }
  return { provider: 'zxvpn', ...result };
}

export async function inspectDatabaseNetworkAccess(config, options = {}) {
  const access = normalizeDatabaseNetworkAccess(config?.networkAccess);
  if (access.provider === 'none') return { provider: 'none', ok: true, state: 'not-configured' };
  return invokeZxvpn('status', options);
}

export async function ensureDatabaseNetworkAccess(config, options = {}) {
  const access = normalizeDatabaseNetworkAccess(config?.networkAccess);
  if (access.provider === 'none') return { provider: 'none', ok: true, state: 'not-configured', changed: false };
  return invokeZxvpn('ensure', options);
}
