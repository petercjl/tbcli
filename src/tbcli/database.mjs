import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from '@excel.js/exceljs';
import pg from 'pg';

const { Client } = pg;

export const DEFAULT_DATABASE_CONFIG = path.join(os.homedir(), '.config', 'tbcli', 'database.json');

const COMMON_DIMENSIONS = new Set([
  '统计日期', '店铺名称', '商品ID', '商品名称', '商品标题', '商品状态', 'SKU ID', 'SKU名称',
  '关键词', '关键词类型', '关联商品ID', '关联商品名称', '品牌名称', '一级类目名称',
  '二级类目名称', '叶子类目名称', '来源类型', '流量来源', '来源层级', '归属原则',
  '一级流量来源', '二级流量来源', '三级流量来源', '搜索词类型', '搜索词', '时间类型',
  '退款场景', '退款识别类型', '退款时间', '退款原因类型', '退款原因', '退款后状态',
  '流失商家ID', '流失商品ID',
]);

export const DATASET_DEFINITIONS = Object.freeze([
  {
    key: 'shop-overall',
    name: '店铺-整体',
    platform: '生意参谋',
    dataType: '店铺',
    dataDimension: '整体',
    grain: 'day',
    pattern: /^店铺-整体-全部历史-分日-所有终端-.*\.xlsx$/i,
    defaultMetrics: ['支付金额', '访客数', '支付买家数'],
    requiredHeaders: ['统计日期', '店铺名称'],
  },
  {
    key: 'shop-keyword',
    name: '店铺-关键词',
    platform: '生意参谋',
    dataType: '店铺',
    dataDimension: '关键词',
    grain: 'day',
    pattern: /^店铺-关键词-分日-全部分词类型-.*\.xlsx$/i,
    defaultMetrics: ['访客数', '支付金额', '引导支付件数'],
    requiredHeaders: ['统计日期', '店铺名称', '关键词'],
  },
  {
    key: 'item-overall',
    name: '商品-整体',
    platform: '生意参谋',
    dataType: '商品',
    dataDimension: '整体',
    grain: 'day',
    pattern: /^商品-整体-分日-全部商品状态-所有终端汇总-.*\.xlsx$/i,
    defaultMetrics: ['支付金额', '商品访客数', '支付件数'],
    requiredHeaders: ['统计日期', '店铺名称', '商品ID'],
  },
  {
    key: 'item-sku',
    name: '商品-SKU',
    platform: '生意参谋',
    dataType: '商品',
    dataDimension: 'SKU',
    grain: 'day',
    pattern: /^商品-SKU-分日-全部SKU-所有终端汇总-.*\.xlsx$/i,
    defaultMetrics: ['支付金额', '支付件数', '加购件数'],
    requiredHeaders: ['统计日期', '店铺名称', '商品ID', 'SKU ID'],
  },
  {
    key: 'item-roi',
    name: '商品-经营投产比',
    platform: '生意参谋',
    dataType: '商品',
    dataDimension: '经营投产比',
    grain: 'day',
    pattern: /^商品-经营投产比-分日-全部商品状态-.*\.xlsx$/i,
    defaultMetrics: ['支付金额', '推广消耗金额', '推广引导总成交金额'],
    requiredHeaders: ['统计日期', '店铺名称', '商品ID'],
  },
  {
    key: 'item-bundle',
    name: '商品-连带',
    platform: '生意参谋',
    dataType: '商品',
    dataDimension: '连带',
    grain: 'week',
    pattern: /^商品-连带-分周-全部历史-.*\.xlsx$/i,
    defaultMetrics: ['支付金额', '支付件数', '关联商品的支付人数'],
    requiredHeaders: ['统计日期', '店铺名称', '商品ID', '关联商品ID'],
  },
  {
    key: 'item-traffic-source',
    name: '商品-流量来源',
    platform: '生意参谋',
    dataType: '商品',
    dataDimension: '流量来源',
    grain: 'day',
    pattern: /^商品-流量来源-分日-全部商品-最后一次访问来源-.*\.xlsx$/i,
    defaultMetrics: ['支付金额', '访客数', '支付买家数'],
    requiredHeaders: ['统计日期', '店铺名称', '商品ID', '来源层级', '归属原则'],
    requiredHeaderGroups: [
      ['来源类型', '流量来源'],
      ['一级流量来源', '二级流量来源', '三级流量来源'],
    ],
  },
  {
    key: 'item-traffic-source-detail',
    name: '商品-流量来源详情',
    platform: '生意参谋',
    dataType: '商品',
    dataDimension: '流量来源详情',
    grain: 'day',
    pattern: /^商品-流量来源详情-分日-全部搜索来源-全部商品-最后一次访问来源-.*\.xlsx$/i,
    defaultMetrics: ['支付金额', '访客数', '支付买家数'],
    requiredHeaders: ['统计日期', '店铺名称', '商品ID', '搜索词类型', '搜索词', '归属原则'],
  },
  {
    key: 'item-refund-overall',
    name: '商品-整体退款分布',
    platform: '生意参谋',
    dataType: '商品',
    dataDimension: '整体退款分布',
    grain: 'day',
    pattern: /^商品-整体退款分布-分日-全部商品-.*\.xlsx$/i,
    defaultMetrics: ['成功退款金额', '成功退款子订单数', '成功退款人数'],
    requiredHeaders: ['统计日期', '店铺名称', '商品ID', '商品名称', '时间类型', '成功退款金额', '成功退款子订单数'],
  },
  {
    key: 'item-refund-reason',
    name: '商品-退款原因分布',
    platform: '生意参谋',
    dataType: '商品',
    dataDimension: '退款原因分布',
    grain: 'day',
    pattern: /^商品-退款原因分布-分日-全部商品-全部时间类型-全部退款场景-全部退款时间-.*\.xlsx$/i,
    defaultMetrics: ['成功退款金额', '成功退款子订单数', '成功退款人数'],
    requiredHeaders: ['统计日期', '店铺名称', '商品ID', '商品名称', '时间类型', '退款场景', '退款时间', '退款原因', '成功退款金额'],
  },
  {
    key: 'item-loss-competitor',
    name: '商品-流失竞店分布',
    platform: '生意参谋',
    dataType: '商品',
    dataDimension: '流失竞店分布',
    grain: 'day',
    pattern: /^商品-流失竞店分布-分日-全部商品-全部时间类型-全部退款场景-全部退款后状态-.*\.xlsx$/i,
    defaultMetrics: ['竞品流失金额'],
    requiredHeaders: ['统计日期', '店铺名称', '商品ID', '商品标题', '时间类型', '退款场景', '退款后状态', '流失商家ID', '流失商品ID', '竞品流失金额'],
  },
  {
    key: 'item-refund-sku',
    name: '商品-退款SKU分布',
    platform: '生意参谋',
    dataType: '商品',
    dataDimension: '退款SKU分布',
    grain: 'day',
    pattern: /^商品-退款SKU分布-分日-全部商品-.*\.xlsx$/i,
    defaultMetrics: ['成功退款金额', '成功退款子订单数', '成功退款人数'],
    requiredHeaders: ['统计日期', '店铺名称', '商品ID', '商品名称', 'SKU ID', 'SKU名称', '时间类型', '成功退款金额', '成功退款子订单数'],
  },
]);

