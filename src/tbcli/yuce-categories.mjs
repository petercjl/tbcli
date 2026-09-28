import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

const KINDS = Object.freeze({
  'first-category-monthly': 1,
  'second-category-monthly': 2,
  'third-category-monthly': 3,
});

function categoryPath(row, level) {
  if (level === 1) return [row.firstCategory];
  return level === 2
    ? [row.firstCategory, row.secondCategory]
    : [row.firstCategory, row.secondCategory, row.thirdCategory];
}

function monthAfter(month) {
  const [year, value] = month.split('-').map(Number);
  return `${year + (value === 12 ? 1 : 0)}-${String(value === 12 ? 1 : value + 1).padStart(2, '0')}`;
}

function amountCents(value) {
  return Math.round(Number(value) * 100);
}

function momUnits(value) {
  return value == null ? null : Math.round(Number(value) * 1e8);
}

function sourceData(row, level) {
  const data = {
    月份: row.month,
    一级类目: row.firstCategory,
  };
  if (level >= 2) data.二级类目 = row.secondCategory;
  if (level === 3) data.三级类目 = row.thirdCategory;
  data[level === 1 ? '成交额（原始值）' : '总成交额（原始值）'] = row.transactionAmount;
  data[level === 1 ? '成交额（展示值）' : '总成交额（展示值）'] = row.transactionAmountDisplay;
  data['成交额环比（原始值）'] = row.transactionAmountMom;
  data['成交额环比（展示值）'] = row.transactionAmountMomDisplay;
  if (level === 1) {
    data['成交量（原始值）'] = row.transactionVolume;
    data['成交量（展示值）'] = row.transactionVolumeDisplay;
    data['成交量环比（原始值）'] = row.transactionVolumeMom;
    data['成交量环比（展示值）'] = row.transactionVolumeMomDisplay;
  }
  if (level === 2) data.是否有三级类目 = row.hasThirdCategory;
  return data;
}

export async function validateYuceCategoryJson(input) {
  if (!input) throw new Error('缺少 --input');
  const file = path.resolve(input);
  const stat = await fsp.stat(file);
  if (!stat.isFile() || path.extname(file).toLowerCase() !== '.json') {
    throw new Error('预策类目导入需要 yccli 导出的 JSON 文件');
  }
  const bytes = await fsp.readFile(file);
  const data = JSON.parse(bytes.toString('utf8'));
  const level = KINDS[data.kind];
  if (data.ok !== true || !level || !Array.isArray(data.months) || !Array.isArray(data.rows)) {
    throw new Error('预策类目 JSON 格式或任务类型不正确');
  }
  const months = data.months;
  if (months.length === 0 || months.some((month) => !/^\d{4}-(0[1-9]|1[0-2])$/.test(month))) {
    throw new Error('预策类目月份列表无效');
  }
  for (let index = 1; index < months.length; index += 1) {
    if (months[index] !== monthAfter(months[index - 1])) throw new Error('预策类目月份不连续');
  }
  const monthSet = new Set(months);
  const seen = new Set();
  const rows = data.rows.map((row, index) => {
    const names = categoryPath(row, level);
    if (!monthSet.has(row.month) || names.some((name) => typeof name !== 'string' || !name.trim())
      || row.firstCategory !== data.category || (level === 3 && row.secondCategory !== data.secondCategory)) {
      throw new Error(`预策类目第 ${index + 1} 行的月份或类目路径无效`);
    }
    if (!Number.isFinite(row.transactionAmount) || row.transactionAmount < 0
      || (row.transactionAmountMom != null && !Number.isFinite(row.transactionAmountMom))
      || (level === 1 && row.transactionVolume != null
        && (!Number.isSafeInteger(row.transactionVolume) || row.transactionVolume < 0))
      || (level === 1 && row.transactionVolumeMom != null && !Number.isFinite(row.transactionVolumeMom))) {
      throw new Error(`预策类目第 ${index + 1} 行的数值无效`);
    }
    const key = JSON.stringify([row.month, ...names]);
    if (seen.has(key)) throw new Error(`预策类目重复月份和路径：${key}`);
    seen.add(key);
    return { ...row, sourceRow: index + 2, names, categoryKey: JSON.stringify(names), sourceData: sourceData(row, level),
      volumeStatus: level !== 1 || row.transactionVolume == null ? 'not_collected'
        : row.transactionVolume === 0 && row.transactionAmount > 0 ? 'suspect_missing' : 'reported' };
  });
  if (rows.length === 0) throw new Error('预策类目 JSON 没有数据行');
  for (const month of months) {
    if (!rows.some((row) => row.month === month)) throw new Error(`预策类目缺少月份 ${month}`);
  }
  return {
    file,
    sourceFile: path.basename(file),
    sourceSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    level,
    category: data.category,
    secondCategory: data.secondCategory || null,
    months,
    rowCount: rows.length,
    categoryCount: new Set(rows.map((row) => row.categoryKey)).size,
    rows,
  };
}

