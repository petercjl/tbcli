import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import ExcelJS from '@excel.js/exceljs';
import {
  DEFAULT_DATABASE_PGPASS,
  defaultAggregation,
  assertMaintainerAccess,
  checkDatabaseWriteAccess,
  discoverImportFiles,
  ensureWarehouseSchema,
  getDatasetCoverage,
  identifyDataset,
  importWorkbook,
  listDatasetFields,
  loadDatabaseConfig,
  queryBusinessData,
  readPgpassPassword,
  resolveDatabaseCredentialPath,
  resolveDataset,
  validateDatabaseCredentialFile,
} from '../src/tbcli/database.mjs';
import {
  createReaderCredentialBundle,
  decryptReaderCredentialBundle,
  serializeReaderPgpass,
} from '../src/tbcli/credential-bundle.mjs';
import {
  runDatabaseCredentialSet,
  runDatabaseSetupReader,
} from '../src/tbcli/commands/database.mjs';

test('identifies only canonical all-history workbook names', () => {
  assert.equal(identifyDataset('店铺-整体-全部历史-分日-所有终端-2025至2026.xlsx').key, 'shop-overall');
  assert.equal(identifyDataset('商品-SKU-分日-全部SKU-所有终端汇总-2025至2026.xlsx').key, 'item-sku');
  assert.equal(identifyDataset('商品-整体-指定商品2-全部历史.xlsx'), null);
  assert.equal(resolveDataset('商品-经营投产比').key, 'item-roi');
  assert.equal(identifyDataset('商品-流量来源-分日-全部商品-最后一次访问来源-2025-07-21-2026-08-24.xlsx').key, 'item-traffic-source');
  assert.equal(resolveDataset('商品-流量来源').dataDimension, '流量来源');
  assert.equal(identifyDataset('商品-流量来源详情-分日-全部搜索来源-全部商品-最后一次访问来源-2025-07-21-2026-08-24.xlsx').key, 'item-traffic-source-detail');
  assert.equal(resolveDataset('商品-流量来源详情').dataDimension, '流量来源详情');
  assert.equal(identifyDataset('商品-整体退款分布-分日-全部商品-2025-07-20-2026-08-23.xlsx').key, 'item-refund-overall');
  assert.equal(resolveDataset('商品-整体退款分布').dataDimension, '整体退款分布');
  assert.equal(identifyDataset('商品-退款原因分布-分日-全部商品-全部时间类型-全部退款场景-全部退款时间-2025-07-20-2026-08-23.xlsx').key, 'item-refund-reason');
  assert.equal(resolveDataset('商品-退款原因分布').dataDimension, '退款原因分布');
  assert.equal(identifyDataset('商品-流失竞店分布-分日-全部商品-全部时间类型-全部退款场景-全部退款后状态-2025-07-20-2026-08-23.xlsx').key, 'item-loss-competitor');
  assert.equal(resolveDataset('商品-流失竞店分布').dataDimension, '流失竞店分布');
  assert.equal(identifyDataset('商品-退款SKU分布-分日-全部商品-2025-07-21-2026-08-24.xlsx').key, 'item-refund-sku');
  assert.equal(resolveDataset('商品-退款SKU分布').dataDimension, '退款SKU分布');
});

test('discovers canonical workbooks and reports ignored files', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tbcli-db-discovery-'));
  await fs.writeFile(path.join(dir, '店铺-关键词-分日-全部分词类型-2025.xlsx'), 'x');
  await fs.writeFile(path.join(dir, '商品-整体-指定商品-全部历史.xlsx'), 'x');
  const result = await discoverImportFiles(dir);
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].dataset.key, 'shop-keyword');
  assert.equal(result.ignored.length, 1);
});

test('accepts an explicitly identified incremental workbook file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tbcli-db-incremental-'));
  const file = path.join(dir, '商品整体-2026-08-20至2026-08-24.xlsx');
  await fs.writeFile(file, 'x');
  const result = await discoverImportFiles(file, '商品-整体');
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].dataset.key, 'item-overall');
});

