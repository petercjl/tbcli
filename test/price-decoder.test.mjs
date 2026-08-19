import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decodePriceText,
  enrichEncodedPrices,
  isTrustedFontUrl,
  makeShopPageUrl,
} from '../src/tbcli/price-decoder.mjs';
import {
  normalizeDirectPrice,
  parseSecfontPrice,
} from '../src/tbcli/secfont-direct-decoder.mjs';

test('decodes dynamic-font price characters from glyph names', () => {
  const names = new Map([
    ['伂'.codePointAt(0), 'three'],
    ['嗤'.codePointAt(0), 'zero'],
    ['檰'.codePointAt(0), 'period'],
    ['攡'.codePointAt(0), 'zero'],
    ['勰'.codePointAt(0), 'zero'],
  ]);
  assert.equal(decodePriceText('伂嗤檰攡勰', (codePoint) => names.get(codePoint)), '30.00');
});

test('rejects unmapped or malformed price text', () => {
  assert.throws(() => decodePriceText('未知', () => undefined), /无法映射/);
  assert.throws(() => decodePriceText('甲乙', (codePoint) => codePoint === '甲'.codePointAt(0) ? 'period' : 'one'), /格式异常/);
});

test('parses and normalizes secfont API prices', () => {
  assert.deepEqual(
    parseSecfontPrice('[1_7ij1w4tp#51#QUJDRA==#]'),
    { runtimeId: '1_7ij1w4tp', parameter: 51, payload: 'QUJDRA==' },
  );
  assert.equal(parseSecfontPrice('[broken]'), null);
  assert.equal(normalizeDirectPrice('18.21'), '18.21');
  assert.equal(normalizeDirectPrice('27'), '27.00');
  assert.throws(() => normalizeDirectPrice('12.345'), /格式异常/);
});

test('prefers direct secfont decoding and does not scan shop pages', async () => {
  const items = [
    {
      itemId: '1',
      price: '',
      priceStatus: 'encoded',
      encodedPrice: '[1_7ij1w4tp#51#QUJDRA==#]',
    },
    {
      itemId: '2',
      price: '',
      priceStatus: 'encoded',
      encodedPrice: '[1_7ij1w4tp#51#RUZHSA==#]',
    },
  ];
  let directCalls = 0;
  const result = await enrichEncodedPrices({
    page: {},
    items,
    totalCount: 2,
    shopUrl: 'https://demo.tmall.com/category.htm',
    directDecoder: async () => {
      directCalls += 1;
      return [
        { itemId: '1', price: '18.21', confidence: 0.99 },
        { itemId: '2', price: '27.00', confidence: 0.99 },
      ];
    },
  });
  assert.equal(directCalls, 1);
  assert.deepEqual(items.map((item) => item.price), ['18.21', '27.00']);
  assert.deepEqual(items.map((item) => item.priceStatus), ['decoded-secfont', 'decoded-secfont']);
  assert.equal(result.decodedCount, 2);
  assert.equal(result.directDecodedCount, 2);
  assert.equal(result.scannedPages, 0);
});

test('builds shop pagination URLs and restricts font hosts', () => {
  assert.equal(
    makeShopPageUrl('https://demo.tmall.com/category.htm?spm=x&visible=true#anchor', 3),
    'https://demo.tmall.com/category.htm?visible=true&search=y&pageNo=3',
  );
  assert.equal(isTrustedFontUrl('https://webfontcdn.taobao.com/webfont/test.woff'), true);
  assert.equal(isTrustedFontUrl('https://cdn.example.com/test.woff'), false);
  assert.equal(isTrustedFontUrl('http://webfontcdn.taobao.com/test.woff'), false);
});

test('uses a plain price already captured from the requested shop page', async () => {
  const items = [{
    itemId: '1',
    itemUrl: 'https://detail.tmall.com/item.htm?id=1',
    price: '',
    priceStatus: 'encoded',
  }];
  const result = await enrichEncodedPrices({
    page: {},
    items,
    totalCount: 1,
    shopUrl: 'https://demo.tmall.com/category.htm',
    prefetchedVisibleItems: [{ itemId: '1', plainPrice: '19.90', pageNo: 1 }],
  });
  assert.equal(result.decodedCount, 1);
  assert.equal(items[0].price, '19.90');
  assert.equal(items[0].priceStatus, 'shop-page');
});

test('stops with partial data instead of visiting item detail pages', async () => {
  const page = {
    evaluate: async (fn) => String(fn).includes('const container')
      ? []
      : { url: 'https://demo.tmall.com/category.htm', title: '测试店', text: '商品列表' },
    waitForFunction: async () => {},
  };
  await assert.rejects(
    enrichEncodedPrices({
      page,
      items: [{ itemId: '1', itemUrl: 'https://detail.tmall.com/item.htm?id=1', price: '', priceStatus: 'encoded' }],
      totalCount: 1,
      shopUrl: 'https://demo.tmall.com/category.htm',
      maxShopPages: 1,
      navigateToShopPage: async () => {},
      onProgress: () => {},
    }),
    (error) => error.code === 'PARTIAL_DATA' && /避免逐个访问商品详情/.test(error.message),
  );
});

test('keeps prices already matched before returning PARTIAL_DATA', async () => {
  const items = [
    { itemId: '1', price: '', priceStatus: 'encoded' },
    { itemId: '2', price: '', priceStatus: 'encoded' },
  ];
  await assert.rejects(
    enrichEncodedPrices({
      page: {
        evaluate: async (fn) => String(fn).includes('const container')
          ? []
          : { url: 'https://demo.tmall.com/category.htm', title: '测试店', text: '商品列表' },
        waitForFunction: async () => {},
      },
      items,
      totalCount: 2,
      shopUrl: 'https://demo.tmall.com/category.htm',
      prefetchedVisibleItems: [{ itemId: '1', plainPrice: '29.90', pageNo: 1 }],
      maxShopPages: 1,
      navigateToShopPage: async () => {},
    }),
    (error) => error.code === 'PARTIAL_DATA' && error.partialDecodedCount === 1,
  );
  assert.equal(items[0].price, '29.90');
  assert.equal(items[1].price, '');
});
