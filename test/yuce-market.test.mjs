import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import ExcelJS from '@excel.js/exceljs';
import { ensureYuceMarketSchema, importYuceCategoryWorkbook, validateYuceCategoryWorkbook } from '../src/tbcli/yuce-market.mjs';

const headers = ['月份', '一级类目', '二级类目', '总成交额（原始值）', '总成交额（展示值）', '成交额环比（原始值）', '成交额环比（展示值）', '是否有三级类目'];

async function fixture(dataRows, extraSheet = false) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tbcli-yuce-test-'));
  const file = path.join(directory, 'sample.xlsx');
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('二级类目月数据');
  sheet.addRow(headers);
  for (const row of dataRows) sheet.addRow(row);
  if (extraSheet) workbook.addWorksheet('元数据').addRow(['项目', '内容']);
  await workbook.xlsx.writeFile(file);
  return { file, directory };
}

test('validates a Yuce second-category workbook and preserves parent identity', async (t) => {
  const { file, directory } = await fixture([['2026-08', '厨房/烹饪用具', '厨用工具', 123.45, '123.45元', 0.1, '10%', '是']]);
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const result = await validateYuceCategoryWorkbook(file);
  assert.equal(result.level, 2);
  assert.equal(result.rowCount, 1);
  assert.equal(result.rows[0].parentKey, JSON.stringify(['厨房/烹饪用具']));
  assert.equal(result.rows[0].amount, 123.45);
});

test('rejects metadata sheets and duplicate category-month keys', async (t) => {
  const row = ['2026-08', '厨房/烹饪用具', '厨用工具', 123.45, '123.45元', 0.1, '10%', '是'];
  const extra = await fixture([row], true);
  const duplicate = await fixture([row, row]);
  t.after(() => Promise.all([extra.directory, duplicate.directory].map((dir) => fs.rm(dir, { recursive: true, force: true }))));
  await assert.rejects(() => validateYuceCategoryWorkbook(extra.file), /只有一张/);
  await assert.rejects(() => validateYuceCategoryWorkbook(duplicate.file), /重复/);
});

test('schema reserves separate product and shop rankings with category relationships', async () => {
  let sql = '';
  await ensureYuceMarketSchema({ async query(value) { sql = value; } });
  assert.match(sql, /CREATE TABLE IF NOT EXISTS market\.yuce_categories/);
  assert.match(sql, /parent_id bigint REFERENCES market\.yuce_categories/);
  assert.match(sql, /PRIMARY KEY\(category_id,stat_month\)/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS market\.yuce_product_rank_rows/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS market\.yuce_shop_rank_rows/);
});

test('missing parent rolls back the entire import', async (t) => {
  const { file, directory } = await fixture([['2026-08', '厨房/烹饪用具', '厨用工具', 123.45, '123.45元', 0.1, '10%', '是']]);
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const validation = await validateYuceCategoryWorkbook(file);
  const calls = [];
  const client = { async query(sql) {
    calls.push(sql);
    if (sql.includes('FROM market.yuce_import_batches')) return { rowCount: 0, rows: [] };
    if (sql.includes('RETURNING batch_id')) return { rowCount: 1, rows: [{ batch_id: 1 }] };
    if (sql.includes('FROM market.yuce_categories WHERE category_key')) return { rowCount: 0, rows: [] };
    return { rowCount: 0, rows: [] };
  } };
  await assert.rejects(() => importYuceCategoryWorkbook(client, validation), /父类目尚未入库/);
  assert.equal(calls[0], 'BEGIN');
  assert.equal(calls.at(-1), 'ROLLBACK');
});
