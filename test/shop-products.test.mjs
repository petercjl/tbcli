import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeShopProducts } from '../src/tbcli/commands/shop-products.mjs';

test('normalizes encoded prices and SKU rows without inventing a price', () => {
  const result = normalizeShopProducts({
    seller: { shopName: '测试店' }, shopId: '1', sellerId: '2', shopUrl: 'https://x.tmall.com/',
    totalCount: 1, pagesFetched: 1,
    rawItems: [{
      itemId: 3, title: '  商品  A ', itemUrl: '//detail.tmall.com/item.htm?id=3', image: '//img/x.jpg',
      priceEncoded: 'true', discountPrice: '[encoded]', vagueSold365: '100+',
      benefitPointList: [{ text: '官方立减' }],
      skuInfoList: [{ skuId: 4, skuPropertyText: '黑色', itemSkuUrl: '//item.taobao.com/item.htm?id=3' }],
    }],
  });
  assert.equal(result.items[0].price, '');
  assert.equal(result.items[0].priceStatus, 'encoded');
  assert.equal(result.items[0].encodedPrice, '[encoded]');
  assert.equal(result.items[0].itemUrl, 'https://detail.tmall.com/item.htm?id=3');
  assert.equal(result.items[0].title, '商品 A');
  assert.equal(result.items[0].skuCount, 1);
});