export async function importYuceCategories(client, validation) {
  if (!validation?.rows?.length) throw new Error('预策类目文件尚未通过校验');
  await client.query('BEGIN');
  try {
    await client.query('LOCK TABLE market.yuce_categories, market.yuce_category_monthly, market.yuce_import_batches IN EXCLUSIVE MODE');
    const categoryResult = await client.query('SELECT category_id, category_key, category_level, parent_id FROM market.yuce_categories');
    const categories = new Map(categoryResult.rows.map((row) => [row.category_key, row]));
    let newCategories = 0;
    const paths = new Map();
    for (const row of validation.rows) {
      for (let level = 1; level <= validation.level; level += 1) {
        const names = row.names.slice(0, level);
        paths.set(JSON.stringify(names), names);
      }
    }
    const orderedPaths = [...paths.entries()].sort((a, b) => a[1].length - b[1].length);
    for (const [key, names] of orderedPaths) {
      const level = names.length;
      const parent = level === 1 ? null : categories.get(JSON.stringify(names.slice(0, -1)));
      if (level > 1 && !parent) throw new Error(`预策类目缺少上级路径：${key}`);
      const prior = categories.get(key);
      if (prior) {
        if (Number(prior.category_level) !== level || String(prior.parent_id ?? '') !== String(parent?.category_id ?? '')) {
          throw new Error(`预策类目已有层级关系冲突：${key}`);
        }
        continue;
      }
      const inserted = await client.query(`INSERT INTO market.yuce_categories(category_key,category_level,category_name,parent_id)
        VALUES($1,$2,$3,$4) RETURNING category_id`, [key, level, names.at(-1), parent?.category_id ?? null]);
      const record = { category_id: inserted.rows[0].category_id, category_key: key, category_level: level, parent_id: parent?.category_id ?? null };
      categories.set(key, record);
      newCategories += 1;
    }
    const categoryIds = [...new Set(validation.rows.map((row) => String(categories.get(row.categoryKey).category_id)))];
    const existingResult = await client.query(`SELECT category_id,stat_month::text AS month_key,transaction_amount,transaction_amount_mom,
      transaction_volume,transaction_volume_mom,volume_status
      FROM market.yuce_category_monthly WHERE category_id=ANY($1::bigint[]) AND stat_month BETWEEN $2::date AND $3::date`,
    [categoryIds, `${validation.months[0]}-01`, `${validation.months.at(-1)}-01`]);
    const existing = new Map(existingResult.rows.map((row) => [`${row.category_id}|${row.month_key}`, row]));
    const insertRows = [];
    let unchanged = 0;
    for (const row of validation.rows) {
      const categoryId = categories.get(row.categoryKey).category_id;
      const month = `${row.month}-01`;
      const prior = existing.get(`${categoryId}|${month}`);
      if (!prior) {
        insertRows.push({ ...row, categoryId, month });
        continue;
      }
      if (amountCents(prior.transaction_amount) !== amountCents(row.transactionAmount)
        || momUnits(prior.transaction_amount_mom) !== momUnits(row.transactionAmountMom)
        || (validation.level === 1 && (Number(prior.transaction_volume ?? -1) !== Number(row.transactionVolume ?? -1)
          || momUnits(prior.transaction_volume_mom) !== momUnits(row.transactionVolumeMom)
          || prior.volume_status !== row.volumeStatus))) {
        throw new Error(`预策类目已有数据与新文件冲突：${row.categoryKey} ${row.month}；未写入任何行`);
      }
      unchanged += 1;
    }
    if (insertRows.length === 0) {
      await client.query('COMMIT');
      return { inserted: 0, unchanged, newCategories: 0, batchId: null, minMonth: null, maxMonth: null };
    }
    const priorBatch = await client.query('SELECT batch_id FROM market.yuce_import_batches WHERE source_sha256=$1', [validation.sourceSha256]);
    if (priorBatch.rows.length) throw new Error('同一来源文件已有入库批次，但当前仍存在缺失数据；请核查后再导入');
    const insertedMonths = insertRows.map((row) => row.month).sort();
    const batchResult = await client.query(`INSERT INTO market.yuce_import_batches
      (source_sha256,source_file,category_level,min_month,max_month,row_count)
      VALUES($1,$2,$3,$4,$5,$6) RETURNING batch_id`,
    [validation.sourceSha256, validation.sourceFile, validation.level, insertedMonths[0], insertedMonths.at(-1), insertRows.length]);
    const batchId = batchResult.rows[0].batch_id;
    for (const row of insertRows) {
      await client.query(`INSERT INTO market.yuce_category_monthly
        (category_id,stat_month,transaction_amount,transaction_amount_mom,transaction_volume,transaction_volume_mom,volume_status,source_batch_id,source_row,source_data)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
      [row.categoryId, row.month, (amountCents(row.transactionAmount) / 100).toFixed(2), row.transactionAmountMom,
        validation.level === 1 ? row.transactionVolume ?? null : null,
        validation.level === 1 ? row.transactionVolumeMom ?? null : null,
        row.volumeStatus, batchId, row.sourceRow, JSON.stringify(row.sourceData)]);
    }
    await client.query('COMMIT');
    return { inserted: insertRows.length, unchanged, newCategories, batchId, minMonth: insertedMonths[0].slice(0, 7), maxMonth: insertedMonths.at(-1).slice(0, 7) };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
