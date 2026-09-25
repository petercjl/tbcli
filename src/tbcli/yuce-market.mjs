import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readXlsxFile from 'read-excel-file/node';

const HEADERS = Object.freeze({
  1: ['月份', '一级类目', '成交额（原始值）', '成交额（展示值）', '成交额环比（原始值）', '成交额环比（展示值）', '成交量（原始值）', '成交量（展示值）', '成交量环比（原始值）', '成交量环比（展示值）'],
  2: ['月份', '一级类目', '二级类目', '总成交额（原始值）', '总成交额（展示值）', '成交额环比（原始值）', '成交额环比（展示值）', '是否有三级类目'],
  3: ['月份', '一级类目', '二级类目', '三级类目', '总成交额（原始值）', '总成交额（展示值）', '成交额环比（原始值）', '成交额环比（展示值）'],
});
const SHEETS = Object.freeze({ 1: '一级类目月数据', 2: '二级类目月数据', 3: '三级类目月数据' });

function requiredText(value) {
  return typeof value === 'string' ? value.trim() : String(value ?? '').trim();
}

function numeric(value, label, rowNumber, { required = false, integer = false, nonnegative = false } = {}) {
  if (value === null || value === undefined || value === '') {
    if (required) throw new Error(`第 ${rowNumber} 行缺少${label}`);
    return null;
  }
  const number = typeof value === 'number' ? value : Number(String(value).replace(/,/g, ''));
  if (!Number.isFinite(number) || (integer && !Number.isSafeInteger(number)) || (nonnegative && number < 0)) {
    throw new Error(`第 ${rowNumber} 行${label}不是有效数值`);
  }
  return number;
}

function monthDate(value, rowNumber) {
  const month = requiredText(value);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error(`第 ${rowNumber} 行月份无效：${month}`);
  return month;
}

function key(parts) { return JSON.stringify(parts); }

export async function validateYuceCategoryWorkbook(input) {
  if (!input) throw new Error('缺少 --input');
  const file = path.resolve(input);
  const stat = await fsp.stat(file);
  if (!stat.isFile()) throw new Error(`预策类目路径不是文件：${file}`);
  const bytes = await fsp.readFile(file);
  const sheets = await readXlsxFile(bytes);
  if (sheets.length !== 1) throw new Error('预策类目文件必须只有一张数据工作表');
  const sheet = sheets[0];
  const level = Number(Object.keys(SHEETS).find((candidate) => SHEETS[candidate] === sheet.sheet));
  if (!level) throw new Error(`未知的预策类目工作表：${sheet.sheet}`);
  const headers = HEADERS[level];
  const actual = sheet.data[0].map(requiredText);
  if (JSON.stringify(actual) !== JSON.stringify(headers)) throw new Error(`预策类目表头与${SHEETS[level]}不符`);
  const rows = [];
  const seen = new Set();
  const months = new Set();
  const categories = new Set();
  for (let rowNumber = 2; rowNumber <= sheet.data.length; rowNumber += 1) {
    const values = sheet.data[rowNumber - 1];
    if (values.every((value) => value === null || value === undefined || value === '')) continue;
    const raw = Object.fromEntries(headers.map((header, index) => [header, values[index]]));
    const month = monthDate(raw['月份'], rowNumber);
    const names = [requiredText(raw['一级类目'])];
    if (level >= 2) names.push(requiredText(raw['二级类目']));
    if (level >= 3) names.push(requiredText(raw['三级类目']));
    if (names.some((name) => !name)) throw new Error(`第 ${rowNumber} 行类目名称缺失`);
    const categoryKey = key(names);
    const rowKey = key([month, ...names]);
    if (seen.has(rowKey)) throw new Error(`第 ${rowNumber} 行类目月份重复：${month} ${names.join(' / ')}`);
    seen.add(rowKey);
    const amount = numeric(raw[level === 1 ? '成交额（原始值）' : '总成交额（原始值）'], '成交额', rowNumber, { required: true, nonnegative: true });
    const amountMom = numeric(raw['成交额环比（原始值）'], '成交额环比', rowNumber);
    const volume = level === 1 ? numeric(raw['成交量（原始值）'], '成交量', rowNumber, { integer: true, nonnegative: true }) : null;
    const volumeMom = level === 1 ? numeric(raw['成交量环比（原始值）'], '成交量环比', rowNumber) : null;
    months.add(month);
    categories.add(categoryKey);
    rows.push({ month, names, categoryKey, parentKey: level === 1 ? null : key(names.slice(0, -1)), amount, amountMom, volume, volumeMom,
      volumeStatus: level !== 1 ? 'not_collected' : volume === 0 && amount > 0 ? 'suspect_missing' : volume === null ? 'not_collected' : 'reported',
      sourceRow: rowNumber, raw });
  }
  if (!rows.length) throw new Error('预策类目文件没有数据行');
  const sortedMonths = [...months].sort();
  return { ok: true, file, sourceFile: path.basename(file), fileSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    worksheet: sheet.sheet, level, rowCount: rows.length, categoryCount: categories.size,
    minMonth: sortedMonths[0], maxMonth: sortedMonths.at(-1), months: sortedMonths,
    suspectVolumeRows: rows.filter((row) => row.volumeStatus === 'suspect_missing').length, rows };
}

