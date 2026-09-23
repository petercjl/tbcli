import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from '@excel.js/exceljs';

const REQUIRED_HEADERS = Object.freeze(['商品ID', '商品标题', '图片链接', '商品类目']);

function cellText(cell) {
  return String(cell?.text ?? '').trim();
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

export async function validateProductImageWorkbook(input, { shopKey, shopName } = {}) {
  if (!input) throw new Error('缺少 --input');
  if (!shopKey) throw new Error('缺少 --shop-key');
  if (!shopName) throw new Error('缺少 --shop-name');
  const file = path.resolve(input);
  const stat = await fsp.stat(file);
  if (!stat.isFile()) throw new Error(`商品图片映射路径不是文件：${file}`);
  const bytes = await fsp.readFile(file);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes);
  if (workbook.worksheets.length !== 1) {
    throw new Error(`商品图片映射必须只有一个工作表，当前为 ${workbook.worksheets.length} 个`);
  }
  const worksheet = workbook.worksheets[0];
  const headers = REQUIRED_HEADERS.map((_, index) => cellText(worksheet.getCell(1, index + 1)));
  const errors = [];
  if (headers.some((header, index) => header !== REQUIRED_HEADERS[index])) {
    errors.push({ code: 'PRODUCT_IMAGE_HEADERS_INVALID', expected: REQUIRED_HEADERS, actual: headers });
  }
  const rows = [];
  const seen = new Map();
  for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    const values = [1, 2, 3, 4].map((column) => cellText(worksheet.getCell(rowNumber, column)));
    if (values.every((value) => value === '')) continue;
    const [platformProductId, productTitle, imageUrl, productCategory] = values;
    if (!/^\d+$/.test(platformProductId)) errors.push({ code: 'PRODUCT_IMAGE_ID_INVALID', row: rowNumber, value: platformProductId });
    if (!productTitle) errors.push({ code: 'PRODUCT_IMAGE_TITLE_REQUIRED', row: rowNumber, platformProductId });
    try {
      const url = new URL(imageUrl);
      if (url.protocol !== 'https:') throw new Error('not https');
    } catch {
      errors.push({ code: 'PRODUCT_IMAGE_URL_INVALID', row: rowNumber, platformProductId, value: imageUrl });
    }
    if (!productCategory) errors.push({ code: 'PRODUCT_IMAGE_CATEGORY_REQUIRED', row: rowNumber, platformProductId });
    if (seen.has(platformProductId)) {
      errors.push({ code: 'PRODUCT_IMAGE_ID_DUPLICATE', row: rowNumber, firstRow: seen.get(platformProductId), platformProductId });
    } else seen.set(platformProductId, rowNumber);
    rows.push({ shop_key: shopKey, shop_name: shopName, platform_product_id: platformProductId, product_title: productTitle, image_url: imageUrl, product_category: productCategory, source_row: rowNumber });
  }
  if (rows.length === 0) errors.push({ code: 'PRODUCT_IMAGE_ROWS_EMPTY' });
  return {
    ok: errors.length === 0,
    file,
    sourceFile: path.basename(file),
    fileSha256: sha256(bytes),
    worksheet: worksheet.name,
    shopKey,
    shopName,
    rowCount: rows.length,
    uniqueProductIds: seen.size,
    rows,
    errors,
  };
}

export async function ensureProductImageSchema(client) {
  await client.query(`
    CREATE SCHEMA IF NOT EXISTS master;
    CREATE TABLE IF NOT EXISTS master.product_image_mappings (
      platform_product_id text PRIMARY KEY,
      shop_key text NOT NULL,
      shop_name text NOT NULL,
      product_title text NOT NULL,
      image_url text NOT NULL CHECK (image_url ~ '^https://'),
      product_category text NOT NULL,
      source_file text NOT NULL,
      source_sha256 text NOT NULL,
      source_row integer NOT NULL,
      imported_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS product_image_mappings_shop_idx
      ON master.product_image_mappings(shop_key,platform_product_id);
  `);
}

export async function importProductImageWorkbook(client, validation) {
  if (!validation?.ok) throw new Error('商品图片映射未通过入库前校验');
  const ids = validation.rows.map((row) => row.platform_product_id);
  await client.query('BEGIN');
  try {
    await ensureProductImageSchema(client);
    const beforeResult = await client.query(`
      SELECT platform_product_id,shop_key,shop_name,product_title,image_url,product_category
      FROM master.product_image_mappings WHERE platform_product_id=ANY($1::text[])
    `, [ids]);
    const before = new Map(beforeResult.rows.map((row) => [row.platform_product_id, row]));
    let inserted = 0;
    let updated = 0;
    let unchanged = 0;
    for (const row of validation.rows) {
      const prior = before.get(row.platform_product_id);
      if (!prior) inserted += 1;
      else if (prior.shop_key === row.shop_key && prior.shop_name === row.shop_name
        && prior.product_title === row.product_title && prior.image_url === row.image_url
        && prior.product_category === row.product_category) unchanged += 1;
      else updated += 1;
      await client.query(`
        INSERT INTO master.product_image_mappings(
          platform_product_id,shop_key,shop_name,product_title,image_url,product_category,
          source_file,source_sha256,source_row,imported_at,updated_at
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now(),now())
        ON CONFLICT(platform_product_id) DO UPDATE SET
          shop_key=excluded.shop_key,shop_name=excluded.shop_name,
          product_title=excluded.product_title,image_url=excluded.image_url,
          product_category=excluded.product_category,source_file=excluded.source_file,
          source_sha256=excluded.source_sha256,source_row=excluded.source_row,updated_at=now()
      `, [row.platform_product_id, row.shop_key, row.shop_name, row.product_title, row.image_url,
        row.product_category, validation.sourceFile, validation.fileSha256, row.source_row]);
    }
    await client.query('COMMIT');
    return {
      table: 'master.product_image_mappings',
      uniqueKey: 'platform_product_id',
      rowCount: validation.rows.length,
      inserted,
      updated,
      unchanged,
      sourceFile: validation.sourceFile,
      fileSha256: validation.fileSha256,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