export function identifyDataset(fileName) {
  return DATASET_DEFINITIONS.find((entry) => entry.pattern.test(fileName)) || null;
}

export function resolveDataset(input) {
  const normalized = String(input || '').trim().toLowerCase();
  return DATASET_DEFINITIONS.find((entry) => entry.key === normalized || entry.name.toLowerCase() === normalized) || null;
}

export async function discoverImportFiles(inputPath, datasetInput = '') {
  const absolute = path.resolve(inputPath);
  const stat = await fsp.stat(absolute);
  const requested = datasetInput ? resolveDataset(datasetInput) : null;
  if (datasetInput && !requested) throw new Error(`未知数据集：${datasetInput}`);
  const isDirectory = stat.isDirectory();
  const candidates = isDirectory
    ? (await fsp.readdir(absolute)).filter((name) => name.toLowerCase().endsWith('.xlsx')).map((name) => path.join(absolute, name))
    : [absolute];
  const files = [];
  const ignored = [];
  for (const file of candidates.sort()) {
    const identified = identifyDataset(path.basename(file));
    const dataset = requested && !isDirectory ? requested : identified;
    if (!dataset || (requested && dataset.key !== requested.key)) ignored.push(file);
    else files.push({ file, dataset });
  }
  if (files.length === 0) throw new Error(isDirectory
    ? '目录中没有找到符合 tbcli 数据集命名规则的 Excel 文件'
    : '无法从文件名识别数据集；请显式传入 --dataset');
  return { files, ignored };
}

export async function loadDatabaseConfig(configPath = '') {
  const resolvedPath = path.resolve(configPath || process.env.TBCLI_DB_CONFIG || DEFAULT_DATABASE_CONFIG);
  const raw = JSON.parse(await fsp.readFile(resolvedPath, 'utf8'));
  const config = {
    version: raw.version || 1,
    host: process.env.TBCLI_DB_HOST || raw.host,
    port: Number(process.env.TBCLI_DB_PORT || raw.port || 5432),
    database: process.env.TBCLI_DB_NAME || raw.database,
    readerUser: process.env.TBCLI_DB_READER_USER || raw.readerUser,
    ingestUser: process.env.TBCLI_DB_INGEST_USER || raw.ingestUser,
    pgpassFile: path.resolve(process.env.TBCLI_DB_PGPASS || raw.pgpassFile || ''),
    configPath: resolvedPath,
  };
  for (const key of ['host', 'database', 'readerUser', 'ingestUser', 'pgpassFile']) {
    if (!config[key]) throw new Error(`数据库配置缺少 ${key}`);
  }
  return config;
}

