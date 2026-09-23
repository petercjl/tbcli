import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import ExcelJS from '@excel.js/exceljs';
import { importProductImageWorkbook, validateProductImageWorkbook } from '../src/tbcli/product-images.mjs';
import { COMMAND_DEFINITIONS } from '../src/tbcli/command-registry.mjs';
import { ROUTED_COMMAND_KEYS } from '../src/tbcli/cli.mjs';

async function workbookFile(rows) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tbcli-product-images-'));
  const file = path.join(directory, '商品图片映射.xlsx');
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Sheet1');
  sheet.addRow(['商品ID', '商品标题', '图片链接', '商品类目']);
  rows.forEach((row) => sheet.addRow(row));
  await workbook.xlsx.writeFile(file);
  return file;
}

test('validates unique HTTPS product image mappings', async (t) => {
  const file = await workbookFile([
    ['1001', '商品甲', 'https://img.example.com/1001.jpg', '厨房用品'],
    ['1002', '商品乙', 'https://img.example.com/1002.jpg', '清洁用品'],
  ]);
  t.after(() => fs.rm(path.dirname(file), { recursive: true, force: true }));
  const result = await validateProductImageWorkbook(file, { shopKey: 'tmall:demo', shopName: 'Demo旗舰店' });
  assert.equal(result.ok, true);
  assert.equal(result.rowCount, 2);
  assert.equal(result.uniqueProductIds, 2);
  assert.equal(result.rows[0].platform_product_id, '1001');
});

test('rejects duplicate product IDs and non-HTTPS image URLs', async (t) => {
  const file = await workbookFile([
    ['1001', '商品甲', 'http://img.example.com/1001.jpg', '厨房用品'],
    ['1001', '商品甲新图', 'https://img.example.com/1001-new.jpg', '厨房用品'],
  ]);
  t.after(() => fs.rm(path.dirname(file), { recursive: true, force: true }));
  const result = await validateProductImageWorkbook(file, { shopKey: 'tmall:demo', shopName: 'Demo旗舰店' });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.code === 'PRODUCT_IMAGE_URL_INVALID'));
  assert.ok(result.errors.some((error) => error.code === 'PRODUCT_IMAGE_ID_DUPLICATE'));
});

test('imports product image mappings with product ID upsert and change counts', async () => {
  const calls = [];
  const client = { query: async (sql, params = []) => {
    calls.push({ sql, params });
    if (sql.includes('SELECT platform_product_id,shop_key')) return { rows: [
      { platform_product_id: '1001', shop_key: 'tmall:demo', shop_name: 'Demo旗舰店', product_title: '商品甲', image_url: 'https://img.example.com/1001.jpg', product_category: '厨房用品' },
      { platform_product_id: '1002', shop_key: 'tmall:demo', shop_name: 'Demo旗舰店', product_title: '商品乙', image_url: 'https://img.example.com/old.jpg', product_category: '清洁用品' },
    ] };
    return { rows: [] };
  } };
  const validation = { ok: true, sourceFile: '映射.xlsx', fileSha256: 'abc', rows: [
    { platform_product_id: '1001', shop_key: 'tmall:demo', shop_name: 'Demo旗舰店', product_title: '商品甲', image_url: 'https://img.example.com/1001.jpg', product_category: '厨房用品', source_row: 2 },
    { platform_product_id: '1002', shop_key: 'tmall:demo', shop_name: 'Demo旗舰店', product_title: '商品乙', image_url: 'https://img.example.com/1002.jpg', product_category: '清洁用品', source_row: 3 },
    { platform_product_id: '1003', shop_key: 'tmall:demo', shop_name: 'Demo旗舰店', product_title: '商品丙', image_url: 'https://img.example.com/1003.jpg', product_category: '厨房用品', source_row: 4 },
  ] };
  const result = await importProductImageWorkbook(client, validation);
  assert.deepEqual({ inserted: result.inserted, updated: result.updated, unchanged: result.unchanged }, { inserted: 1, updated: 1, unchanged: 1 });
  assert.ok(calls.some((call) => call.sql.includes('platform_product_id text PRIMARY KEY')));
  assert.equal(calls.filter((call) => call.sql.includes('ON CONFLICT(platform_product_id)')).length, 3);
  assert.equal(calls.at(-1).sql, 'COMMIT');
});

test('product image commands are routed and advertised', () => {
  assert.ok(ROUTED_COMMAND_KEYS.includes('product images validate'));
  assert.ok(ROUTED_COMMAND_KEYS.includes('product images import'));
  const capability = COMMAND_DEFINITIONS.find((definition) => definition.key === 'product images import');
  assert.equal(capability.audience, 'business');
  assert.equal(capability.capability.id, 'product-image-mapping-import');
  assert.match(capability.capability.commandTemplate, /--shop-key <KEY>/);
});
