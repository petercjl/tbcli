import assert from 'node:assert/strict';
import test from 'node:test';
import ExcelJS from '@excel.js/exceljs';

import { buildShopProductsWorkbook } from '../src/tbcli/shop-products-xlsx.mjs';

function sampleSource() {
  return {
    fetchedAt: '2026-07-22T15:00:00.000Z',
    shop: { name: '测试店', shopId: '550005142', sellerId: '2219607487449', url: 'https://demo.tmall.com/category.htm' },
    pagesFetched: 1,
    pageSize: 30,
    items: [{
      itemId: '938081659876', title: '测试商品', image: 'https://img.alicdn.com/x.jpg',
      itemUrl: 'https://detail.tmall.com/item.htm?id=938081659876', price: '20.01',
      priceStatus: 'decoded-font', encodedPrice: '[hidden]', encodedDisplayPrice: '混淆字符',
      vagueSold365: '10万+', rankings: [{ rightText: '热销榜第1名' }], skuCount: 1,
      benefits: '官方立减', skus: [{ skuId: '6000043614756', propertyText: '粉色', image: 'https://img/x.jpg', url: 'https://item.taobao.com/x' }],
    }],
  };
}

test('creates final-delivery workbook without technical price columns', async () => {
  const workbook = buildShopProductsWorkbook(sampleSource());
  assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), ['概览', '商品列表', 'SKU明细']);

  const overview = workbook.getWorksheet('概览');
  const overviewLabels = [];
  for (let row = 4; row <= 12; row += 1) overviewLabels.push(overview.getCell(row, 1).value);
  assert.ok(overviewLabels.includes('分页'));
  assert.ok(!overviewLabels.includes('API分页'));
  assert.ok(!overviewLabels.includes('请求延时'));
  assert.ok(!overviewLabels.includes('安全规则'));

  const products = workbook.getWorksheet('商品列表');
  const headers = products.getRow(4).values.slice(1);
  assert.ok(headers.includes('价格'));
  assert.ok(!headers.includes('明文价格'));
  assert.ok(!headers.includes('价格状态'));
  assert.ok(!headers.includes('接口原始编码价格'));
  assert.ok(!headers.includes('页面混淆字符'));
  assert.equal(products.getCell('F5').value, 20.01);

  const buffer = await workbook.xlsx.writeBuffer();
  const reopened = new ExcelJS.Workbook();
  await reopened.xlsx.load(buffer);
  assert.equal(reopened.getWorksheet('商品列表').getCell('B5').value, '938081659876');
  assert.equal(reopened.getWorksheet('SKU明细').getCell('C5').value, '6000043614756');
});