function parsePgpassLine(line) {
  const values = [];
  let current = '';
  let escaped = false;
  for (const char of line) {
    if (escaped) {
      current += char;
      escaped = false;
    } else if (char === '\\') escaped = true;
    else if (char === ':') {
      values.push(current);
      current = '';
    } else current += char;
  }
  values.push(current);
  return values;
}

function pgpassMatches(value, expected) {
  return value === '*' || value === String(expected);
}

export async function readPgpassPassword(config, user) {
  if (process.env.TBCLI_DB_PASSWORD) return process.env.TBCLI_DB_PASSWORD;
  const stat = await fsp.stat(config.pgpassFile);
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw new Error(`数据库密码文件权限必须为 600：${config.pgpassFile}`);
  }
  const lines = (await fsp.readFile(config.pgpassFile, 'utf8')).split(/\r?\n/);
  for (const line of lines) {
    if (!line || line.startsWith('#')) continue;
    const [host, port, database, entryUser, password] = parsePgpassLine(line);
    if (password !== undefined
      && pgpassMatches(host, config.host)
      && pgpassMatches(port, config.port)
      && pgpassMatches(database, config.database)
      && pgpassMatches(entryUser, user)) return password;
  }
  throw new Error(`数据库密码文件中没有匹配 ${user}@${config.host}:${config.port}/${config.database} 的凭据`);
}

export async function connectDatabase(config, role = 'reader') {
  const user = role === 'ingest' ? config.ingestUser : config.readerUser;
  const password = await readPgpassPassword(config, user);
  const client = new Client({
    host: config.host,
    port: config.port,
    database: config.database,
    user,
    password,
    application_name: `tbcli-${role}`,
    connectionTimeoutMillis: 10000,
  });
  await client.connect();
  return client;
}

export async function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function unwrapExcelValue(value) {
  if (value == null) return null;
  if (value instanceof Date) return value;
  if (typeof value === 'object') {
    if ('result' in value) return unwrapExcelValue(value.result);
    if (Array.isArray(value.richText)) return value.richText.map((part) => part.text || '').join('');
    if ('text' in value) return value.text;
    if ('hyperlink' in value) return value.text || value.hyperlink;
  }
  return value;
}

