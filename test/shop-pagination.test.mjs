import assert from 'node:assert/strict';
import test from 'node:test';

import {
  currentShopPageNumber,
  isShopSearchResponseUrl,
  openInitialShopProductPage,
  prepareShopProductPage,
} from '../src/tbcli/shop-pagination.mjs';

test('reads pageNo from shop URLs and defaults to the first page', () => {
  assert.equal(currentShopPageNumber('https://demo.tmall.com/category.htm'), 1);
  assert.equal(currentShopPageNumber('https://demo.tmall.com/category.htm?pageNo=2#anchor'), 2);
});

test('recognizes only the expected real shop-search response', () => {
  assert.equal(
    isShopSearchResponseUrl('https://demo.tmall.com/i/asynSearch.htm?wid=1&pageNo=2', 2, 'demo.tmall.com'),
    true,
  );
  assert.equal(
    isShopSearchResponseUrl('https://demo.tmall.com/i/asynSearch.htm?wid=1&pageNo=1', 2, 'demo.tmall.com'),
    false,
  );
  assert.equal(
    isShopSearchResponseUrl('https://other.tmall.com/i/asynSearch.htm?pageNo=2', 2, 'demo.tmall.com'),
    false,
  );
});

test('starts observing the real page request before clicking, then performs the guarded wait', async () => {
  const events = [];
  const page = {
    url: () => 'https://demo.tmall.com/category.htm',
    locator: () => ({
      evaluateAll: async () => {
        events.push('locate');
        return 0;
      },
      nth: () => ({
        scrollIntoViewIfNeeded: async () => events.push('scroll'),
        click: async () => events.push('click'),
      }),
    }),
    evaluate: async (fn) => {
      if (String(fn).includes('ready:')) {
        return {
          url: 'https://demo.tmall.com/category.htm?pageNo=2#anchor',
          title: '测试店',
          ready: true,
        };
      }
      return {
        url: 'https://demo.tmall.com/category.htm?pageNo=2#anchor',
        title: '测试店',
        text: '商品列表',
      };
    },
  };

  const result = await prepareShopProductPage(
    page,
    2,
    {},
    {
      startObservation: () => {
        events.push('observe');
        return async () => {
          events.push('request');
          return 'https://demo.tmall.com/i/asynSearch.htm?pageNo=2';
        };
      },
      waitBeforeRequest: async (_page, delayRange) => {
        events.push(`wait:${delayRange.minDelayMs}-${delayRange.maxDelayMs}`);
        return 4000;
      },
    },
  );

  assert.deepEqual(events, ['locate', 'scroll', 'observe', 'click', 'wait:3000-5000', 'request']);
  assert.equal(result.clicked, true);
  assert.equal(result.delayMs, 4000);
  assert.equal(result.actualPageNo, 2);
  assert.match(result.requestUrl, /asynSearch/);
});

test('stops instead of directly jumping when a pagination link is missing', async () => {
  const page = {
    url: () => 'https://demo.tmall.com/category.htm',
    locator: () => ({ evaluateAll: async () => -1 }),
    evaluate: async () => ({
      url: 'https://demo.tmall.com/category.htm',
      title: '测试店',
      text: '商品列表',
    }),
  };
  await assert.rejects(
    prepareShopProductPage(page, 2),
    /避免直接跳页，已停止获取/,
  );
});

test('starts observing before the initial shop navigation and waits while the page renders', async () => {
  const events = [];
  const page = {
    url: () => 'about:blank',
    goto: async () => events.push('goto'),
    evaluate: async (fn) => {
      if (String(fn).includes('ready:')) {
        return {
          url: 'https://demo.tmall.com/category.htm',
          title: '测试店',
          ready: true,
        };
      }
      return { url: 'about:blank', title: '', text: '' };
    },
  };
  const result = await openInitialShopProductPage(
    page,
    'https://demo.tmall.com/category.htm',
    {},
    {
      startObservation: () => {
        events.push('observe');
        return async () => {
          events.push('request');
          return 'https://demo.tmall.com/i/asynSearch.htm';
        };
      },
      waitAfterPageAction: async () => {
        events.push('wait');
        return 3500;
      },
    },
  );
  assert.deepEqual(events, ['observe', 'goto', 'wait', 'request']);
  assert.match(result.requestUrl, /asynSearch/);
  assert.equal(result.delayMs, 3500);
});
