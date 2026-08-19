import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseShopSearchResponse,
  unwrapJsonpHtml,
} from '../src/tbcli/shop-search-parser.mjs';

const MAIN_HTML = `
  <div class="J_TItems">
    <div class="item4line1">
      <dl class="item" data-id="1001">
        <dt class="photo"><a href="//detail.tmall.com/item.htm?id=1001"><img src="//img/1001.jpg"></a></dt>
        <dd class="thumb"><b data-sku="颜色:红"><img src="//img/red.jpg"></b></dd>
        <!-- item.discntPrice: 12.90 -->
        <dd class="detail">
          <a class="item-name" href="//detail.tmall.com/item.htm?id=1001&amp;from=shop"> 商品 A </a>
          <span class="c-price">加密价格</span>
          <span class="sale-num">10万+</span>
        </dd>
      </dl>
      <dl class="item" data-id="1002">
        <dt class="photo"><img data-ks-lazyload="//img/1002.jpg"></dt>
        <dd class="detail">
          <a class="item-name" href="//detail.tmall.com/item.htm?id=1002">商品 B</a>
          <span class="c-price">20.01</span>
          <span class="sale-num">3万+</span>
        </dd>
      </dl>
    </div>
    <div class="pagination"><a href="/category.htm?pageNo=2">2</a></div>
    <div class="item4line1"><dl class="item" data-id="9999"></dl></div>
  </div>
`;

test('unwraps the shop JSONP HTML string', () => {
  assert.equal(unwrapJsonpHtml(`jsonp1(${JSON.stringify(MAIN_HTML)})`), MAIN_HTML);
});

test('parses only main-list products before pagination and keeps page display data', () => {
  const result = parseShopSearchResponse(`jsonp1(${JSON.stringify(MAIN_HTML)})`, { pageNo: 1 });
  assert.equal(result.data.length, 2);
  assert.equal(result.hasNext, true);
  assert.equal(result.totalPages, 2);
  assert.deepEqual(result.data.map((item) => item.itemId), ['1001', '1002']);
  assert.equal(result.data[0].title, '商品 A');
  assert.equal(result.data[0].itemUrl, '//detail.tmall.com/item.htm?id=1001&from=shop');
  assert.equal(result.data[0].image, '//img/1001.jpg');
  assert.equal(result.data[0].discountPrice, '12.90');
  assert.equal(result.data[0].priceEncoded, false);
  assert.equal(result.data[0].vagueSold365, '10万+');
  assert.equal(result.data[0].skuInfoList.length, 1);
  assert.equal(result.data[0].skuInfoList[0].skuPropertyText, '颜色:红');
  assert.equal(result.data[1].discountPrice, '20.01');
  assert.equal(result.data[1].image, '//img/1002.jpg');
});

test('accepts JSONP objects containing the HTML in a nested field', () => {
  const body = `callback(${JSON.stringify({ result: { html: MAIN_HTML } })})`;
  assert.equal(parseShopSearchResponse(body).data.length, 2);
});

test('uses the real pagination boundary instead of hard-coding a 60-item page', () => {
  const products = Array.from({ length: 70 }, (_, index) => `
    <dl class="item" data-id="${2000 + index}">
      <!-- item.discntPrice: 9.90 -->
      <a class="item-name" href="//detail.tmall.com/item.htm?id=${2000 + index}">商品 ${index + 1}</a>
      <span class="c-price">密文</span>
    </dl>
  `).join('');
  const recommendations = Array.from({ length: 9 }, (_, index) => `
    <dl class="item" data-id="${9000 + index}"></dl>
  `).join('');
  const html = `
    <div class="J_TItems">
      <div class="item5line1">${products}</div>
      <div class="pagination"><a href="/category.htm?pageNo=8">8</a></div>
      <div class="comboHd">本店内推荐</div>
      <div class="item5line1">${recommendations}</div>
    </div>
  `;
  const result = parseShopSearchResponse(`callback(${JSON.stringify(html)})`, { pageNo: 1 });
  assert.equal(result.data.length, 70);
  assert.equal(result.totalPages, 8);
  assert.equal(result.hasNext, true);
  assert.equal(result.data.some((item) => item.itemId.startsWith('9')), false);
});