test('classifies additive and derived metrics', () => {
  assert.equal(defaultAggregation('支付金额'), 'sum');
  assert.equal(defaultAggregation('支付件数'), 'sum');
  assert.equal(defaultAggregation('支付转化率'), 'avg');
  assert.equal(defaultAggregation('推广ROI'), 'avg');
  assert.equal(defaultAggregation('平均点击花费'), 'avg');
});

test('lists a dataset field catalog in source order', async () => {
  const client = {
    async query(text, values) {
      assert.match(text, /ORDER BY ordinal/);
      assert.deepEqual(values, ['item-overall']);
      return { rows: [
        { field_name: '统计日期', field_kind: 'dimension', default_aggregation: null },
        { field_name: '支付金额', field_kind: 'metric', default_aggregation: 'sum' },
      ] };
    },
  };
  const result = await listDatasetFields(client, '商品-整体');
  assert.equal(result.datasetKey, 'item-overall');
  assert.equal(result.grain, 'day');
  assert.deepEqual(result.fields[1], { name: '支付金额', kind: 'metric', aggregation: 'sum' });
});

test('initializes warehouse schemas and the dataset catalog before fact tables', async () => {
  let sql = '';
  await ensureWarehouseSchema({ async query(text) { sql = text; } });
  assert.match(sql, /CREATE SCHEMA IF NOT EXISTS raw/);
  assert.match(sql, /CREATE SCHEMA IF NOT EXISTS mart/);
  assert.match(sql, /CREATE SCHEMA IF NOT EXISTS meta/);
  assert.ok(sql.indexOf('CREATE TABLE IF NOT EXISTS meta.datasets') < sql.indexOf('CREATE TABLE IF NOT EXISTS meta.dataset_fields'));
  assert.match(sql, /coverage_start/);
});

test('reports continuous missing daily periods from explicit coverage', async () => {
  let call = 0;
  const client = {
    async query() {
      call += 1;
      if (call === 1) return { rowCount: 1, rows: [{ min_date: '2026-08-01', max_date: '2026-08-05', row_count: '4' }] };
      if (call === 2) return { rows: [{ start_date: '2026-08-01', end_date: '2026-08-02', import_mode: 'append' }] };
      return { rows: [{ stat_date: '2026-08-05' }] };
    },
  };
  const result = await getDatasetCoverage(client, '商品-整体', { startDate: '2026-08-01', endDate: '2026-08-05' });
  assert.equal(result.complete, false);
  assert.deepEqual(result.missingPeriods, [{ startDate: '2026-08-03', endDate: '2026-08-04' }]);
  assert.equal(result.coveredPeriods, 3);
});

test('replace-range imports one explicit interval inside a transaction', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tbcli-db-replace-range-'));
  const file = path.join(dir, 'incremental.xlsx');
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('数据');
  sheet.addRow(['统计日期', '店铺名称', '商品ID', '商品名称', '支付金额']);
  sheet.addRow(['2026-08-20', '示例店铺', '1', '示例商品', 100]);
  await workbook.xlsx.writeFile(file);
  const calls = [];
  const client = {
    async query(text, values) {
      const call = typeof text === 'object' ? { text: text.text, values: text.values } : { text: String(text), values };
      calls.push(call);
      if (call.text.startsWith('SELECT row_count')) return { rowCount: 0, rows: [] };
      if (call.text.startsWith('SELECT field_name')) return { rowCount: 0, rows: [] };
      return { rowCount: 0, rows: [] };
    },
  };
  const result = await importWorkbook(client, file, resolveDataset('商品-整体'), {
    mode: 'replace-range', startDate: '2026-08-20', endDate: '2026-08-21',
  });
  assert.equal(result.mode, 'replace-range');
  assert.equal(result.coverageEnd, '2026-08-21');
  assert.ok(calls.some((call) => call.text === 'BEGIN'));
  assert.ok(calls.some((call) => /DELETE FROM raw\.sycm_rows WHERE dataset_key=\$1 AND stat_date BETWEEN/.test(call.text)));
  assert.equal(calls.at(-1).text, 'COMMIT');
});

