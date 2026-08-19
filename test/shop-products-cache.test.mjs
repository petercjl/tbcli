import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  resolveShopProductsCheckpointPath,
  writeShopProductsCheckpoint,
} from '../src/tbcli/shop-products-cache.mjs';

test('places the checkpoint next to the requested delivery file', () => {
  const output = path.join(os.tmpdir(), 'products.xlsx');
  assert.equal(
    resolveShopProductsCheckpointPath({ outPath: output, shopId: '1' }),
    `${output}.checkpoint.json`,
  );
});

test('atomically preserves the last successful page in the checkpoint', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tbcli-cache-'));
  const file = path.join(directory, 'checkpoint.json');
  writeShopProductsCheckpoint(file, {
    status: 'in-progress',
    pagesFetched: 1,
    output: { items: [{ itemId: '1' }] },
  });
  writeShopProductsCheckpoint(file, {
    status: 'stopped',
    pagesFetched: 1,
    output: { items: [{ itemId: '1' }] },
    error: { code: 'TAOBAO_VERIFICATION_REQUIRED' },
  });
  const checkpoint = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(checkpoint.status, 'stopped');
  assert.equal(checkpoint.pagesFetched, 1);
  assert.deepEqual(checkpoint.output.items, [{ itemId: '1' }]);
  assert.equal(fs.readdirSync(directory).length, 1);
});