export function yuceValidationSummary(result) {
  const { ok, sourceFile, fileSha256, worksheet, level, rowCount, categoryCount, minMonth, maxMonth, months, suspectVolumeRows } = result;
  return { ok, sourceFile, fileSha256, worksheet, level, rowCount, categoryCount, minMonth, maxMonth, months, suspectVolumeRows };
}

export async function ensureYuceMarketSchema(client) {
  await client.query(`
    CREATE SCHEMA IF NOT EXISTS market;
    CREATE TABLE IF NOT EXISTS market.yuce_categories (
      category_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      category_key text NOT NULL UNIQUE,
      category_level smallint NOT NULL CHECK (category_level BETWEEN 1 AND 3),
      category_name text NOT NULL,
      parent_id bigint REFERENCES market.yuce_categories(category_id),
      CHECK ((category_level = 1 AND parent_id IS NULL) OR (category_level > 1 AND parent_id IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS yuce_categories_parent_idx ON market.yuce_categories(parent_id);
    CREATE TABLE IF NOT EXISTS market.yuce_import_batches (
      batch_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      source_sha256 text NOT NULL UNIQUE,
      source_file text NOT NULL,
      category_level smallint NOT NULL,
      min_month date NOT NULL,
      max_month date NOT NULL,
      row_count integer NOT NULL,
      imported_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS market.yuce_category_monthly (
      category_id bigint NOT NULL REFERENCES market.yuce_categories(category_id),
      stat_month date NOT NULL CHECK (EXTRACT(DAY FROM stat_month) = 1),
      transaction_amount numeric(22,2) NOT NULL CHECK (transaction_amount >= 0),
      transaction_amount_mom numeric(14,8),
      transaction_volume bigint CHECK (transaction_volume >= 0),
      transaction_volume_mom numeric(14,8),
      volume_status text NOT NULL CHECK (volume_status IN ('reported','suspect_missing','not_collected')),
      source_batch_id bigint NOT NULL REFERENCES market.yuce_import_batches(batch_id),
      source_row integer NOT NULL,
      source_data jsonb NOT NULL,
      PRIMARY KEY(category_id,stat_month)
    );
    CREATE INDEX IF NOT EXISTS yuce_category_monthly_date_idx ON market.yuce_category_monthly(stat_month,category_id);
    CREATE TABLE IF NOT EXISTS market.yuce_ranking_snapshots (
      snapshot_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      category_id bigint NOT NULL REFERENCES market.yuce_categories(category_id),
      ranking_kind text NOT NULL CHECK (ranking_kind IN ('product','shop')),
      period_start date NOT NULL,
      period_end date NOT NULL CHECK (period_end >= period_start),
      ranking_scope jsonb NOT NULL DEFAULT '{}'::jsonb,
      source_sha256 text NOT NULL UNIQUE,
      captured_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS market.yuce_product_rank_rows (
      snapshot_id bigint NOT NULL REFERENCES market.yuce_ranking_snapshots(snapshot_id),
      rank_number integer NOT NULL CHECK (rank_number > 0),
      product_id text,
      product_name text,
      source_data jsonb NOT NULL,
      PRIMARY KEY(snapshot_id,rank_number)
    );
    CREATE TABLE IF NOT EXISTS market.yuce_shop_rank_rows (
      snapshot_id bigint NOT NULL REFERENCES market.yuce_ranking_snapshots(snapshot_id),
      rank_number integer NOT NULL CHECK (rank_number > 0),
      shop_id text,
      shop_name text,
      source_data jsonb NOT NULL,
      PRIMARY KEY(snapshot_id,rank_number)
    );
  `);
}