test('imports current item traffic-source hierarchy headers', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tbcli-db-traffic-source-'));
  const file = path.join(dir, 'traffic-source.xlsx');
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('data');
  sheet.addRow([
    '统计日期', '店铺名称', '一级流量来源', '二级流量来源', '三级流量来源',
    '商品ID', '商品名称', '来源层级', '归属原则', '支付金额',
  ]);
  sheet.addRow([
    '2026-08-20', '示例店铺', '平台流量', '手淘搜索', '汇总',
    '1', '示例商品', 2, '最后一次访问来源', 100,
  ]);
  await workbook.xlsx.writeFile(file);
  const calls = [];
  const client = {
    async query(text, values) {
      const call = typeof text === 'object' ? { text: text.text, values: text.values } : { text: String(text), values };
      calls.push(call);
      if (call.text.startsWith('SELECT row_count')) return { rowCount: 0, rows: [] };
      if (call.text.startsWith('SELECT field_name')) return { rowCount: 0, rows: [] };
      return { rowCount: 0, rows: [] };
    },
  };
  const result = await importWorkbook(client, file, resolveDataset('商品-流量来源'), {
    mode: 'replace-range', startDate: '2026-08-20', endDate: '2026-08-20',
  });
  const insert = calls.find((call) => call.text.startsWith('INSERT INTO raw.sycm_rows'));
  assert.equal(result.columns, 10);
  assert.equal(insert.values[12], '平台流量');
  assert.equal(insert.values[13], '手淘搜索');
  assert.equal(insert.values[14], 2);
});

test('imports old item traffic-source-detail search fields', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tbcli-db-traffic-source-detail-'));
  const file = path.join(dir, 'traffic-source-detail.xlsx');
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('data');
  sheet.addRow(['统计日期', '店铺名称', '商品ID', '商品名称', '搜索词类型', '搜索词', '归属原则', '支付金额']);
  sheet.addRow(['2026-08-24', '示例店铺', '1', '示例商品', '手淘搜索', '烤肉盘', '最后一次访问来源', 100]);
  await workbook.xlsx.writeFile(file);
  const calls = [];
  const client = {
    async query(text, values) {
      const call = typeof text === 'object' ? { text: text.text, values: text.values } : { text: String(text), values };
      calls.push(call);
      if (call.text.startsWith('SELECT row_count')) return { rowCount: 0, rows: [] };
      if (call.text.startsWith('SELECT field_name')) return { rowCount: 0, rows: [] };
      return { rowCount: 0, rows: [] };
    },
  };
  const result = await importWorkbook(client, file, resolveDataset('商品-流量来源详情'), {
    mode: 'replace-range', startDate: '2026-08-24', endDate: '2026-08-24',
  });
  const insert = calls.find((call) => call.text.startsWith('INSERT INTO raw.sycm_rows'));
  assert.equal(result.columns, 8);
  assert.equal(insert.values[15], '最后一次访问来源');
  assert.equal(insert.values[18], '手淘搜索');
  assert.equal(insert.values[19], '烤肉盘');
});

test('loads config and reads a matching protected pgpass entry', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tbcli-db-config-'));
  const pgpassFile = path.join(dir, 'pgpass');
  const configFile = path.join(dir, 'database.json');
  await fs.writeFile(pgpassFile, '192.168.0.20:5432:commerce_analytics:tb_agent:secret\\:value\n', { mode: 0o600 });
  await fs.chmod(pgpassFile, 0o600);
  await fs.writeFile(configFile, JSON.stringify({
    host: '192.168.0.20', port: 5432, database: 'commerce_analytics',
    readerUser: 'tb_agent', ingestUser: 'tb_ingest', pgpassFile,
  }));
  const config = await loadDatabaseConfig(configFile);
  assert.equal(config.accessMode, 'maintainer');
  assert.equal(await readPgpassPassword(config, 'tb_agent'), 'secret:value');
});

