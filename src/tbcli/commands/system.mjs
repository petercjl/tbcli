import fs from 'node:fs';

import { withBrowserSession, assertTaobaoLoggedIn } from '../browser-session.mjs';
import { DEFAULT_CDP, DEFAULT_CHROME_PATH, DEFAULT_PROFILE_DIR } from '../config.mjs';

const CAPABILITIES = [
  { command: 'browser open', maturity: 'stable', description: '打开统一电商浏览器' },
  { command: 'logistics get', maturity: 'stable', description: '查询淘宝订单物流详情' },
  { command: 'shop products', maturity: 'stable', description: '导出淘宝/天猫店铺商品列表' },
  { command: 'doctor', maturity: 'stable', description: '检查 Chrome、CDP 和淘宝登录状态' },
  { command: 'dev pages', maturity: 'development', description: '列出当前可用页面' },
  { command: 'dev inspect', maturity: 'development', description: '检查店铺页面能力与安全识别字段' },
  { command: 'dev capture', maturity: 'development', description: '限时捕获淘宝/天猫 API 请求元数据' },
];

export function runCapabilities(opts = {}) {
  if (opts.json) console.log(JSON.stringify(CAPABILITIES, null, 2));
  else for (const entry of CAPABILITIES) console.log(`${entry.maturity}\t${entry.command}\t${entry.description}`);
}

export async function runDoctor(opts = {}) {
  const result = {
    node: process.version,
    platform: process.platform,
    chromePath: DEFAULT_CHROME_PATH,
    chromeExists: Boolean(DEFAULT_CHROME_PATH && fs.existsSync(DEFAULT_CHROME_PATH)),
    profileDir: DEFAULT_PROFILE_DIR,
    cdpUrl: opts.cdpUrl || DEFAULT_CDP,
    cdpReady: false,
    taobaoLoggedIn: false,
    pages: 0,
  };
  await withBrowserSession(opts, async ({ context }) => {
    result.cdpReady = true;
    result.pages = context.pages().length;
    try {
      await assertTaobaoLoggedIn(context);
      result.taobaoLoggedIn = true;
    } catch {}
  });
  if (opts.json) console.log(JSON.stringify(result, null, 2));
  else for (const [key, value] of Object.entries(result)) console.log(`${key}: ${value}`);
  if (!result.chromeExists || !result.cdpReady || !result.taobaoLoggedIn) process.exitCode = 1;
}