export async function importYuceCategoryWorkbook(client, validation, { mode = 'append' } = {}) {
  if (!validation?.ok) throw new Error('预策类目文件尚未通过校验');
  if (!['append', 'upsert'].includes(mode)) throw new Error('预策类目导入模式仅支持 append 或 upsert');
  await client.query('BEGIN');
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('tbcli:yuce-category-import'))");
    await ensureYuceMarketSchema(client);
    const prior = await client.query('SELECT batch_id FROM market.yuce_import_batches WHERE source_sha256=$1', [validation.fileSha256]);
    if (prior.rowCount) {
      await client.query('COMMIT');
      return { status: 'skipped', reason: 'same_file', ...yuceValidationSummary(validation) };
    }
    const batch = await client.query(`INSERT INTO market.yuce_import_batches(source_sha256,source_file,category_level,min_month,max_month,row_count)
      VALUES($1,$2,$3,$4,$5,$6) RETURNING batch_id`, [validation.fileSha256, validation.sourceFile, validation.level,
      `${validation.minMonth}-01`, `${validation.maxMonth}-01`, validation.rowCount]);
    const batchId = batch.rows[0].batch_id;
    const categoryIds = new Map();
    let inserted = 0;
    let updated = 0;
    for (const row of validation.rows) {
      let parentId = null;
      if (row.parentKey) {
        const parent = await client.query('SELECT category_id,category_level FROM market.yuce_categories WHERE category_key=$1', [row.parentKey]);
        if (!parent.rowCount || Number(parent.rows[0].category_level) !== validation.level - 1) throw new Error(`父类目尚未入库：${row.names.slice(0, -1).join(' / ')}`);
        parentId = parent.rows[0].category_id;
      }
      let categoryId = categoryIds.get(row.categoryKey);
      if (!categoryId) {
        const category = await client.query(`INSERT INTO market.yuce_categories(category_key,category_level,category_name,parent_id)
          VALUES($1,$2,$3,$4) ON CONFLICT(category_key) DO UPDATE SET category_key=excluded.category_key
          RETURNING category_id,category_level,parent_id`, [row.categoryKey, validation.level, row.names.at(-1), parentId]);
        if (Number(category.rows[0].category_level) !== validation.level || String(category.rows[0].parent_id ?? '') !== String(parentId ?? '')) {
          throw new Error(`类目层级冲突：${row.names.join(' / ')}`);
        }
        categoryId = category.rows[0].category_id;
        categoryIds.set(row.categoryKey, categoryId);
      }
      const existing = await client.query('SELECT 1 FROM market.yuce_category_monthly WHERE category_id=$1 AND stat_month=$2', [categoryId, `${row.month}-01`]);
      if (existing.rowCount && mode === 'append') throw new Error(`类目月份已存在；如需修订请明确使用 --mode upsert：${row.month} ${row.names.join(' / ')}`);
      await client.query(`INSERT INTO market.yuce_category_monthly(category_id,stat_month,transaction_amount,transaction_amount_mom,
        transaction_volume,transaction_volume_mom,volume_status,source_batch_id,source_row,source_data)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
        ON CONFLICT(category_id,stat_month) DO UPDATE SET transaction_amount=excluded.transaction_amount,
        transaction_amount_mom=excluded.transaction_amount_mom,transaction_volume=excluded.transaction_volume,
        transaction_volume_mom=excluded.transaction_volume_mom,volume_status=excluded.volume_status,
        source_batch_id=excluded.source_batch_id,source_row=excluded.source_row,source_data=excluded.source_data`,
      [categoryId, `${row.month}-01`, row.amount, row.amountMom, row.volume, row.volumeMom, row.volumeStatus,
        batchId, row.sourceRow, JSON.stringify(row.raw)]);
      if (existing.rowCount) updated += 1;
      else inserted += 1;
    }
    await client.query('COMMIT');
    return { status: 'imported', mode, batchId, inserted, updated, ...yuceValidationSummary(validation) };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