test('uses a stable user config path for database credentials', () => {
  assert.equal(resolveDatabaseCredentialPath(), DEFAULT_DATABASE_PGPASS);
  assert.doesNotMatch(DEFAULT_DATABASE_PGPASS, /node_modules/i);
  assert.throws(
    () => resolveDatabaseCredentialPath(path.join(os.tmpdir(), 'node_modules', '@petercjl', 'tbcli', '.pgpass')),
    /升级会删除该文件/,
  );
  assert.throws(
    () => resolveDatabaseCredentialPath(path.join(os.tmpdir(), '.sealseek', 'skill_pool', 'tbcli', '.pgpass')),
    /Skill 安装目录/,
  );
});

test('validates an existing credential file and rejects a missing one', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tbcli-db-credential-'));
  const credentialFile = path.join(dir, 'pgpass');
  await fs.writeFile(credentialFile, 'placeholder\n', { mode: 0o600 });
  assert.equal(await validateDatabaseCredentialFile(credentialFile), credentialFile);
  await assert.rejects(validateDatabaseCredentialFile(path.join(dir, 'missing')), /密码文件不存在/);
});

test('rejects a legacy config that stores credentials in node_modules', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tbcli-db-unsafe-config-'));
  const configFile = path.join(dir, 'database.json');
  await fs.writeFile(configFile, JSON.stringify({
    host: '192.168.0.20', port: 5432, database: 'commerce_analytics',
    readerUser: 'tb_agent', ingestUser: 'tb_ingest',
    pgpassFile: path.join(dir, 'node_modules', '@petercjl', 'tbcli', '.pgpass'),
  }));
  await assert.rejects(loadDatabaseConfig(configFile), /不能放在 tbcli\/npm\/Skill 安装目录中/);
});

test('credential-set backs up config and changes only the credential path', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tbcli-db-credential-set-'));
  const configFile = path.join(dir, 'database.json');
  const credentialFile = path.join(dir, 'pgpass');
  const original = {
    version: 2, accessMode: 'read-only', host: '192.168.0.20', port: 5432,
    database: 'commerce_analytics', readerUser: 'tb_agent', ingestUser: 'tb_agent',
    pgpassFile: '/legacy/unsafe/location',
  };
  await fs.writeFile(configFile, `${JSON.stringify(original, null, 2)}\n`, { mode: 0o600 });
  await fs.writeFile(credentialFile, 'placeholder\n', { mode: 0o600 });
  const output = [];
  const previousLog = console.log;
  console.log = (value) => output.push(value);
  try {
    await runDatabaseCredentialSet({ config: configFile, pgpassFile: credentialFile, json: true });
  } finally {
    console.log = previousLog;
  }
  const next = JSON.parse(await fs.readFile(configFile, 'utf8'));
  assert.deepEqual(next, { ...original, pgpassFile: credentialFile });
  const files = await fs.readdir(dir);
  const backupName = files.find((name) => name.startsWith('database.json.backup-'));
  assert.ok(backupName);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, backupName), 'utf8')), original);
  const result = JSON.parse(output[0]);
  assert.equal(result.pgpassFile, credentialFile);
});

test('encrypted reader bundle contains exactly the selected read-only credential', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tbcli-db-bundle-'));
  const credentialFile = path.join(dir, 'source.pgpass');
  await fs.writeFile(credentialFile, [
    '192.168.0.20:5432:commerce_analytics:tb_agent:reader\\:secret',
    '192.168.0.20:5432:commerce_analytics:tb_ingest:writer-secret',
    '',
  ].join('\n'), { mode: 0o600 });
  const bundle = await createReaderCredentialBundle({
    pgpassFile: credentialFile,
    host: '192.168.0.20',
    port: 5432,
    database: 'commerce_analytics',
    readerUser: 'tb_agent',
  });
  const serialized = JSON.stringify(bundle);
  assert.doesNotMatch(serialized, /reader:secret|writer-secret/);
  const payload = decryptReaderCredentialBundle(bundle);
  assert.deepEqual(payload, {
    version: 1,
    accessMode: 'read-only',
    host: '192.168.0.20',
    port: 5432,
    database: 'commerce_analytics',
    readerUser: 'tb_agent',
    password: 'reader:secret',
  });
  assert.equal(serializeReaderPgpass(payload), '192.168.0.20:5432:commerce_analytics:tb_agent:reader\\:secret\n');
});

