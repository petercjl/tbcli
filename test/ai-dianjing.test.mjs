import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeDemandReport,
  parseCampaignId,
  parsePeriodFromUrl,
  runReportPageAction,
} from '../src/tbcli/commands/ai-dianjing.mjs';

test('parsePeriodFromUrl reads the seven-day hash period', () => {
  assert.deepEqual(
    parsePeriodFromUrl('https://one.alimama.com/index.html#!/manage/search-detail?campaignId=1&startTime=2026-07-29&endTime=2026-08-04'),
    { startTime: '2026-07-29', endTime: '2026-08-04' },
  );
});

test('parseCampaignId reads an AI Dianjing plan link', () => {
  assert.equal(
    parseCampaignId('https://one.alimama.com/index.html#!/manage/search-detail?bizCode=onebpSearch&campaignId=82401003249&tab=crowd-report'),
    '82401003249',
  );
});

test('report page action applies guarded delay before the click that triggers data', async () => {
  const events = [];
  const response = { url: () => 'https://one.alimama.com/search/point/report/detail.json', request: () => ({ method: () => 'POST' }) };
  const page = { waitForResponse: async () => { events.push('listen'); return response; } };
  const button = { boundingBox: async () => ({ width: 10, height: 10 }), click: async () => { events.push('click'); } };
  const result = await runReportPageAction({
    page,
    button,
    delayRange: { minDelayMs: 1000, maxDelayMs: 2000 },
    waitBeforeRequest: async () => { events.push('guarded-delay'); },
  });
  assert.equal(result, response);
  assert.deepEqual(events, ['listen', 'guarded-delay', 'click']);
});

test('report page action stops before click when the guard rejects', async () => {
  let clicked = false;
  const page = { waitForResponse: () => new Promise(() => {}) };
  await assert.rejects(() => runReportPageAction({
    page,
    button: { boundingBox: async () => ({ width: 10, height: 10 }), click: async () => { clicked = true; } },
    delayRange: { minDelayMs: 1000, maxDelayMs: 2000 },
    waitBeforeRequest: async () => { throw new Error('VERIFY_REQUIRED'); },
  }), /VERIFY_REQUIRED/);
  assert.equal(clicked, false);
});

test('normalizeDemandReport preserves search terms, audiences, and raw payload', () => {
  const payload = {
    data: {
      needDescription: '需求描述',
      showTagList: [{ name: '表现稳定' }],
      reportInfoList: [{ searchQuery: '切面刀', click: 4 }],
      readReport: {
        summary: { title: '搜索拉新显著' },
        cardReportList: [{ crowdName: '家庭主妇' }],
      },
    },
    info: { ok: true },
  };
  const result = normalizeDemandReport('专用刮刀', payload);
  assert.equal(result.demandName, '专用刮刀');
  assert.equal(result.searchTerms[0].searchQuery, '切面刀');
  assert.equal(result.audiences[0].crowdName, '家庭主妇');
  assert.equal(result.raw, payload);
});
