import {
  resolvePageActionDelayRange,
  waitAfterTaobaoPageActionBeforeApiRequest,
} from './api-policy.mjs';
import { assertPageNotVerifying } from './taobao-guard.mjs';

export function currentShopPageNumber(value) {
  try {
    return Number(new URL(value).searchParams.get('pageNo') || 1);
  } catch {
    return 1;
  }
}

export async function openInitialShopProductPage(page, shopUrl, opts = {}, {
  startObservation = startShopSearchObservation,
  waitAfterPageAction = waitAfterTaobaoPageActionBeforeApiRequest,
} = {}) {
  await assertPageNotVerifying(page);
  const expectedHost = new URL(shopUrl).hostname;
  const finishObservation = startObservation(page, 1, expectedHost);
  await page.goto(shopUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  return finishShopPageAction(page, 1, opts, {
    action: 'initial-navigation',
    clicked: false,
    beforeUrl: 'about:blank',
    finishObservation,
    waitAfterPageAction,
  });
}

export async function prepareShopProductPage(page, pageNo, opts = {}, {
  startObservation = startShopSearchObservation,
  waitBeforeRequest = waitAfterTaobaoPageActionBeforeApiRequest,
} = {}) {
  await assertPageNotVerifying(page);

  const beforeUrl = page.url();
  const beforePageNo = currentShopPageNumber(beforeUrl);
  let action = 'initial-page';
  let clicked = false;
  let finishObservation = async () => '';

  if (beforePageNo !== pageNo) {
    const expectedHost = new URL(beforeUrl).hostname;
    const links = page.locator('.pagination a[href*="pageNo="]');
    const targetIndex = await links.evaluateAll((nodes, expectedPage) => nodes.findIndex((node) => {
      try {
        return Number(new URL(node.href, location.href).searchParams.get('pageNo')) === expectedPage;
      } catch {
        return false;
      }
    }), pageNo);
    if (targetIndex < 0) {
      throw new Error(`页面上找不到可点击的第 ${pageNo} 页；为避免直接跳页，已停止获取`);
    }
    const target = links.nth(targetIndex);
    await target.scrollIntoViewIfNeeded();
    finishObservation = startObservation(page, pageNo, expectedHost);
    await target.click({ noWaitAfter: true });
    action = 'pagination-click';
    clicked = true;
  }

  return finishShopPageAction(page, pageNo, opts, {
    action,
    clicked,
    beforeUrl,
    finishObservation,
    waitAfterPageAction: waitBeforeRequest,
  });
}

export function isShopSearchResponseUrl(value, pageNo, expectedHost = '') {
  try {
    const url = new URL(value);
    const actualPageNo = Number(url.searchParams.get('pageNo') || 1);
    return url.protocol === 'https:'
      && (!expectedHost || url.hostname === expectedHost)
      && url.pathname === '/i/asynSearch.htm'
      && actualPageNo === Number(pageNo);
  } catch {
    return false;
  }
}

function startShopSearchObservation(page, pageNo, expectedHost) {
  let observedUrl = '';
  const onRequest = (request) => {
    if (isShopSearchResponseUrl(request.url(), pageNo, expectedHost)) observedUrl = request.url();
  };
  page.on('request', onRequest);
  return async () => {
    try {
      if (!observedUrl) {
        await page.waitForFunction(
          ({ expectedPage, host }) => performance.getEntriesByType('resource').some((entry) => {
            try {
              const url = new URL(entry.name);
              return url.protocol === 'https:'
                && url.hostname === host
                && url.pathname === '/i/asynSearch.htm'
                && Number(url.searchParams.get('pageNo') || 1) === expectedPage;
            } catch {
              return false;
            }
          }),
          { expectedPage: Number(pageNo), host: expectedHost },
          { timeout: 30000 },
        );
        observedUrl = await page.evaluate(({ expectedPage, host }) => {
          const entry = performance.getEntriesByType('resource').find((candidate) => {
            try {
              const url = new URL(candidate.name);
              return url.protocol === 'https:'
                && url.hostname === host
                && url.pathname === '/i/asynSearch.htm'
                && Number(url.searchParams.get('pageNo') || 1) === expectedPage;
            } catch {
              return false;
            }
          });
          return entry?.name || '';
        }, { expectedPage: Number(pageNo), host: expectedHost });
      }
      if (!observedUrl) throw new Error(`没有观察到店铺第 ${pageNo} 页的真实商品请求`);
      return observedUrl;
    } finally {
      page.off('request', onRequest);
    }
  };
}

async function finishShopPageAction(page, pageNo, opts, {
  action,
  clicked,
  beforeUrl,
  finishObservation,
  waitAfterPageAction,
}) {
  const delayRange = resolvePageActionDelayRange(opts);
  const delayMs = await waitAfterPageAction(page, delayRange);
  const requestUrl = await finishObservation();
  await assertPageNotVerifying(page);
  const state = await page.evaluate(() => ({
    url: location.href,
    title: document.title,
    ready: Boolean(document.querySelector('.J_TItems')),
  }));
  if (!state.ready) throw new Error(`店铺第 ${pageNo} 页在等待时间内未加载出商品列表`);

  const actualPageNo = currentShopPageNumber(state.url);
  if (clicked && actualPageNo !== pageNo) {
    throw new Error(`点击翻页后停留在第 ${actualPageNo} 页，而不是第 ${pageNo} 页；已停止获取`);
  }

  return {
    pageNo,
    actualPageNo,
    action,
    clicked,
    delayMs,
    beforeUrl,
    url: state.url,
    requestUrl,
  };
}
