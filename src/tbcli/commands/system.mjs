import fs from 'node:fs';

import { withBrowserSession, assertTaobaoLoggedIn } from '../browser-session.mjs';
import { DEFAULT_CHROME_PATH, DEFAULT_PROFILE_DIR } from '../config.mjs';
import { businessCapabilities, technicalCapabilities } from '../command-registry.mjs';

export function runCapabilities(opts = {}) {
  const capabilities = businessCapabilities();
  const result = {
    tool: 'tbcli',
    audience: 'ecommerce-operator',
    usageHint: '用户可直接按 examplePrompt 的句式向 Agent 提出需求；Agent 应据此调用 commandTemplate。',
    capabilities,
  };
  if (opts.all) result.technicalCapabilities = technicalCapabilities();
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log('tbcli 当前可以帮你完成：');
  for (const [index, entry] of capabilities.entries()) {
    console.log(`\n${index + 1}. ${entry.name}`);
    console.log(`   ${entry.description}`);
    console.log(`   你可以说：“${entry.examplePrompt}”`);
    console.log(`   需要提供：${entry.requiredInputs.join('、')}`);
    console.log(`   交付结果：${entry.delivery}`);
  }
  console.log('\n不知道怎么开始？可以直接问 Agent：“这个 tbcli 有哪些能力？”');

  if (opts.all) {
    console.log('\n内部与开发工具：');
    for (const entry of result.technicalCapabilities) {
      console.log(`- ${entry.command}：${entry.description}（${entry.maturity}）`);
    }
  }
}

export async function runDoctor(opts = {}) {
  const result = {
    node: process.version,
    platform: process.platform,
    chromePath: DEFAULT_CHROME_PATH,
    chromeExists: Boolean(DEFAULT_CHROME_PATH && fs.existsSync(DEFAULT_CHROME_PATH)),
    profileDir: DEFAULT_PROFILE_DIR,
    sessionMode: '',
    browserReady: false,
    taobaoLoggedIn: false,
    pages: 0,
  };
  await withBrowserSession({ ...opts, startUrl: 'about:blank', url: '' }, async ({ context, sessionMode }) => {
    result.sessionMode = sessionMode;
    result.browserReady = true;
    result.pages = context.pages().length;
    try {
      await assertTaobaoLoggedIn(context);
      result.taobaoLoggedIn = true;
    } catch {}
  });
  if (opts.json) console.log(JSON.stringify(result, null, 2));
  else for (const [key, value] of Object.entries(result)) console.log(`${key}: ${value}`);
  if (!result.chromeExists || !result.browserReady || !result.taobaoLoggedIn) process.exitCode = 1;
}