test('encrypted reader bundles use unique ciphertext and detect tampering', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tbcli-db-bundle-random-'));
  const credentialFile = path.join(dir, 'source.pgpass');
  await fs.writeFile(credentialFile, '192.168.0.20:5432:commerce_analytics:tb_agent:secret\n', { mode: 0o600 });
  const input = { pgpassFile: credentialFile, host: '192.168.0.20', port: 5432, database: 'commerce_analytics', readerUser: 'tb_agent' };
  const first = await createReaderCredentialBundle(input);
  const second = await createReaderCredentialBundle(input);
  assert.notEqual(first.ciphertext, second.ciphertext);
  const tampered = { ...first, ciphertext: `${first.ciphertext.slice(0, -4)}AAAA` };
  assert.throws(() => decryptReaderCredentialBundle(tampered), /损坏、被修改或无法解密/);
});

test('reader setup never replaces a maintainer database configuration', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tbcli-db-bundle-maintainer-'));
  const configFile = path.join(dir, 'database.json');
  await fs.writeFile(configFile, JSON.stringify({
    version: 2, accessMode: 'maintainer', host: '192.168.0.20', port: 5432,
    database: 'commerce_analytics', readerUser: 'tb_agent', ingestUser: 'tb_ingest',
    pgpassFile: path.join(dir, 'pgpass'),
  }), { mode: 0o600 });
  await assert.rejects(
    () => runDatabaseSetupReader({ config: configFile, credentialFile: path.join(dir, 'missing.tbcred'), json: true }),
    /不会替换它/,
  );
  const preserved = JSON.parse(await fs.readFile(configFile, 'utf8'));
  assert.equal(preserved.accessMode, 'maintainer');
  assert.equal(preserved.ingestUser, 'tb_ingest');
});

test('rejects warehouse writes from a read-only client configuration', () => {
  assert.throws(
    () => assertMaintainerAccess({ accessMode: 'read-only' }),
    /只读模式/,
  );
  assert.doesNotThrow(() => assertMaintainerAccess({ accessMode: 'maintainer' }));
});

function writeCheckClient({ failOnRawInsert = false } = {}) {
  const calls = [];
  let rolledBack = false;
  return {
    calls,
    async query(text, values) {
      const sql = String(text).trim();
      calls.push({ text: sql, values });
      if (sql === 'ROLLBACK') rolledBack = true;
      if (sql === 'SELECT current_database() AS database,current_user AS user') {
        return { rows: [{ database: 'commerce_analytics', user: 'tb_ingest' }] };
      }
      if (sql.includes('to_regclass')) return { rows: [{ exists: true }] };
      if (sql.includes('has_table_privilege') || sql.includes('has_sequence_privilege')) {
        return { rows: [{ allowed: true }] };
      }
      if (sql.includes('(SELECT count(*)::int FROM meta.datasets')) {
        return { rows: [rolledBack
          ? { datasets: 0, dataset_fields: 0, import_files: 0, sycm_rows: 0 }
          : { datasets: 1, dataset_fields: 1, import_files: 1, sycm_rows: 1 }] };
      }
      if (failOnRawInsert && sql.startsWith('INSERT INTO raw.sycm_rows')) {
        throw new Error('permission denied for table sycm_rows');
      }
      return { rows: [], rowCount: 1 };
    },
  };
}

test('write check exercises importer DML and rolls back with zero residue', async () => {
  const client = writeCheckClient();
  const result = await checkDatabaseWriteAccess(client);
  assert.equal(result.ok, true);
  assert.equal(result.user, 'tb_ingest');
  assert.equal(result.probe.inserted, true);
  assert.equal(result.probe.updated, true);
  assert.equal(result.probe.deleted, true);
  assert.equal(result.probe.rolledBack, true);
  assert.equal(result.probe.residueCount, 0);
  assert.ok(client.calls.some((call) => call.text === 'BEGIN'));
  assert.ok(client.calls.some((call) => call.text === 'ROLLBACK'));
  assert.ok(client.calls.some((call) => call.text.startsWith('INSERT INTO raw.sycm_rows')));
  assert.ok(client.calls.some((call) => call.text.startsWith('UPDATE meta.datasets')));
  assert.ok(client.calls.some((call) => call.text.startsWith('DELETE FROM raw.sycm_rows')));
  assert.equal(client.calls.some((call) => call.text === 'COMMIT'), false);
});

