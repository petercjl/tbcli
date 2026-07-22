import assert from 'node:assert/strict';
import test from 'node:test';

import { decodePriceText, isTrustedFontUrl, makeShopPageUrl } from '../src/tbcli/price-decoder.mjs';

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

test('builds shop pagination URLs and restricts font hosts', () => {
  assert.equal(
    makeShopPageUrl('https://demo.tmall.com/category.htm?spm=x&visible=true#anchor', 3),
    'https://demo.tmall.com/category.htm?visible=true&search=y&pageNo=3',
  );
  assert.equal(isTrustedFontUrl('https://webfontcdn.taobao.com/webfont/test.woff'), true);
  assert.equal(isTrustedFontUrl('https://cdn.example.com/test.woff'), false);
  assert.equal(isTrustedFontUrl('http://webfontcdn.taobao.com/test.woff'), false);
});
