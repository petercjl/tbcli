import fsp from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import {
  connectDatabase,
  checkDatabaseWriteAccess,
  assertMaintainerAccess,
  DEFAULT_DATABASE_CONFIG,
  DEFAULT_DATABASE_PGPASS,
  discoverImportFiles,
  ensureWarehouseSchema,
  importWorkbook,
  getDatasetCoverage,
  listDatasetFields,
  listDatasets,
  loadDatabaseConfig,
  queryBusinessData,
  resolveDatabaseCredentialPath,
  validateDatabaseCredentialFile,
} from '../database.mjs';

function printResult(value, json) {
  console.log(json ? JSON.stringify(value, null, 2) : JSON.stringify(value, null, 2));
}

async function writeDatabaseConfig(configPath, config, json) {
  try {
    await fsp.stat(configPath);
    throw new Error(`配置文件已存在，拒绝覆盖：${configPath}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await fsp.mkdir(path.dirname(configPath), { recursive: true });
  await fsp.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await fsp.chmod(configPath, 0o600);
  printResult({ configured: true, configPath, ...config, pgpassFile: config.pgpassFile }, json);
}

export async function runDatabaseConfigure(args) {
  const configPath = path.resolve(args.config || process.env.TBCLI_DB_CONFIG || DEFAULT_DATABASE_CONFIG);
  for (const key of ['host', 'database', 'readerUser', 'ingestUser']) {
    if (!args[key]) throw new Error(`缺少 --${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`);
  }
  const pgpassFile = await validateDatabaseCredentialFile(args.pgpassFile);
  const config = {
    version: 2,
    accessMode: 'maintainer',
    host: args.host,
    port: Number(args.port || 5432),
    database: args.database,
    readerUser: args.readerUser,
    ingestUser: args.ingestUser,
    pgpassFile,
  };
  await writeDatabaseConfig(configPath, config, args.json);
}

export async function runDatabaseConfigureReader(args) {
  const configPath = path.resolve(args.config || process.env.TBCLI_DB_CONFIG || DEFAULT_DATABASE_CONFIG);
  for (const key of ['host', 'database', 'readerUser']) {
    if (!args[key]) throw new Error(`缺少 --${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`);
  }
  const pgpassFile = await validateDatabaseCredentialFile(args.pgpassFile);
  const config = {
    version: 2,
    accessMode: 'read-only',
    host: args.host,
    port: Number(args.port || 5432),
    database: args.database,
    readerUser: args.readerUser,
    // Keep the configuration structurally complete while preventing all writer commands below.
    ingestUser: args.readerUser,
    pgpassFile,
  };
  await writeDatabaseConfig(configPath, config, args.json);
}

export async function runDatabaseCredentialPath(args) {
  const configPath = path.resolve(args.config || process.env.TBCLI_DB_CONFIG || DEFAULT_DATABASE_CONFIG);
  let configuredPath = null;
  let configuredSafe = null;
  try {
    const raw = JSON.parse(await fsp.readFile(configPath, 'utf8'));
    if (raw.pgpassFile) {
      configuredPath = path.resolve(raw.pgpassFile);
      try {
        resolveDatabaseCredentialPath(configuredPath);
        configuredSafe = true;
      } catch {
        configuredSafe = false;
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  printResult({ recommendedPath: DEFAULT_DATABASE_PGPASS, configPath, configuredPath, configuredSafe }, args.json);
}

export async function runDatabaseCredentialSet(args) {
  if (!args.pgpassFile) throw new Error(`缺少 --pgpass-file；推荐稳定位置：${DEFAULT_DATABASE_PGPASS}`);
  const configPath = path.resolve(args.config || process.env.TBCLI_DB_CONFIG || DEFAULT_DATABASE_CONFIG);
  const pgpassFile = await validateDatabaseCredentialFile(args.pgpassFile);
  const raw = JSON.parse(await fsp.readFile(configPath, 'utf8'));
  const backupPath = `${configPath}.backup-${new Date().toISOString().replace(/\D/g, '').slice(0, 17)}`;
  await fsp.copyFile(configPath, backupPath, fsConstants.COPYFILE_EXCL);
  await fsp.chmod(backupPath, 0o600);
  const next = { ...raw, pgpassFile };
  await fsp.writeFile(configPath, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fsp.chmod(configPath, 0o600);
  printResult({ updated: true, configPath, backupPath, pgpassFile }, args.json);
}

export async function runDatabaseStatus(args) {
  const config = await loadDatabaseConfig(args.config);
  const client = await connectDatabase(config, 'reader');
  try {
    const server = await client.query(`SELECT current_database() AS database,current_user AS user,current_setting('server_version') AS version`);
    const datasets = await listDatasets(client).catch(() => []);
    printResult({ connected: true, accessMode: config.accessMode, host: config.host, port: config.port, ...server.rows[0], datasets: datasets.length }, args.json);
  } finally { await client.end(); }
}

export async function runDatabaseInit(args) {
  const config = await loadDatabaseConfig(args.config);
  assertMaintainerAccess(config);
  const client = await connectDatabase(config, 'ingest');
  try {
    await ensureWarehouseSchema(client);
    printResult({ initialized: true, database: config.database, host: config.host, port: config.port }, args.json);
  } finally { await client.end(); }
}

export async function runDatabaseImport(args) {
  if (!args.input) throw new Error('缺少 --input；请指定 Excel 文件或目录');
  const config = await loadDatabaseConfig(args.config);
  assertMaintainerAccess(config);
  const discovery = await discoverImportFiles(args.input, args.dataset);
  const mode = args.mode || 'append';
  if (mode !== 'append' && discovery.files.length !== 1) {
    throw new Error(`${mode} 每次只允许导入一个明确的数据集文件`);
  }
  const client = await connectDatabase(config, 'ingest');
  const results = [];
  try {
    await ensureWarehouseSchema(client);
    for (const entry of discovery.files) results.push(await importWorkbook(client, entry.file, entry.dataset, {
      reimport: args.reimport,
      mode,
      startDate: args.startDate,
      endDate: args.endDate,
    }));
    printResult({ input: path.resolve(args.input), matchedFiles: discovery.files.length, ignoredFiles: discovery.ignored.length, results }, args.json);
  } finally { await client.end(); }
}

export async function runDatabaseAccessCheck(args) {
  const config = await loadDatabaseConfig(args.config);
  const client = await connectDatabase(config, 'reader');
  try {
    const result = await client.query(`
      SELECT current_database() AS database,current_user AS user,
        has_database_privilege(current_user,current_database(),'CREATE') AS database_create,
        has_schema_privilege(current_user,'raw','CREATE') AS raw_create,
        has_schema_privilege(current_user,'mart','CREATE') AS mart_create,
        has_schema_privilege(current_user,'meta','CREATE') AS meta_create,
        count(*)::int AS tables_total,
        count(*) FILTER (WHERE has_table_privilege(current_user,format('%I.%I',schemaname,tablename),'SELECT'))::int AS tables_select,
        count(*) FILTER (WHERE has_table_privilege(current_user,format('%I.%I',schemaname,tablename),'INSERT'))::int AS tables_insert,
        count(*) FILTER (WHERE has_table_privilege(current_user,format('%I.%I',schemaname,tablename),'UPDATE'))::int AS tables_update,
        count(*) FILTER (WHERE has_table_privilege(current_user,format('%I.%I',schemaname,tablename),'DELETE'))::int AS tables_delete
      FROM pg_tables WHERE schemaname IN ('raw','mart','meta')
      GROUP BY current_database(),current_user
    `);
    const row = result.rows[0];
    const privileges = {
      databaseCreate: row.database_create,
      schemaCreate: { raw: row.raw_create, mart: row.mart_create, meta: row.meta_create },
      tables: { total: row.tables_total, select: row.tables_select, insert: row.tables_insert, update: row.tables_update, delete: row.tables_delete },
    };
    const readOnly = !privileges.databaseCreate
      && !Object.values(privileges.schemaCreate).some(Boolean)
      && !['insert', 'update', 'delete'].some((key) => Number(privileges.tables[key]) > 0);
    if (!readOnly) throw new Error('数据库只读权限检查失败：当前查询账号拥有写入或建库/建表权限，请停止使用并联系管理员');
    printResult({ connected: true, accessMode: config.accessMode, host: config.host, port: config.port, database: row.database, user: row.user, readOnly, privileges }, args.json);
  } finally { await client.end(); }
}

export async function runDatabaseWriteCheck(args) {
  const config = await loadDatabaseConfig(args.config);
  assertMaintainerAccess(config);
  const client = await connectDatabase(config, 'ingest');
  try {
    const result = await checkDatabaseWriteAccess(client);
    printResult({ accessMode: config.accessMode, host: config.host, port: config.port, ...result }, args.json);
  } finally { await client.end(); }
}

export async function runDatabaseCoverage(args) {
  if (!args.dataset) throw new Error('缺少 --dataset；例如 店铺-整体 或 item-overall');
  const config = await loadDatabaseConfig(args.config);
  const client = await connectDatabase(config, 'reader');
  try { printResult(await getDatasetCoverage(client, args.dataset, args), args.json); }
  finally { await client.end(); }
}

export async function runDatabaseDatasets(args) {
  const config = await loadDatabaseConfig(args.config);
  const client = await connectDatabase(config, 'reader');
  try { printResult({ datasets: await listDatasets(client) }, args.json); }
  finally { await client.end(); }
}

export async function runDatabaseFields(args) {
  if (!args.dataset) throw new Error('缺少 --dataset；例如 店铺-整体 或 item-overall');
  const config = await loadDatabaseConfig(args.config);
  const client = await connectDatabase(config, 'reader');
  try { printResult(await listDatasetFields(client, args.dataset), args.json); }
  finally { await client.end(); }
}

export async function runDatabaseQuery(args) {
  if (!args.dataset) throw new Error('缺少 --dataset；例如 店铺-整体 或 item-overall');
  const config = await loadDatabaseConfig(args.config);
  const client = await connectDatabase(config, 'reader');
  try { printResult(await queryBusinessData(client, args), args.json); }
  finally { await client.end(); }
}
