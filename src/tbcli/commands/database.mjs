import fsp from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import {
  connectDatabase,
  checkDatabaseReadOnlyAccess,
  checkDatabaseMaintainerAccess,
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
import {
  createReaderCredentialBundle,
  readReaderCredentialBundle,
  serializeReaderPgpass,
} from '../credential-bundle.mjs';

function printResult(value, json) {
  console.log(json ? JSON.stringify(value, null, 2) : JSON.stringify(value, null, 2));
}

async function readStdinSecret() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8').replace(/[\r\n]+$/, '');
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
  for (const key of ['host', 'database', 'ingestUser']) {
    if (!args[key]) throw new Error(`缺少 --${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`);
  }
  const pgpassFile = await validateDatabaseCredentialFile(args.pgpassFile);
  const config = {
    version: 2,
    accessMode: 'maintainer',
    host: args.host,
    port: Number(args.port || 5432),
    database: args.database,
    // Kept for backwards-compatible config shape; maintainer reads use ingestUser.
    readerUser: args.readerUser || args.ingestUser,
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

function backupSuffix() {
  return new Date().toISOString().replace(/\D/g, '').slice(0, 17);
}

async function pathExists(file) {
  try { await fsp.stat(file); return true; } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function verifyReaderConfig(configPath) {
  const config = await loadDatabaseConfig(configPath);
  if (config.accessMode !== 'read-only') throw new Error('当前配置不是员工只读配置');
  const client = await connectDatabase(config, 'reader');
  try { return { config, access: await checkDatabaseReadOnlyAccess(client) }; }
  finally { await client.end(); }
}

export async function runDatabaseCredentialBundleCreate(args) {
  if (!args.out) throw new Error('缺少 --out；请指定加密只读凭证文件的输出路径');
  for (const key of ['host', 'database', 'readerUser']) {
    if (!args[key]) throw new Error(`缺少 --${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`);
  }
  if (Boolean(args.pgpassFile) === Boolean(args.passwordStdin)) {
    throw new Error('必须且只能使用 --pgpass-file 或 --password-stdin 提供只读密码来源');
  }
  const out = path.resolve(args.out);
  if (await pathExists(out)) throw new Error(`输出文件已存在，拒绝覆盖：${out}`);
  const bundle = await createReaderCredentialBundle({
    pgpassFile: args.pgpassFile,
    password: args.passwordStdin ? await readStdinSecret() : undefined,
    host: args.host,
    port: Number(args.port || 5432),
    database: args.database,
    readerUser: args.readerUser,
  });
  await fsp.mkdir(path.dirname(out), { recursive: true });
  await fsp.writeFile(out, `${JSON.stringify(bundle, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await fsp.chmod(out, 0o600);
  printResult({ created: true, credentialFile: out, accessMode: 'read-only', readerUser: args.readerUser }, args.json);
}

export async function runDatabaseSetupReader(args) {
  if (!args.credentialFile) throw new Error('缺少 --credential-file；请指定从公司内部文档下载的加密密码文件');
  const configPath = path.resolve(args.config || process.env.TBCLI_DB_CONFIG || DEFAULT_DATABASE_CONFIG);
  if (await pathExists(configPath)) {
    let raw;
    try { raw = JSON.parse(await fsp.readFile(configPath, 'utf8')); } catch { raw = null; }
    if ((raw?.accessMode || 'maintainer') === 'maintainer') {
      throw new Error('检测到维护者配置；为保护写入权限，setup-reader 不会替换它');
    }
    try {
      const current = await verifyReaderConfig(configPath);
      printResult({ action: 'unchanged', configured: true, connected: true, accessMode: 'read-only',
        configPath, pgpassFile: current.config.pgpassFile, ...current.access }, args.json);
      return;
    } catch {
      // Broken read-only settings are backed up and repaired from the approved bundle below.
    }
  }

  const { bundlePath, payload } = await readReaderCredentialBundle(args.credentialFile);
  const pgpassFile = path.join(path.dirname(configPath), 'pgpass');
  resolveDatabaseCredentialPath(pgpassFile);
  const config = {
    version: 2,
    accessMode: 'read-only',
    host: payload.host,
    port: payload.port,
    database: payload.database,
    readerUser: payload.readerUser,
    ingestUser: payload.readerUser,
    pgpassFile,
  };
  await fsp.mkdir(path.dirname(configPath), { recursive: true });
  const suffix = backupSuffix();
  const backups = [];
  for (const file of [...new Set([configPath, pgpassFile])]) {
    if (await pathExists(file)) {
      const backup = `${file}.backup-${suffix}`;
      await fsp.copyFile(file, backup, fsConstants.COPYFILE_EXCL);
      await fsp.chmod(backup, 0o600);
      backups.push({ file, backup });
    }
  }
  try {
    await fsp.writeFile(pgpassFile, serializeReaderPgpass(payload), { encoding: 'utf8', mode: 0o600 });
    await fsp.chmod(pgpassFile, 0o600);
    await fsp.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await fsp.chmod(configPath, 0o600);
    const verified = await verifyReaderConfig(configPath);
    printResult({ action: backups.length ? 'repaired' : 'configured', configured: true, connected: true,
      accessMode: 'read-only', configPath, pgpassFile, credentialFile: bundlePath,
      backups: backups.map(({ backup }) => backup), ...verified.access }, args.json);
  } catch (error) {
    for (const file of [...new Set([configPath, pgpassFile])]) {
      const entry = backups.find((candidate) => candidate.file === file);
      if (entry) await fsp.copyFile(entry.backup, file);
      else await fsp.rm(file, { force: true });
    }
    throw new Error(`只读凭证配置失败，已恢复原配置：${error.message}`);
  }
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
    const result = config.accessMode === 'maintainer'
      ? await checkDatabaseMaintainerAccess(client)
      : await checkDatabaseReadOnlyAccess(client);
    printResult({ connected: true, accessMode: config.accessMode, host: config.host, port: config.port, ...result }, args.json);
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
