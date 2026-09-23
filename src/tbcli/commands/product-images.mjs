import { assertMaintainerAccess, connectDatabase, loadDatabaseConfig } from '../database.mjs';
import { importProductImageWorkbook, validateProductImageWorkbook } from '../product-images.mjs';

function summary(validation) {
  return {
    ok: validation.ok,
    file: validation.file,
    fileSha256: validation.fileSha256,
    worksheet: validation.worksheet,
    shopKey: validation.shopKey,
    shopName: validation.shopName,
    rowCount: validation.rowCount,
    uniqueProductIds: validation.uniqueProductIds,
    errors: validation.errors,
  };
}

export async function runProductImagesValidate(args) {
  const validation = await validateProductImageWorkbook(args.input, args);
  console.log(JSON.stringify(summary(validation), null, 2));
  if (!validation.ok) throw new Error(`商品图片映射校验失败：${validation.errors.length} 个错误`);
  return validation;
}

export async function runProductImagesImport(args) {
  const validation = await validateProductImageWorkbook(args.input, args);
  if (!validation.ok) throw new Error(`商品图片映射未通过入库前校验：${validation.errors.length} 个错误`);
  const config = await loadDatabaseConfig(args.config);
  assertMaintainerAccess(config);
  const client = await connectDatabase(config, 'ingest');
  try {
    const imported = await importProductImageWorkbook(client, validation);
    const result = { validation: summary(validation), imported };
    console.log(JSON.stringify(result, null, 2));
    return result;
  } finally {
    await client.end();
  }
}