test('write check rolls back after a failed probe and reports zero residue', async () => {
  const client = writeCheckClient({ failOnRawInsert: true });
  await assert.rejects(
    () => checkDatabaseWriteAccess(client),
    /permission denied for table sycm_rows；事务已回滚，残留记录 0 条/,
  );
  assert.ok(client.calls.some((call) => call.text === 'ROLLBACK'));
  assert.equal(client.calls.some((call) => call.text === 'COMMIT'), false);
});

test('builds a parameterized business query from cataloged fields', async () => {
  const calls = [];
  const client = {
    async query(text, values) {
      calls.push({ text, values });
      if (text.includes('FROM meta.dataset_fields')) return {
        rows: [
          { field_name: '支付金额', default_aggregation: 'sum' },
          { field_name: '支付转化率', default_aggregation: 'avg' },
        ],
      };
      return { rowCount: 1, rows: [{ 商品ID: '1', 支付金额: '100' }] };
    },
  };
  const result = await queryBusinessData(client, {
    dataset: '商品-整体', metrics: '支付金额,支付转化率', groupBy: 'item',
    startDate: '2026-08-01', endDate: '2026-08-20', itemIds: '1,2', limit: 10,
  });
  assert.equal(result.rowCount, 1);
  assert.deepEqual(result.metrics, [
    { name: '支付金额', aggregation: 'sum' },
    { name: '支付转化率', aggregation: 'avg' },
  ]);
  assert.match(calls[1].text, /dataset_key=\$1/);
  assert.match(calls[1].text, /item_id = ANY\(\$4::text\[\]\)/);
  assert.deepEqual(calls[1].values.slice(0, 4), ['item-overall', '2026-08-01', '2026-08-20', ['1', '2']]);
});

test('groups old item traffic-source data by its source identity columns', async () => {
  const calls = [];
  const client = {
    async query(text, values) {
      calls.push({ text, values });
      if (text.includes('FROM meta.dataset_fields')) return {
        rows: [{ field_name: '支付金额', default_aggregation: 'sum' }],
      };
      return { rowCount: 1, rows: [{ 流量来源: '淘宝搜索', 支付金额: '100' }] };
    },
  };
  const result = await queryBusinessData(client, {
    dataset: '商品-流量来源', metrics: '支付金额', groupBy: 'traffic-source', limit: 10,
  });
  assert.equal(result.datasetKey, 'item-traffic-source');
  assert.match(calls[1].text, /row_data ->> '一级流量来源'\) AS "一级流量来源"/);
  assert.match(calls[1].text, /row_data ->> '三级流量来源'/);
  assert.match(calls[1].text, /traffic_source_level,attribution_principle/);
});

test('groups and filters item traffic-source detail by search term', async () => {
  const calls = [];
  const client = {
    async query(text, values) {
      calls.push({ text, values });
      if (text.includes('FROM meta.dataset_fields')) return {
        rows: [{ field_name: '支付金额', default_aggregation: 'sum' }],
      };
      return { rowCount: 1, rows: [{ 搜索词类型: '手淘搜索', 搜索词: '烤肉盘', 支付金额: '100' }] };
    },
  };
  const result = await queryBusinessData(client, {
    dataset: '商品-流量来源详情', metrics: '支付金额', groupBy: 'search-term', keyword: '烤肉', limit: 10,
  });
  assert.equal(result.datasetKey, 'item-traffic-source-detail');
  assert.match(calls[1].text, /search_source AS "搜索词类型"/);
  assert.match(calls[1].text, /search_term ILIKE \$2/);
  assert.equal(calls[1].values[1], '%烤肉%');
});
