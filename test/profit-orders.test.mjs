import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { validateProfitOrderExport } from '../src/tbcli/profit-orders.mjs';

function orderFixture() {
  return {
    tradeId: '100', tradeNo: 'JY100', tid: '200', srcTids: '200', shopId: '1',
    platformName: '天猫', shopName: '测试店铺', warehouseName: '仓库',
    tradeStatus: 95, tradeStatusFrontText: '已发货', refundStatus: 0, refundStatusText: '无退款',
    payTime: '2026-09-03T12:00:00', tradeTime: '2026-09-03T11:59:00',
    logistics: [{ trackingNo: 'TRACK1', carrier: '快递' }], goodsCount: '1', goodsTypeCount: '1',
    realAmount: '10.00', paid: '10.00', refundAmount: '0',
    items: [{ orderItemId: '300', srcOid: '400', apiSpuId: '500', apiSkuId: '600', spuNo: '500',
      skuNo: 'SKU1', spuName: '商品', skuName: '规格', skuNum: '1', refundNum: '0', shareAmount: '10.00',
      paid: '10.00', refundStatusName: '无退款', tradeStatusName: '已发货', goodsCost: '3.00',
      refCostPrice: '3.00', weight: '0.2', giftType: 0 }],
  };
}

async function writeFixture(overrides = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tbcli-profit-orders-'));
  const orders = overrides.orders || [orderFixture()];
  const metadata = {
    schemaVersion: 1, exportedAt: '2026-09-04T00:00:00.000Z', channel: 'erp-web',
    query: { timeField: 'payTime', payTimeBegin: '2026-09-03 00:00:00', payTimeEnd: '2026-09-03 23:59:59' },
    apiTotal: orders.length, apiTotalAfter: orders.length, exportedItemRows: orders.reduce((sum, order) => sum + order.items.length, 0),
    shopNames: ['测试店铺'], ordersSha256: crypto.createHash('sha256').update(JSON.stringify(orders)).digest('hex'),
    ...overrides.metadata,
  };
  const file = path.join(dir, 'orders.json');
  await fs.writeFile(file, `${JSON.stringify({ metadata, orders })}\n`);
  return file;
}

test('validates a privacy-trimmed WDT order export into stable header, line and shipment rows', async () => {
  const file = await writeFixture();
  const result = await validateProfitOrderExport(file, { shopKey: 'tmall:test', shopName: '测试店铺' });
  assert.equal(result.ok, true);
  assert.equal(result.coverageStart, '2026-09-03');
  assert.equal(result.orderCount, 1);
  assert.equal(result.lineCount, 1);
  assert.equal(result.shipmentCount, 1);
  assert.equal(result.rows.lines[0].order_line_key, 'id:300');
  assert.equal(result.rows.orders[0].paid_amount, '10.00');
});

test('rejects a shop mismatch and a source count mismatch before database access', async () => {
  const file = await writeFixture({ metadata: { apiTotal: 2, apiTotalAfter: 2, shopNames: ['其他店铺'] } });
  const result = await validateProfitOrderExport(file, { shopKey: 'tmall:test', shopName: '测试店铺' });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.code === 'ORDER_COUNT_MISMATCH'));
  assert.ok(result.errors.some((error) => error.code === 'ORDER_METADATA_SHOP_MISMATCH'));
});
