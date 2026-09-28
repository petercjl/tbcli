import { assertMaintainerAccess, connectDatabase, loadDatabaseConfig } from '../database.mjs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ensureYuceMarketSchema, getYuceMarketStatus, importYuceCategoryWorkbook,
  getYuceCategorySnapshot, validateYuceCategoryWorkbook, yuceCategoryCoverage,
  yuceValidationSummary } from '../yuce-market.mjs';

function print(value) { console.log(JSON.stringify(value, null, 2)); }

export async function runYuceCategoryValidate(args) {
  const validation = await validateYuceCategoryWorkbook(args.input);
  print(yuceValidationSummary(validation));
  return validation;
}

export async function runYuceCategoryInit(args) {
  const config = await loadDatabaseConfig(args.config);
  assertMaintainerAccess(config);
  const client = await connectDatabase(config, 'ingest');
  try {
    await client.query('BEGIN');
    try {
      await ensureYuceMarketSchema(client);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
    print(await getYuceMarketStatus(client));
  } finally { await client.end(); }
}

export async function runYuceCategoryImport(args) {
  const validation = await validateYuceCategoryWorkbook(args.input);
  const config = await loadDatabaseConfig(args.config);
  assertMaintainerAccess(config);
  const client = await connectDatabase(config, 'ingest');
  try {
    const result = await importYuceCategoryWorkbook(client, validation, { mode: args.mode || 'append' });
    print(result);
    return result;
  } finally { await client.end(); }
}

export async function runYuceCategoryStatus(args) {
  const config = await loadDatabaseConfig(args.config);
  const client = await connectDatabase(config, 'read');
  try { print(await getYuceMarketStatus(client)); }
  finally { await client.end(); }
}

async function readSnapshot(args) {
  const config = await loadDatabaseConfig(args.config);
  const client = await connectDatabase(config, 'read');
  try {
    return await getYuceCategorySnapshot(client, {
      category: args.category, startMonth: args.startMonth, endMonth: args.endMonth,
    });
  } finally { await client.end(); }
}

export async function runYuceCategoryCoverage(args) {
  const result = yuceCategoryCoverage(await readSnapshot(args));
  print(result);
  return result;
}

export async function runYuceCategoryExport(args) {
  if (!args.out) throw new Error('缺少 --out 新 JSON 文件路径');
  const output = path.resolve(args.out);
  try {
    await fsp.stat(output);
    throw new Error(`输出文件已存在，不能覆盖：${output}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const snapshot = await readSnapshot(args);
  await fsp.writeFile(output, `${JSON.stringify(snapshot, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  const coverage = yuceCategoryCoverage(snapshot);
  const result = { ok: true, output, category: snapshot.category,
    startMonth: snapshot.startMonth, endMonth: snapshot.endMonth,
    monthCount: snapshot.months.length, rowCount: snapshot.rows.length,
    byLevel: coverage.byLevel };
  print(result);
  return result;
}
