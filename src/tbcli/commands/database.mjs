import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  connectDatabase,
  DEFAULT_DATABASE_CONFIG,
  discoverImportFiles,
  ensureWarehouseSchema,
  importWorkbook,
  getDatasetCoverage,
  listDatasetFields,
  listDatasets,
  loadDatabaseConfig,
  queryBusinessData,
} from '../database.mjs';

function printResult(value, json) {
  console.log(json ? JSON.stringify(value, null, 2) : JSON.stringify(value, null, 2));
}

export async function runDatabaseConfigure(args) {
  const configPath = path.resolve(args.config || process.env.TBCLI_DB_CONFIG || DEFAULT_DATABASE_CONFIG);
  try {
    await fsp.stat(configPath);
    throw new Error(`配置文件已存在，拒绝覆盖：${configPath}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  for (const key of ['host', 'database', 'readerUser', 'ingestUser', 'pgpassFile']) {
    if (!args[key]) throw new Error(`缺少 --${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`);
  }
  const config = {
    version: 1,
    host: args.host,
    port: Number(args.port || 5432),
    database: args.database,
    readerUser: args.readerUser,
    ingestUser: args.ingestUser,
    pgpassFile: path.resolve(args.pgpassFile),
  };
  await fsp.mkdir(path.dirname(configPath), { recursive: true });
  await fsp.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await fsp.chmod(configPath, 0o600);
  printResult({ configured: true, configPath, ...config, pgpassFile: config.pgpassFile }, args.json);
}

export async function runDatabaseStatus(args) {
  const config = await loadDatabaseConfig(args.config);
  const client = await connectDatabase(config, 'reader');
  try {
    const server = await client.query(`SELECT current_database() AS database,current_user AS user,current_setting('server_version') AS version`);
    const datasets = await listDatasets(client).catch(() => []);
    printResult({ connected: true, host: config.host, port: config.port, ...server.rows[0], datasets: datasets.length }, args.json);
  } finally { await client.end(); }
}

export async function runDatabaseInit(args) {
  const config = await loadDatabaseConfig(args.config);
  const client = await connectDatabase(config, 'ingest');
  try {
    await ensureWarehouseSchema(client);
    printResult({ initialized: true, database: config.database, host: config.host, port: config.port }, args.json);
  } finally { await client.end(); }
}

export async function runDatabaseImport(args) {
  if (!args.input) throw new Error('缺少 --input；请指定 Excel 文件或目录');
  const config = await loadDatabaseConfig(args.config);
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
