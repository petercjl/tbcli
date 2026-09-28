import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAuthoritativeComponents, reconcileComponents } from '../src/tbcli/profit-components.mjs';

const snapshot = {
  source: 'wdtcli:platform-sku-suite-snapshot/v1', shopKey: 'shop', platformSkuCount: 3,
  suiteCount: 1, productQueryFailures: [],
  skus: [
    { platformGoodsId: 'p', platformSkuId: 'combo', matchType: 'suite',
      suites: [{ suiteNo: 's' }], systemGoods: [] },
    { platformGoodsId: 'p', platformSkuId: 'single', matchType: 'single',
      suites: [], systemGoods: [{ specNo: 'x' }] },
    { platformGoodsId: 'p', platformSkuId: 'gap', matchType: 'none',
      suites: [], systemGoods: [] },
  ],
  suites: [{ suiteNo: 's', deleted: 0,
    components: [{ specNo: 'a', quantity: 2, deleted: 0 },
      { specNo: 'b', quantity: 1, deleted: 0 }] }],
};

test('uses exact suite component quantities and keeps gaps unapproved', () => {
  const result = buildAuthoritativeComponents(snapshot, 'shop');
  assert.deepEqual(result.rows.map((row) => [row.platform_sku_id, row.erp_spec_no, row.component_qty]),
    [['combo', 'a', 2], ['combo', 'b', 1], ['single', 'x', 1]]);
  assert.equal(result.coveredSkuCount, 2);
  assert.deepEqual(result.issues.map((issue) => issue.reason), ['platform_sku_unmapped']);
});

test('rejects duplicate platform SKUs and incomplete suite counts', () => {
  assert.throws(() => buildAuthoritativeComponents({ ...snapshot,
    skus: [snapshot.skus[0], snapshot.skus[0], snapshot.skus[2]] }, 'shop'), /重复/);
  assert.throws(() => buildAuthoritativeComponents({ ...snapshot, suiteCount: 2 }, 'shop'), /完整性/);
});

test('retains ambiguous suite mappings as gaps', () => {
  const result = buildAuthoritativeComponents({ ...snapshot, suiteCount: 2,
    suites: [snapshot.suites[0], { ...snapshot.suites[0], suiteId: 999 }] }, 'shop');
  assert.equal(result.coveredSkuCount, 1);
  assert.ok(result.issues.some((issue) => issue.reason === 'suite_ambiguous'));
});

test('reconcile reports changed quantities and removed old rows', async () => {
  const built = buildAuthoritativeComponents(snapshot, 'shop');
  const client = { query: async () => ({ rowCount: 2, rows: [
    { platform_product_id: 'p', platform_sku_id: 'combo', erp_spec_no: 'a', component_qty: '1' },
    { platform_product_id: 'p', platform_sku_id: 'old', erp_spec_no: 'z', component_qty: '1' },
  ] }) };
  const result = await reconcileComponents(client, { shopKey: 'shop', ...built }, 'old-batch');
  assert.equal(result.changedCount, 1);
  assert.equal(result.addedCount, 2);
  assert.equal(result.removedCount, 1);
});
