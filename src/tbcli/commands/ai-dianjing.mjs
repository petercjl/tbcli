import fs from 'node:fs';
import path from 'node:path';

import { resolveApiDelayRange, waitBeforeTaobaoApiRequest } from '../api-policy.mjs';
import { assertPageNotVerifying } from '../taobao-guard.mjs';
import { withAuthenticatedTaobaoSession } from '../browser-session.mjs';

const DETAIL_PATH = '/search/point/report/detail.json';

export async function runAiDianjingExport(opts = {}) {
  const inputUrl = String(opts.url || '').trim();
  const campaignId = String(opts.campaignId || parseCampaignId(inputUrl) || '').trim();
  if (!/^\d+$/.test(campaignId)) throw new Error('缺少或无效的 --campaign-id');
  if (inputUrl) assertAiDianjingUrl(inputUrl, campaignId);
  const days = boundedInteger(opts.days, 7, 1, 30, '--days');
  if (days !== 7) throw new Error('当前稳定版本仅支持 --days 7');
  const outPath = path.resolve(String(opts.out || `ai-dianjing-${campaignId}-7d.json`));
  const delayRange = resolveApiDelayRange(opts);

  await withAuthenticatedTaobaoSession(opts, async ({ context }) => {
    let page = context.pages().find((candidate) => (
      candidate.url().includes('one.alimama.com')
      && candidate.url().includes(`campaignId=${campaignId}`)
    ));
    if (!page && inputUrl) {
      page = await context.newPage();
      await waitBeforeTaobaoApiRequest(page, delayRange);
      await page.goto(inputUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.locator('button').filter({ hasText: '投放报告' }).first().waitFor({ state: 'visible', timeout: 30000 });
    }
    if (!page) throw new Error(`没有找到已打开的AI点睛计划页面：${campaignId}；也可以直接传 --url`);
    await assertPageNotVerifying(page);

    await ensurePastSevenDays(page, delayRange);
    await page.keyboard.press('Escape');
    await waitBeforeTaobaoApiRequest(page, delayRange);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.locator('button').filter({ hasText: '投放报告' }).first().waitFor({ state: 'visible', timeout: 30000 });
    await assertPageNotVerifying(page);
    const overview = await readAiDianjingOverview(page, campaignId);
    const reports = await captureDemandReports({
      page,
      demandNames: overview.demands.map((item) => item.name),
      delayRange,
    });
    await assertPageNotVerifying(page);

    const output = {
      channel: 'alimama-ai-dianjing-page',
      capturedAt: new Date().toISOString(),
      campaignId,
      period: overview.period,
      sourceUrl: page.url(),
      requestPolicy: delayRange,
      overview,
      reports,
    };
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
    if (opts.json) console.log(JSON.stringify(output, null, 2));
    else {
      console.log(`AI点睛计划：${overview.plan.name} (${campaignId})`);
      console.log(`周期：${overview.period.startTime} 至 ${overview.period.endTime}`);
      console.log(`需求：${overview.demands.length}；投放报告：${reports.length}`);
      console.log(`output: ${outPath}`);
    }
  });
}

export async function ensurePastSevenDays(page, delayRange, {
  waitBeforeRequest = waitBeforeTaobaoApiRequest,
} = {}) {
  const current = parsePeriodFromUrl(page.url());
  if (current && daysInclusive(current.startTime, current.endTime) === 7) return current;
  const option = page.getByText(/^过去\s*7\s*天$/, { exact: true }).first();
  if (!await option.count()) throw new Error('页面上没有找到“过去7天”时间选项');
  await waitBeforeRequest(page, delayRange);
  await option.click();
  await page.waitForFunction(() => {
    const url = new URL(location.href);
    const hashParams = new URLSearchParams(url.hash.split('?')[1] || '');
    const start = hashParams.get('startTime');
    const end = hashParams.get('endTime');
    if (!start || !end) return false;
    return Math.round((Date.parse(`${end}T00:00:00`) - Date.parse(`${start}T00:00:00`)) / 86400000) + 1 === 7;
  }, null, { timeout: 15000 });
  await assertPageNotVerifying(page);
  return parsePeriodFromUrl(page.url());
}

export async function readAiDianjingOverview(page, campaignId) {
  const raw = await page.evaluate(() => {
    const clean = (value) => String(value || '').replace(/[]/g, '').replace(/\s+/g, ' ').trim();
    const tables = [...document.querySelectorAll('table')];
    const tableRows = (table) => [...table.querySelectorAll('tbody tr')]
      .map((row) => [...row.querySelectorAll('td')].map((cell) => clean(cell.innerText)));
    const dailyTable = tables.find((table) => clean(table.querySelector('th')?.innerText) === '日期');
    const demandHeaderTable = tables.find((table) => clean(table.querySelector('th')?.innerText) === '需求名称');
    const headers = demandHeaderTable
      ? [...demandHeaderTable.querySelectorAll('th')].map((cell) => clean(cell.innerText).replace(/点击降序/g, '').trim())
      : [];
    const demandRows = tables.flatMap(tableRows).filter((row) => (
      headers.length > 0 && row.length === headers.length && row[0] && row[0] !== '投放报告'
    ));
    const bodyText = document.body.innerText;
    const insightMatch = bodyText.match(/AI点睛解读\s*([\s\S]*?)\s*AI点睛设置/);
    return {
      title: document.title,
      bodyText,
      dailyHeaders: dailyTable ? [...dailyTable.querySelectorAll('th')].map((cell) => clean(cell.innerText)) : [],
      dailyRows: dailyTable ? tableRows(dailyTable) : [],
      demandHeaders: headers,
      demandRows,
      aiInsightText: clean(insightMatch?.[1] || ''),
    };
  });
  const period = parsePeriodFromUrl(page.url());
  const planName = raw.bodyText.match(/计划：\s*([^\n]+)/)?.[1]?.trim() || '';
  const plan = {
    id: campaignId,
    name: planName,
    status: raw.bodyText.match(/状态：([^\n]+)/)?.[1]?.trim() || '',
    deliveryDate: raw.bodyText.match(/投放日期：([^\n]+)/)?.[1]?.trim() || '',
    dailyBudget: numberFrom(raw.bodyText.match(/修改每日预算：([\d.]+)元/)?.[1]),
    aiDianjingStatus: raw.bodyText.match(/AI点睛设置：\s*([^\n]+)/)?.[1]?.trim() || '',
    coldStartStatus: raw.bodyText.match(/冷启加速：\s*([^\n]+)/)?.[1]?.trim() || '',
    attribution: raw.bodyText.includes('末次点击归因模型和15天累计周期') ? '末次点击归因模型和15天累计周期' : '',
  };
  return {
    pageTitle: raw.title,
    plan,
    period,
    aiInsightText: raw.aiInsightText,
    dailyHeaders: raw.dailyHeaders,
    dailyRows: raw.dailyRows,
    demands: raw.demandRows.map((row) => Object.fromEntries(raw.demandHeaders.map((key, index) => [key, row[index] ?? '']))).map((item) => ({
      ...item,
      name: item['需求名称'],
    })),
  };
}

export async function captureDemandReports({
  page,
  demandNames,
  delayRange,
  waitBeforeRequest = waitBeforeTaobaoApiRequest,
}) {
  const reports = [];
  for (let index = 0; index < demandNames.length; index += 1) {
    await page.keyboard.press('Escape');
    const buttons = page.locator('button').filter({ hasText: '投放报告' });
    const count = await buttons.count();
    if (count !== demandNames.length) {
      throw new Error(`投放报告按钮数量异常：需求${demandNames.length}个，按钮${count}个`);
    }
    const button = buttons.nth(index);
    const response = await runReportPageAction({ page, button, delayRange, waitBeforeRequest });
    if (!response.ok()) throw new Error(`需求“${demandNames[index]}”投放报告请求失败：HTTP ${response.status()}`);
    const payload = await response.json();
    if (payload?.info?.ok !== true) throw new Error(`需求“${demandNames[index]}”投放报告返回异常`);
    reports.push(normalizeDemandReport(demandNames[index], payload));
    process.stderr.write(`\r投放报告：${index + 1}/${demandNames.length} ${demandNames[index]}`);
    await assertPageNotVerifying(page);
  }
  process.stderr.write('\n');
  await page.keyboard.press('Escape');
  return reports;
}

export async function runReportPageAction({ page, button, delayRange, waitBeforeRequest }) {
  const responsePromise = page.waitForResponse((response) => (
    response.url().includes(DETAIL_PATH) && response.request().method() === 'POST'
  ), { timeout: 15000 });
  await waitBeforeRequest(page, delayRange);
  const box = await button.boundingBox().catch(() => null);
  if (box?.width && box?.height) await button.click();
  else await button.evaluate((element) => element.click());
  return responsePromise;
}

export function normalizeDemandReport(demandName, payload) {
  const data = payload?.data || {};
  const readReport = data.readReport || {};
  return {
    demandName,
    needDescription: String(data.needDescription || ''),
    tags: Array.isArray(data.showTagList) ? data.showTagList : [],
    summary: readReport.summary || null,
    audiences: Array.isArray(readReport.cardReportList) ? readReport.cardReportList : [],
    searchTerms: Array.isArray(data.reportInfoList) ? data.reportInfoList : [],
    raw: payload,
  };
}

export function parsePeriodFromUrl(value) {
  const url = new URL(value);
  const hashParams = new URLSearchParams(url.hash.split('?')[1] || '');
  const startTime = hashParams.get('startTime') || '';
  const endTime = hashParams.get('endTime') || '';
  return startTime && endTime ? { startTime, endTime } : null;
}

export function parseCampaignId(value) {
  if (!value) return '';
  let decoded = String(value);
  try { decoded = decodeURIComponent(decoded); } catch {}
  return decoded.match(/(?:[?&#])campaignId=(\d+)/)?.[1] || '';
}

function assertAiDianjingUrl(value, campaignId) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'one.alimama.com') {
    throw new Error('--url 必须是 one.alimama.com 的HTTPS计划链接');
  }
  if (parseCampaignId(value) !== campaignId) throw new Error('--url 中没有匹配的AI点睛计划ID');
}

function daysInclusive(start, end) {
  return Math.round((Date.parse(`${end}T00:00:00`) - Date.parse(`${start}T00:00:00`)) / 86400000) + 1;
}

function numberFrom(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function boundedInteger(value, fallback, min, max, option) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${option} 必须是 ${min}-${max} 的整数`);
  }
  return parsed;
}
