import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { importYuceCategories, validateYuceCategoryJson } from '../src/tbcli/yuce-categories.mjs';
import { COMMAND_DEFINITIONS } from '../src/tbcli/command-registry.mjs';
import { ROUTED_COMMAND_KEYS } from '../src/tbcli/cli.mjs';

async function sampleFile(t, changes = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tbcli-yuce-categories-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'sample.json');
  const data = {
    ok: true,
    kind: 'second-category-monthly',
    category: '厨房/烹饪用具',
    months: ['2024-09', '2024-10'],
    rows: [
      { month: '2024-09', firstCategory: '厨房/烹饪用具', secondCategory: '烹饪用具', transactionAmount: 100.25, transactionAmountMom: 0.1 },
      { month: '2024-10', firstCategory: '厨房/烹饪用具', secondCategory: '烹饪用具', transactionAmount: 105.5, transactionAmountMom: 0.0524 },
    ],
    ...changes,
  };
  await fs.writeFile(file, JSON.stringify(data));
  return file;
}

test('validates yccli category hierarchy and contiguous months', async (t) => {
  const validation = await validateYuceCategoryJson(await sampleFile(t));
  assert.equal(validation.level, 2);
  assert.equal(validation.rowCount, 2);
  assert.deepEqual(validation.rows[0].names, ['厨房/烹饪用具', '烹饪用具']);
  assert.equal(validation.rows[0].sourceRow, 2);
});

test('validates and imports first-category JSON with volume quality semantics', async (t) => {
  const file = await sampleFile(t, {
    kind: 'first-category-monthly',
    rows: [
      { month: '2024-09', firstCategory: '厨房/烹饪用具', transactionAmount: 100.25, transactionAmountMom: 0.1, transactionVolume: 0, transactionVolumeMom: 0.2 },
      { month: '2024-10', firstCategory: '厨房/烹饪用具', transactionAmount: 105.5, transactionAmountMom: 0.0524, transactionVolume: 9, transactionVolumeMom: 0.3 },
    ],
  });
  const validation = await validateYuceCategoryJson(file);
  assert.equal(validation.level, 1);
  assert.deepEqual(validation.rows[0].names, ['厨房/烹饪用具']);
  assert.equal(validation.rows[0].volumeStatus, 'suspect_missing');
  const calls = [];
  const client = { query: async (sql, params = []) => {
    calls.push({ sql, params });
    if (sql.includes('SELECT category_id, category_key')) return { rows: [] };
    if (sql.includes('INSERT INTO market.yuce_categories')) return { rows: [{ category_id: '1' }] };
    if (sql.includes('SELECT category_id,stat_month::text')) return { rows: [] };
    if (sql.includes('INSERT INTO market.yuce_import_batches')) return { rows: [{ batch_id: '7' }] };
    return { rows: [] };
  } };
  const result = await importYuceCategories(client, validation);
  assert.equal(result.inserted, 2);
  const firstInsert = calls.find((call) => call.sql.includes('INSERT INTO market.yuce_category_monthly'));
  assert.equal(firstInsert.params[4], 0);
  assert.equal(firstInsert.params[6], 'suspect_missing');
});

test('rejects duplicate category-month records', async (t) => {
  const row = { month: '2024-09', firstCategory: '厨房/烹饪用具', secondCategory: '烹饪用具', transactionAmount: 100.25 };
  const file = await sampleFile(t, { rows: [row, row] });
  await assert.rejects(validateYuceCategoryJson(file), /重复月份和路径/);
});

test('imports missing rows without replacing matching historical rows', async (t) => {
  const validation = await validateYuceCategoryJson(await sampleFile(t));
  const calls = [];
  const client = { query: async (sql, params = []) => {
    calls.push({ sql, params });
    if (sql.includes('SELECT category_id, category_key')) return { rows: [
      { category_id: '1', category_key: '["厨房/烹饪用具"]', category_level: 1, parent_id: null },
      { category_id: '2', category_key: '["厨房/烹饪用具","烹饪用具"]', category_level: 2, parent_id: '1' },
    ] };
    if (sql.includes('SELECT category_id,stat_month::text')) return { rows: [
      { category_id: '2', month_key: '2024-10-01', transaction_amount: '105.50', transaction_amount_mom: '0.05240000' },
    ] };
    if (sql.includes('INSERT INTO market.yuce_import_batches')) return { rows: [{ batch_id: '7' }] };
    return { rows: [] };
  } };
  const result = await importYuceCategories(client, validation);
  assert.equal(result.inserted, 1);
  assert.equal(result.unchanged, 1);
  assert.equal(result.minMonth, '2024-09');
  assert.equal(calls.filter((call) => call.sql.includes('INSERT INTO market.yuce_category_monthly')).length, 1);
  assert.equal(calls.at(-1).sql, 'COMMIT');
});

test('rolls back when overlap differs', async (t) => {
  const validation = await validateYuceCategoryJson(await sampleFile(t));
  const calls = [];
  const client = { query: async (sql) => {
    calls.push(sql);
    if (sql.includes('SELECT category_id, category_key')) return { rows: [
      { category_id: '1', category_key: '["厨房/烹饪用具"]', category_level: 1, parent_id: null },
      { category_id: '2', category_key: '["厨房/烹饪用具","烹饪用具"]', category_level: 2, parent_id: '1' },
    ] };
    if (sql.includes('SELECT category_id,stat_month::text')) return { rows: [
      { category_id: '2', month_key: '2024-09-01', transaction_amount: '99.99', transaction_amount_mom: '0.10000000' },
    ] };
    return { rows: [] };
  } };
  await assert.rejects(importYuceCategories(client, validation), /已有数据与新文件冲突/);
  assert.equal(calls.at(-1), 'ROLLBACK');
  assert.equal(calls.some((sql) => sql.includes('INSERT INTO market.yuce_category_monthly')), false);
});

test('yuce category commands are routed and advertised', () => {
  for (const command of ['yuce categories validate', 'yuce categories import']) {
    assert.ok(ROUTED_COMMAND_KEYS.includes(command));
    assert.ok(COMMAND_DEFINITIONS.some((definition) => definition.key === command));
  }
});
