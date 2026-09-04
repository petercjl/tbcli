import path from 'node:path';

import { resolveApiDelayRange, waitBeforeTaobaoApiRequest } from '../api-policy.mjs';
import { withAuthenticatedTaobaoSession } from '../browser-session.mjs';
import { assertPageNotVerifying } from '../taobao-guard.mjs';
import {
  SYCM_MARKET_RANK_API_PATH,
  assertMarketRankOutputsAbsent,
  buildMarketRankPageUrl,
  fetchMarketRankWeek,
  parseMarketRankCategoryUrl,
  resolveFourMarketRankWeeks,
  writeMarketRankWorkbookNew,
} from '../sycm-market-rank.mjs';

export async function runSycmMarketRank(opts = {}) {
  if (!opts.categoryUrl) throw new Error('缺少 --category-url；请提供生意参谋商品排行类目链接');
  if (!opts.lastWeek) throw new Error('缺少 --last-week；请提供最后一周中的任意日期');
  const category = parseMarketRankCategoryUrl(opts.categoryUrl);
  const weeks = resolveFourMarketRankWeeks(opts.lastWeek);
  const delayRange = resolveApiDelayRange(opts);
  const firstWeek = weeks[0];
  const finalWeek = weeks.at(-1);
  const outDir = path.resolve(String(opts.outDir || `sycm-market-rank-${category.cateId}-${firstWeek.startDate}-to-${finalWeek.endDate}`));
  const targets = weeks.map((week) => path.join(
    outDir,
    `sycm_market_rank_${category.cateId}_${week.startDate}_to_${week.endDate}.xlsx`,
  ));
  await assertMarketRankOutputsAbsent(targets);

  const outputs = [];
  try {
    await withAuthenticatedTaobaoSession(opts, async ({ context, sessionMode }) => {
      const page = await context.newPage();
      try {
        const capturedUrl = await captureMarketRankRequest(page, buildMarketRankPageUrl(category, finalWeek), {
          category,
          delayRange,
        });
        for (let index = 0; index < weeks.length; index += 1) {
          const week = weeks[index];
          process.stderr.write(`正在获取第 ${index + 1}/4 周：${week.startDate} 至 ${week.endDate}\n`);
          const weekData = await fetchMarketRankWeek(page, capturedUrl, { week, delayRange });
          const written = await writeMarketRankWorkbookNew(targets[index], weekData);
          outputs.push({
            period: { startDate: week.startDate, endDate: week.endDate },
            output: written.output,
            bytes: written.bytes,
            mode: written.mode,
            sheets: written.workbook.sheets,
          });
          process.stderr.write(`已生成：${written.output}\n`);
        }
        const result = {
          category: { parentCateId: category.parentCateId, cateId: category.cateId },
          finalWeek: { startDate: finalWeek.startDate, endDate: finalWeek.endDate },
          sessionMode,
          delayPolicyMs: { min: delayRange.minDelayMs, max: delayRange.maxDelayMs },
          outputs,
        };
        if (opts.json) console.log(JSON.stringify(result, null, 2));
        else {
          console.log(`类目：${category.cateId}`);
          console.log(`四周：${firstWeek.startDate} 至 ${finalWeek.endDate}`);
          for (const output of outputs) console.log(`output: ${output.output}`);
        }
      } finally {
        await page.close().catch(() => {});
      }
    });
  } catch (error) {
    if (outputs.length) {
      error.completedOutputs = outputs.map((entry) => entry.output);
      error.message += `；已完成的文件已保留：${error.completedOutputs.join('、')}`;
    }
    throw error;
  }
}

export async function captureMarketRankRequest(page, pageUrl, { category, delayRange }, {
  timeoutMs = 30000,
  waitBeforeAction = waitBeforeTaobaoApiRequest,
  assertPageSafe = assertPageNotVerifying,
} = {}) {
  await waitBeforeAction(page, delayRange);
  let capturedPromise = waitForMarketRankRequest(page, timeoutMs);
  await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  await assertPageSafe(page);
  let request = await capturedPromise;
  if (!request) {
    await waitBeforeAction(page, delayRange);
    capturedPromise = waitForMarketRankRequest(page, timeoutMs);
    const clicked = await clickAnotherPriceBand(page);
    if (!clicked) throw new Error('商品排行页没有发出排行请求，也找不到可切换的价格带');
    request = await capturedPromise;
  }
  if (!request) throw new Error('等待生意参谋商品排行请求超时');
  await assertPageSafe(page);
  const url = new URL(request.url());
  if (url.searchParams.get('cateId') !== category.cateId) {
    throw new Error(`页面实际排行类目与入参不一致：${url.searchParams.get('cateId') || '空'} / ${category.cateId}`);
  }
  return url.toString();
}

function waitForMarketRankRequest(page, timeoutMs) {
  return page.waitForRequest((request) => {
    try {
      const url = new URL(request.url());
      return url.hostname === 'sycm.taobao.com' && url.pathname === SYCM_MARKET_RANK_API_PATH;
    } catch {
      return false;
    }
  }, { timeout: timeoutMs }).catch((error) => {
    if (/Timeout/i.test(String(error?.message || error))) return null;
    throw error;
  });
}

async function clickAnotherPriceBand(page) {
  const labels = ['50.0-135.0', '135.0-255.0', '255.0-455.0', '455.0-660.0', '660.0以上', '0-50.0'];
  for (const label of labels) {
    const locator = page.getByText(label, { exact: true }).first();
    if (await locator.count()) {
      await locator.click();
      return true;
    }
  }
  return false;
}