export async function getYuceMarketStatus(client) {
  const exists = await client.query("SELECT to_regclass('market.yuce_categories') IS NOT NULL AS exists");
  if (!exists.rows[0].exists) return { initialized: false };
  const levels = await client.query(`SELECT c.category_level,COUNT(DISTINCT c.category_id)::int AS categories,
    COUNT(m.*)::int AS monthly_rows,MIN(m.stat_month)::text AS min_month,MAX(m.stat_month)::text AS max_month
    FROM market.yuce_categories c LEFT JOIN market.yuce_category_monthly m USING(category_id)
    GROUP BY c.category_level ORDER BY c.category_level`);
  const batches = await client.query('SELECT COUNT(*)::int AS count FROM market.yuce_import_batches');
  const rankings = await client.query(`SELECT (SELECT COUNT(*) FROM market.yuce_product_rank_rows)::int AS product_rows,
    (SELECT COUNT(*) FROM market.yuce_shop_rank_rows)::int AS shop_rows`);
  const reconciliation = await client.query(`WITH rollup AS (
      SELECT p.stat_month,p.category_id,p.transaction_amount AS parent_amount,
        SUM(ch.transaction_amount) AS child_amount,COUNT(*) AS child_count
      FROM market.yuce_category_monthly p
      JOIN market.yuce_categories cc ON cc.parent_id=p.category_id
      JOIN market.yuce_category_monthly ch ON ch.category_id=cc.category_id AND ch.stat_month=p.stat_month
      GROUP BY p.stat_month,p.category_id,p.transaction_amount
    ), differences AS (
      SELECT *,ABS(parent_amount-child_amount) AS absolute_difference,
        (child_count+1)*0.005::numeric AS rounding_tolerance FROM rollup
    ) SELECT COUNT(*)::int AS compared_pairs,MAX(absolute_difference) AS max_absolute_difference,
      COUNT(*) FILTER (WHERE absolute_difference > rounding_tolerance)::int AS mismatch_count
      FROM differences`);
  const mismatches = await client.query(`WITH rollup AS (
      SELECT p.stat_month,p.category_id,p.transaction_amount AS parent_amount,
        SUM(ch.transaction_amount) AS child_amount,COUNT(*) AS child_count
      FROM market.yuce_category_monthly p
      JOIN market.yuce_categories cc ON cc.parent_id=p.category_id
      JOIN market.yuce_category_monthly ch ON ch.category_id=cc.category_id AND ch.stat_month=p.stat_month
      GROUP BY p.stat_month,p.category_id,p.transaction_amount
    ) SELECT stat_month::text AS month,category_id AS parent_id,parent_amount,child_amount,child_count,
      ABS(parent_amount-child_amount) AS absolute_difference FROM rollup
      WHERE ABS(parent_amount-child_amount) > (child_count+1)*0.005::numeric
      ORDER BY stat_month,category_id LIMIT 20`);
  return { initialized: true, levels: levels.rows, importBatches: batches.rows[0].count,
    rankingRows: rankings.rows[0], reconciliation: reconciliation.rows[0], parentChildMismatchSample: mismatches.rows };
}