function dateString(value) {
  const raw = unwrapExcelValue(value);
  if (raw instanceof Date) {
    const year = raw.getFullYear();
    const month = String(raw.getMonth() + 1).padStart(2, '0');
    const day = String(raw.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  const match = String(raw || '').trim().match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (!match) return null;
  return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
}

function normalizeValue(header, value) {
  const raw = unwrapExcelValue(value);
  if (raw == null || raw === '') return null;
  if (header === '统计日期') return dateString(raw);
  if (/ID$/i.test(header)) return String(raw).trim();
  if (typeof raw === 'number') return Number(raw.toFixed(10));
  if (typeof raw === 'boolean') return raw;
  const text = String(raw).trim();
  if (!text || /^(?:-|--|N\/A|null)$/i.test(text)) return null;
  const compact = text.replace(/,/g, '');
  const percent = compact.match(/^(-?\d+(?:\.\d+)?)%$/);
  if (percent) return Number(percent[1]) / 100;
  if (/^-?\d+(?:\.\d+)?$/.test(compact)) return Number(compact);
  return text;
}

function resolveTrafficSource(payload) {
  if (payload['流量来源'] != null) return payload['流量来源'];
  const level = Number(payload['来源层级']);
  const hierarchy = ['一级流量来源', '二级流量来源', '三级流量来源'];
  if (Number.isInteger(level) && level >= 1 && level <= hierarchy.length) {
    const value = payload[hierarchy[level - 1]];
    if (value != null) return value;
  }
  return payload['三级流量来源'] ?? payload['二级流量来源'] ?? payload['一级流量来源'];
}

export function defaultAggregation(fieldName) {
  return /(率|占比|ROI|CVR|CTR|CPC|CPM|客单价|UV价值|平均|评分|费比|成本|单价|时长)/i.test(fieldName) ? 'avg' : 'sum';
}

function quoteIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function quoteLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

export async function ensureWarehouseSchema(client) {
  await client.query(`
    CREATE SCHEMA IF NOT EXISTS raw;
    CREATE SCHEMA IF NOT EXISTS mart;
    CREATE SCHEMA IF NOT EXISTS meta;
    CREATE TABLE IF NOT EXISTS meta.datasets (
      dataset_key text PRIMARY KEY,
      platform text NOT NULL,
      data_type text NOT NULL,
      data_dimension text NOT NULL,
      grain text NOT NULL,
      source_path text,
      loaded_at timestamptz NOT NULL DEFAULT now(),
      min_date date,
      max_date date,
      row_count bigint NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS meta.dataset_fields (
      dataset_key text NOT NULL REFERENCES meta.datasets(dataset_key) ON DELETE CASCADE,
      field_name text NOT NULL,
      ordinal integer NOT NULL,
      field_kind text NOT NULL CHECK (field_kind IN ('dimension', 'metric')),
      default_aggregation text CHECK (default_aggregation IN ('sum', 'avg')),
      PRIMARY KEY (dataset_key, field_name)
    );
    CREATE TABLE IF NOT EXISTS meta.import_files (
      source_sha256 text PRIMARY KEY,
      dataset_key text NOT NULL REFERENCES meta.datasets(dataset_key),
      source_file text NOT NULL,
      row_count bigint NOT NULL,
      min_date date,
      max_date date,
      coverage_start date,
      coverage_end date,
      import_mode text NOT NULL DEFAULT 'append',
      imported_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS raw.sycm_rows (
      id bigserial PRIMARY KEY,
      dataset_key text NOT NULL REFERENCES meta.datasets(dataset_key),
      grain text NOT NULL,
      stat_date date NOT NULL,
      shop_name text,
      item_id text,
      item_name text,
      sku_id text,
      sku_name text,
      keyword text,
      keyword_type text,
      related_item_id text,
      related_item_name text,
      traffic_source_type text,
      traffic_source text,
      traffic_source_level text,
      attribution_principle text,
      search_source text,
      search_term text,
      row_data jsonb NOT NULL,
      source_file text NOT NULL,
      source_sha256 text NOT NULL,
      source_row integer NOT NULL,
      imported_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (source_sha256, source_row)
    );
    CREATE INDEX IF NOT EXISTS sycm_rows_dataset_date_idx ON raw.sycm_rows(dataset_key, stat_date);
    CREATE INDEX IF NOT EXISTS sycm_rows_dataset_item_date_idx ON raw.sycm_rows(dataset_key, item_id, stat_date);
    CREATE INDEX IF NOT EXISTS sycm_rows_dataset_sku_date_idx ON raw.sycm_rows(dataset_key, sku_id, stat_date);
    CREATE INDEX IF NOT EXISTS sycm_rows_dataset_keyword_date_idx ON raw.sycm_rows(dataset_key, keyword, stat_date);
    ALTER TABLE raw.sycm_rows ADD COLUMN IF NOT EXISTS traffic_source_type text;
    ALTER TABLE raw.sycm_rows ADD COLUMN IF NOT EXISTS traffic_source text;
    ALTER TABLE raw.sycm_rows ADD COLUMN IF NOT EXISTS traffic_source_level text;
    ALTER TABLE raw.sycm_rows ADD COLUMN IF NOT EXISTS attribution_principle text;
    ALTER TABLE raw.sycm_rows ADD COLUMN IF NOT EXISTS search_source text;
    ALTER TABLE raw.sycm_rows ADD COLUMN IF NOT EXISTS search_term text;
    CREATE INDEX IF NOT EXISTS sycm_rows_dataset_traffic_source_date_idx ON raw.sycm_rows(dataset_key, traffic_source, stat_date);
    CREATE INDEX IF NOT EXISTS sycm_rows_dataset_search_term_date_idx ON raw.sycm_rows(dataset_key, search_term, stat_date);
    ALTER TABLE meta.import_files ADD COLUMN IF NOT EXISTS coverage_start date;
    ALTER TABLE meta.import_files ADD COLUMN IF NOT EXISTS coverage_end date;
    ALTER TABLE meta.import_files ADD COLUMN IF NOT EXISTS import_mode text NOT NULL DEFAULT 'append';
    UPDATE meta.import_files SET coverage_start=coalesce(coverage_start,min_date),coverage_end=coalesce(coverage_end,max_date)
      WHERE coverage_start IS NULL OR coverage_end IS NULL;
  `);
}

function batchInsertSql(rows) {
  const columns = [
    'dataset_key', 'grain', 'stat_date', 'shop_name', 'item_id', 'item_name', 'sku_id', 'sku_name',
    'keyword', 'keyword_type', 'related_item_id', 'related_item_name', 'traffic_source_type',
    'traffic_source', 'traffic_source_level', 'attribution_principle', 'row_data', 'source_file',
    'search_source', 'search_term',
    'source_sha256', 'source_row',
  ];
  const values = [];
  const groups = rows.map((row, rowIndex) => {
    const start = rowIndex * columns.length;
    values.push(...columns.map((column) => row[column]));
    return `(${columns.map((_, columnIndex) => `$${start + columnIndex + 1}`).join(',')})`;
  });
  return {
    text: `INSERT INTO raw.sycm_rows (${columns.join(',')}) VALUES ${groups.join(',')} ON CONFLICT (source_sha256, source_row) DO NOTHING`,
    values,
  };
}

export async function importWorkbook(client, file, dataset, {
  batchSize = 250,
  reimport = false,
  mode = 'append',
  startDate = '',
  endDate = '',
} = {}) {
  if (!['append', 'replace-range', 'replace-all'].includes(mode)) {
    throw new Error(`不支持的导入模式：${mode}；可用 append,replace-range,replace-all`);
  }
  if (mode === 'replace-range' && (!dateString(startDate) || !dateString(endDate))) {
    throw new Error('replace-range 必须同时指定 --start-date 和 --end-date');
  }
  const requestedStart = dateString(startDate);
  const requestedEnd = dateString(endDate);
  if (requestedStart && requestedEnd && requestedStart > requestedEnd) throw new Error('导入开始日期不能晚于结束日期');
  const sourceSha256 = await sha256File(file);
  const prior = await client.query('SELECT row_count, min_date::text AS min_date, max_date::text AS max_date FROM meta.import_files WHERE source_sha256=$1', [sourceSha256]);
  if (prior.rowCount && !reimport && mode === 'append') return {
    status: 'skipped',
    dataset: dataset.name,
    datasetKey: dataset.key,
    file,
    sourceSha256,
    rows: Number(prior.rows[0].row_count),
    minDate: prior.rows[0].min_date,
    maxDate: prior.rows[0].max_date,
  };

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(file);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error(`Excel 没有工作表：${file}`);
  const headers = (sheet.getRow(1).values || []).slice(1).map((value) => String(unwrapExcelValue(value) || '').trim());
  if (!headers.includes('统计日期')) throw new Error(`Excel 缺少“统计日期”列：${file}`);
  if (headers.some((header) => !header)) throw new Error(`Excel 存在空表头：${file}`);
  if (new Set(headers).size !== headers.length) throw new Error(`Excel 存在重复表头：${file}`);
  const missingHeaders = dataset.requiredHeaders.filter((header) => !headers.includes(header));
  if (dataset.requiredHeaderGroups
    && !dataset.requiredHeaderGroups.some((group) => group.every((header) => headers.includes(header)))) {
    missingHeaders.push(`来源字段组合（${dataset.requiredHeaderGroups.map((group) => group.join('、')).join(' 或 ')}）`);
  }
  if (missingHeaders.length) throw new Error(`Excel 与数据集 ${dataset.name} 不匹配，缺少字段：${missingHeaders.join('、')}`);

  const parsedRows = [];
  let minDate = null;
  let maxDate = null;
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const payload = {};
    for (let index = 0; index < headers.length; index += 1) payload[headers[index]] = normalizeValue(headers[index], row.getCell(index + 1).value);
    const statDate = payload['统计日期'];
    if (!statDate) throw new Error(`第 ${rowNumber} 行缺少有效统计日期：${file}`);
    minDate = !minDate || statDate < minDate ? statDate : minDate;
    maxDate = !maxDate || statDate > maxDate ? statDate : maxDate;
    parsedRows.push({ rowNumber, payload, statDate });
  }
  if (!parsedRows.length && !(requestedStart && requestedEnd)) {
    throw new Error(`Excel 没有数据行；必须显式指定 --start-date 和 --end-date 才能登记空区间覆盖：${file}`);
  }
  if (!parsedRows.length && mode === 'replace-all') throw new Error('replace-all 拒绝用零行 Excel 清空整个数据集');
  const coverageStart = requestedStart || minDate;
  const coverageEnd = requestedEnd || maxDate;
  if (minDate && (minDate < coverageStart || maxDate > coverageEnd)) {
    throw new Error(`Excel 实际数据范围 ${minDate}~${maxDate} 超出声明导入范围 ${coverageStart}~${coverageEnd}`);
  }

  await client.query('BEGIN');
  try {
    const existingFields = await client.query('SELECT field_name FROM meta.dataset_fields WHERE dataset_key=$1 ORDER BY ordinal', [dataset.key]);
    if (mode !== 'replace-all' && existingFields.rowCount) {
      const current = existingFields.rows.map((row) => row.field_name);
      if (current.length !== headers.length || current.some((field, index) => field !== headers[index])) {
        throw new Error(`Excel 字段结构与 ${dataset.name} 当前仓库结构不一致；请先核对平台字段变化，确认后使用 --mode replace-all 全量重建`);
      }
    }
    if (mode === 'replace-all') {
      await client.query('DELETE FROM raw.sycm_rows WHERE dataset_key=$1', [dataset.key]);
      await client.query('DELETE FROM meta.import_files WHERE dataset_key=$1', [dataset.key]);
      await client.query('DELETE FROM meta.dataset_fields WHERE dataset_key=$1', [dataset.key]);
    } else if (mode === 'replace-range') {
      await client.query('DELETE FROM raw.sycm_rows WHERE dataset_key=$1 AND stat_date BETWEEN $2 AND $3', [dataset.key, coverageStart, coverageEnd]);
      if (prior.rowCount) await client.query('DELETE FROM meta.import_files WHERE source_sha256=$1', [sourceSha256]);
    } else if (prior.rowCount && reimport) {
      await client.query('DELETE FROM raw.sycm_rows WHERE source_sha256=$1', [sourceSha256]);
      await client.query('DELETE FROM meta.import_files WHERE source_sha256=$1', [sourceSha256]);
    }
    if (mode === 'append') {
      const overlap = await client.query('SELECT count(*)::int AS count FROM raw.sycm_rows WHERE dataset_key=$1 AND stat_date BETWEEN $2 AND $3', [dataset.key, coverageStart, coverageEnd]);
      if (Number(overlap.rows[0].count) > 0) {
        throw new Error(`append 与 ${dataset.name} 已有日期 ${coverageStart}~${coverageEnd} 重叠；请显式改用 --mode replace-range 并指定日期范围`);
      }
    }
    await client.query(`
      INSERT INTO meta.datasets(dataset_key, platform, data_type, data_dimension, grain, source_path, loaded_at)
      VALUES($1,$2,$3,$4,$5,$6,now())
      ON CONFLICT(dataset_key) DO UPDATE SET platform=excluded.platform,data_type=excluded.data_type,
        data_dimension=excluded.data_dimension,grain=excluded.grain,source_path=excluded.source_path,loaded_at=now()
    `, [dataset.key, dataset.platform, dataset.dataType, dataset.dataDimension, dataset.grain, path.dirname(file)]);
    for (let index = 0; index < headers.length; index += 1) {
      const fieldName = headers[index];
      const kind = COMMON_DIMENSIONS.has(fieldName) ? 'dimension' : 'metric';
      await client.query(`
        INSERT INTO meta.dataset_fields(dataset_key,field_name,ordinal,field_kind,default_aggregation)
        VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(dataset_key,field_name) DO UPDATE SET ordinal=excluded.ordinal,field_kind=excluded.field_kind,
          default_aggregation=excluded.default_aggregation
      `, [dataset.key, fieldName, index + 1, kind, kind === 'metric' ? defaultAggregation(fieldName) : null]);
    }

    let batch = [];
    let rowCount = 0;
    for (const { rowNumber, payload, statDate } of parsedRows) {
      batch.push({
        dataset_key: dataset.key,
        grain: dataset.grain,
        stat_date: statDate,
        shop_name: payload['店铺名称'],
        item_id: payload['商品ID'],
        item_name: payload['商品名称'] ?? payload['商品标题'],
        sku_id: payload['SKU ID'],
        sku_name: payload['SKU名称'],
        keyword: payload['关键词'],
        keyword_type: payload['关键词类型'],
        related_item_id: payload['关联商品ID'],
        related_item_name: payload['关联商品名称'],
        traffic_source_type: payload['来源类型'] ?? payload['一级流量来源'],
        traffic_source: resolveTrafficSource(payload),
        traffic_source_level: payload['来源层级'],
        attribution_principle: payload['归属原则'],
        search_source: payload['搜索词类型'],
        search_term: payload['搜索词'],
        row_data: JSON.stringify(payload),
        source_file: path.basename(file),
        source_sha256: sourceSha256,
        source_row: rowNumber,
      });
      rowCount += 1;
      if (batch.length >= batchSize) {
        await client.query(batchInsertSql(batch));
        batch = [];
      }
    }
    if (batch.length) await client.query(batchInsertSql(batch));
    await client.query(`
      INSERT INTO meta.import_files(source_sha256,dataset_key,source_file,row_count,min_date,max_date,coverage_start,coverage_end,import_mode)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
    `, [sourceSha256, dataset.key, path.basename(file), rowCount, minDate, maxDate, coverageStart, coverageEnd, mode]);
    await client.query(`
      UPDATE meta.datasets SET min_date=(SELECT min(stat_date) FROM raw.sycm_rows WHERE dataset_key=$1),
        max_date=(SELECT max(stat_date) FROM raw.sycm_rows WHERE dataset_key=$1),
        row_count=(SELECT count(*) FROM raw.sycm_rows WHERE dataset_key=$1),loaded_at=now()
      WHERE dataset_key=$1
    `, [dataset.key]);
    await client.query('COMMIT');
    return { status: 'imported', dataset: dataset.name, datasetKey: dataset.key, mode, file, sourceSha256, rows: rowCount, minDate, maxDate, coverageStart, coverageEnd, columns: headers.length };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

function addDays(value, days) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function compressDates(dates, stepDays) {
  if (!dates.length) return [];
  const periods = [];
  let start = dates[0];
  let end = dates[0];
  for (const value of dates.slice(1)) {
    if (value === addDays(end, stepDays)) end = value;
    else {
      periods.push({ startDate: start, endDate: end });
      start = value;
      end = value;
    }
  }
  periods.push({ startDate: start, endDate: end });
  return periods;
}

export async function getDatasetCoverage(client, datasetInput, options = {}) {
  const dataset = resolveDataset(datasetInput);
  if (!dataset) throw new Error(`未知数据集：${datasetInput}`);
  const state = await client.query(`
    SELECT min_date::text AS min_date,max_date::text AS max_date,row_count
    FROM meta.datasets WHERE dataset_key=$1
  `, [dataset.key]);
  if (!state.rowCount) throw new Error(`数据集尚未入库：${dataset.name}`);
  const available = state.rows[0];
  const startDate = dateString(options.startDate || available.min_date);
  const endDate = dateString(options.endDate || available.max_date);
  if (!startDate || !endDate || startDate > endDate) throw new Error('覆盖查询需要有效的开始和结束日期');
  const spans = await client.query(`
    SELECT coverage_start::text AS start_date,coverage_end::text AS end_date,import_mode
    FROM meta.import_files
    WHERE dataset_key=$1 AND coverage_start <= $3 AND coverage_end >= $2
    ORDER BY coverage_start,coverage_end
  `, [dataset.key, startDate, endDate]);
  const observed = await client.query(`
    SELECT DISTINCT stat_date::text AS stat_date FROM raw.sycm_rows
    WHERE dataset_key=$1 AND stat_date BETWEEN $2 AND $3 ORDER BY stat_date
  `, [dataset.key, startDate, endDate]);
  const observedSet = new Set(observed.rows.map((row) => row.stat_date));
  const stepDays = dataset.grain === 'week' ? 7 : 1;
  let cursor = startDate;
  if (dataset.grain === 'week' && available.min_date) {
    while (cursor <= endDate && new Date(`${cursor}T00:00:00Z`).getUTCDay() !== new Date(`${available.min_date}T00:00:00Z`).getUTCDay()) cursor = addDays(cursor, 1);
  }
  const expectedDates = [];
  while (cursor <= endDate) {
    expectedDates.push(cursor);
    cursor = addDays(cursor, stepDays);
  }
  const isCovered = (value) => observedSet.has(value) || spans.rows.some((span) => span.start_date <= value && span.end_date >= value);
  const coveredDates = expectedDates.filter(isCovered);
  const missingDates = expectedDates.filter((value) => !isCovered(value));
  return {
    dataset: dataset.name,
    datasetKey: dataset.key,
    grain: dataset.grain,
    availablePeriod: { startDate: available.min_date, endDate: available.max_date },
    requestedPeriod: { startDate, endDate },
    expectedPeriods: expectedDates.length,
    coveredPeriods: coveredDates.length,
    missingPeriods: compressDates(missingDates, stepDays),
    complete: missingDates.length === 0,
    coverageSources: spans.rows.map((span) => ({ startDate: span.start_date, endDate: span.end_date, mode: span.import_mode })),
  };
}

export async function listDatasets(client) {
  const result = await client.query(`
    SELECT d.dataset_key,d.data_type || '-' || d.data_dimension AS name,d.grain,
      d.min_date::text AS min_date,d.max_date::text AS max_date,d.row_count,
      count(f.field_name)::int AS field_count
    FROM meta.datasets d LEFT JOIN meta.dataset_fields f ON f.dataset_key=d.dataset_key
    GROUP BY d.dataset_key,d.data_type,d.data_dimension,d.grain,d.min_date,d.max_date,d.row_count
    ORDER BY d.dataset_key
  `);
  return result.rows;
}

export async function listDatasetFields(client, datasetInput) {
  const dataset = resolveDataset(datasetInput);
  if (!dataset) throw new Error(`未知数据集：${datasetInput}`);
  const result = await client.query(`
    SELECT field_name,field_kind,default_aggregation
    FROM meta.dataset_fields
    WHERE dataset_key=$1
    ORDER BY ordinal
  `, [dataset.key]);
  return {
    dataset: dataset.name,
    datasetKey: dataset.key,
    grain: dataset.grain,
    defaultMetrics: dataset.defaultMetrics,
    fields: result.rows.map((row) => ({
      name: row.field_name,
      kind: row.field_kind,
      aggregation: row.default_aggregation,
    })),
  };
}

export async function queryBusinessData(client, options) {
  const dataset = resolveDataset(options.dataset);
  if (!dataset) throw new Error(`未知数据集：${options.dataset}`);
  const requestedMetrics = String(options.metrics || dataset.defaultMetrics.join(','))
    .split(/[,，]/).map((value) => value.trim()).filter(Boolean);
  if (requestedMetrics.length === 0) throw new Error('至少指定一个业务指标');
  if (requestedMetrics.length > 12) throw new Error('单次最多查询 12 个指标');
  const catalog = await client.query(`
    SELECT field_name,default_aggregation FROM meta.dataset_fields
    WHERE dataset_key=$1 AND field_kind='metric'
  `, [dataset.key]);
  const fieldMap = new Map(catalog.rows.map((row) => [row.field_name, row.default_aggregation]));
  const unknown = requestedMetrics.filter((metric) => !fieldMap.has(metric));
  if (unknown.length) throw new Error(`数据集 ${dataset.name} 不含可聚合指标：${unknown.join('、')}`);

  const groupBy = options.groupBy || 'day';
  const groupDefinitions = {
    total: { select: [], group: [] },
    day: { select: ['stat_date::text AS "统计日期"'], group: ['stat_date'] },
    shop: { select: ['shop_name AS "店铺名称"'], group: ['shop_name'] },
    item: { select: ['item_id AS "商品ID"', 'max(item_name) AS "商品名称"'], group: ['item_id'] },
    sku: { select: ['item_id AS "商品ID"', 'max(item_name) AS "商品名称"', 'sku_id AS "SKU ID"', 'max(sku_name) AS "SKU名称"'], group: ['item_id', 'sku_id'] },
    keyword: { select: ['keyword AS "关键词"', 'keyword_type AS "关键词类型"'], group: ['keyword', 'keyword_type'] },
    'related-item': { select: ['item_id AS "商品ID"', 'max(item_name) AS "商品名称"', 'related_item_id AS "关联商品ID"', 'max(related_item_name) AS "关联商品名称"'], group: ['item_id', 'related_item_id'] },
    'traffic-source': {
      select: [
        `(row_data ->> '一级流量来源') AS "一级流量来源"`,
        `(row_data ->> '二级流量来源') AS "二级流量来源"`,
        `(row_data ->> '三级流量来源') AS "三级流量来源"`,
        'traffic_source_level AS "来源层级"',
        'attribution_principle AS "归属原则"',
      ],
      group: [
        `(row_data ->> '一级流量来源')`, `(row_data ->> '二级流量来源')`, `(row_data ->> '三级流量来源')`,
        'traffic_source_level', 'attribution_principle',
      ],
    },
    'search-term': {
      select: ['search_source AS "搜索词类型"', 'search_term AS "搜索词"', 'attribution_principle AS "归属原则"'],
      group: ['search_source', 'search_term', 'attribution_principle'],
    },
  };
  const grouping = groupDefinitions[groupBy];
  if (!grouping) throw new Error(`不支持的分组：${groupBy}；可用 total,day,shop,item,sku,keyword,related-item,traffic-source,search-term`);

  const metricExpressions = requestedMetrics.map((metric) => {
    const aggregation = fieldMap.get(metric) || 'sum';
    return `${aggregation}(CASE WHEN jsonb_typeof(row_data -> ${quoteLiteral(metric)})='number' THEN (row_data ->> ${quoteLiteral(metric)})::numeric END) AS ${quoteIdentifier(metric)}`;
  });
  const values = [dataset.key];
  const where = ['dataset_key=$1'];
  if (options.startDate) { values.push(options.startDate); where.push(`stat_date >= $${values.length}`); }
  if (options.endDate) { values.push(options.endDate); where.push(`stat_date <= $${values.length}`); }
  if (options.itemIds) {
    const ids = String(options.itemIds).split(/[,，\s]+/).map((value) => value.trim()).filter(Boolean);
    values.push(ids); where.push(`item_id = ANY($${values.length}::text[])`);
  }
  if (options.keyword) {
    values.push(`%${options.keyword}%`);
    where.push(`${dataset.key === 'item-traffic-source-detail' ? 'search_term' : 'keyword'} ILIKE $${values.length}`);
  }
  const selected = [...grouping.select, ...metricExpressions];
  const orderBy = options.orderBy || (groupBy === 'day' ? '统计日期' : requestedMetrics[0]);
  const allowedOrder = new Set([...requestedMetrics, ...grouping.select.map((part) => part.match(/AS "([^"]+)"$/)?.[1]).filter(Boolean)]);
  if (!allowedOrder.has(orderBy)) throw new Error(`排序字段不可用：${orderBy}`);
  const limit = Math.min(1000, Math.max(1, Number(options.limit || 100)));
  values.push(limit);
  const sql = `SELECT ${selected.join(',')} FROM raw.sycm_rows WHERE ${where.join(' AND ')}
    ${grouping.group.length ? `GROUP BY ${grouping.group.join(',')}` : ''}
    ORDER BY ${quoteIdentifier(orderBy)} ${options.orderDesc === false ? 'ASC' : 'DESC'} NULLS LAST LIMIT $${values.length}`;
  const result = await client.query(sql, values);
  return {
    dataset: dataset.name,
    datasetKey: dataset.key,
    grain: dataset.grain,
    period: { startDate: options.startDate || null, endDate: options.endDate || null },
    groupBy,
    metrics: requestedMetrics.map((metric) => ({ name: metric, aggregation: fieldMap.get(metric) })),
    rowCount: result.rowCount,
    rows: result.rows,
  };
}
