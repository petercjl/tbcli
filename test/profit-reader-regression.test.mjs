import test from 'node:test';
import assert from 'node:assert/strict';
import {listProfitOrderIdentities, getProfitOrderCoverage} from '../src/tbcli/profit-orders.mjs';
import {getProfitRefundCoverage} from '../src/tbcli/profit-refunds.mjs';

for (const [name, run, expectedQueries] of [
  ['identity', c => listProfitOrderIdentities(c), 1],
  ['order coverage', c => getProfitOrderCoverage(c, {shopKey:'demo',startDate:'2026-07-01',endDate:'2026-07-02'}), 2],
  ['refund coverage', c => getProfitRefundCoverage(c, {shopKey:'demo',startDate:'2026-07-01',endDate:'2026-07-02'}), 2],
]) {
  test(`${name} uses SELECT only with employee credentials`, async () => {
    let count = 0;
    const client = {query: async sql => {
      assert.match(sql.trim(), /^SELECT\b/i);
      assert.doesNotMatch(sql, /\b(CREATE|ALTER|INSERT|UPDATE|DELETE|DROP|GRANT)\b/i);
      count++;
      return {rows: []};
    }};
    await run(client);
    assert.equal(count, expectedQueries);
  });
}
