import assert from 'node:assert/strict';
import test from 'node:test';
import { getYuceCategorySnapshot, yuceCategoryCoverage } from '../src/tbcli/yuce-market.mjs';

test('Yuce snapshot uses a parameterized category tree and reports path-level gaps', async () => {
  const calls = [];
  const client = { async query(sql, params) {
    calls.push({ sql, params });
    if (sql.includes('to_regclass')) return { rows: [{ exists: true }] };
    return { rows: [
      { category_key: '["厨房/烹饪用具"]', category_level: 1, stat_month: '2026-07-01',
        transaction_amount: '100.00', transaction_amount_mom: null, transaction_volume: null,
        transaction_volume_mom: null, volume_status: 'not_collected', source_data: {}, source_file: 'first.xlsx', source_sha256: 'a' },
      { category_key: '["厨房/烹饪用具","厨用工具"]', category_level: 2, stat_month: '2026-07-01',
        transaction_amount: '30.00', transaction_amount_mom: '0.1', transaction_volume: null,
        transaction_volume_mom: null, volume_status: 'not_collected', source_data: { 是否有三级类目: '是' }, source_file: 'second.json', source_sha256: 'b' },
      { category_key: '["厨房/烹饪用具","厨用工具","切菜器"]', category_level: 3, stat_month: null },
    ] };
  } };
  const snapshot = await getYuceCategorySnapshot(client, { category: '厨房/烹饪用具', startMonth: '2026-07', endMonth: '2026-08' });
  const coverage = yuceCategoryCoverage(snapshot);
  assert.equal(snapshot.rows.length, 2);
  assert.deepEqual(coverage.categories.find((item) => item.level === 3).missingMonths, ['2026-07', '2026-08']);
  assert.equal(coverage.categories.find((item) => item.level === 2).hasThirdCategory, '是');
  assert.deepEqual(calls[1].params, ['["厨房/烹饪用具"]', '2026-07-01', '2026-08-01']);
  assert.match(calls[1].sql, /WITH RECURSIVE tree/);
});

test('Yuce snapshot handles an uninitialized warehouse and rejects invalid periods', async () => {
  const client = { async query() { return { rows: [{ exists: false }] }; } };
  const empty = await getYuceCategorySnapshot(client, { category: '新类目', startMonth: '2026-07', endMonth: '2026-08' });
  assert.deepEqual(empty.categories[0].missingMonths, ['2026-07', '2026-08']);
  assert.deepEqual(empty.rows, []);
  await assert.rejects(() => getYuceCategorySnapshot(client, { category: '新类目', startMonth: '2026-13', endMonth: '2026-08' }), /格式/);
});
