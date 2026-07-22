import { assertTaobaoLoggedIn, findTaobaoPage, isTaobaoUrl, withBrowserSession } from '../browser-session.mjs';
import { assertPageNotVerifying } from '../taobao-guard.mjs';

export async function runDevPages(opts = {}) {
  await withBrowserSession(opts, async ({ context }) => {
    const taobaoPages = context.pages().filter((page) => isTaobaoUrl(page.url()));
    const pages = await Promise.all(taobaoPages.map(async (page) => ({
      title: await page.title().catch(() => ''),
      url: page.url(),
    })));
    if (opts.json) console.log(JSON.stringify(pages, null, 2));
    else for (const page of pages) console.log(`taobao\t${page.title}\t${page.url}`);
  });
}

export async function runDevInspect(opts = {}) {
  await withBrowserSession(opts, async ({ context }) => {
    await assertTaobaoLoggedIn(context);
    const page = findTaobaoPage(context.pages(), opts.url);
    if (!page) throw new Error('没有找到淘宝/天猫页面');
    await assertPageNotVerifying(page);
    const result = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      hasMtop: Boolean(window.lib?.mtop?.request),
      gConfigKeys: Object.keys(window.g_config || {}).sort(),
      shopId: String(window.g_config?.shopId || window.g_config?.seller?.shopId || ''),
      sellerId: String(window.g_config?.sellerId || window.g_config?.seller?.sellerId || ''),
      shopName: String(
        window.g_config?.seller?.shopName
        || document.querySelector('.slogo-shopname strong, .shop-name, .header-extra .slogo')?.textContent
        || '',
      ).replace(/\s+/g, ' ').trim(),
    }));
    console.log(JSON.stringify(result, null, 2));
  });
}

export async function runDevCapture(opts = {}) {
  const durationMs = boundedInteger(opts.durationMs, 15000, 1000, 120000, '--duration-ms');
  await withBrowserSession(opts, async ({ context }) => {
    await assertTaobaoLoggedIn(context);
    const page = findTaobaoPage(context.pages(), opts.url);
    if (!page) throw new Error('没有找到淘宝/天猫页面');
    await assertPageNotVerifying(page);
    const records = [];
    const onResponse = (response) => {
      if (!isTaobaoUrl(response.url())) return;
      records.push({
        method: response.request().method(),
        resourceType: response.request().resourceType(),
        status: response.status(),
        contentType: response.headers()['content-type'] || '',
        url: sanitizeCapturedUrl(response.url()),
      });
    };
    page.on('response', onResponse);
    try {
      process.stderr.write(`正在捕获 ${durationMs}ms；可在页面中执行目标操作...\n`);
      await sleep(durationMs);
      await assertPageNotVerifying(page);
    } finally {
      page.off('response', onResponse);
    }
    console.log(JSON.stringify({ page: page.url(), durationMs, requests: records }, null, 2));
  });
}

export function sanitizeCapturedUrl(value) {
  const url = new URL(value);
  for (const key of [...url.searchParams.keys()]) {
    if (/token|sign|cookie|session|sid|uid|user|nick|phone|mobile/i.test(key)) {
      url.searchParams.set(key, '[redacted]');
    }
  }
  return url.toString();
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
