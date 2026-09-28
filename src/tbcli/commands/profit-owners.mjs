import { assertMaintainerAccess, connectDatabase, loadDatabaseConfig } from '../database.mjs';
import { importMissingProductOwners, reconcileProductOwners, syncProductOwners, validateProductOwnerFile } from '../profit-owners.mjs';

function validationSummary(validation) {
  return {
    ok: validation.ok,
    file: validation.file,
    fileSha256: validation.fileSha256,
    shopKey: validation.shopKey,
    effectiveFrom: validation.effectiveFrom,
    sourceRevision: validation.sourceRevision,
    rowCount: validation.rowCount,
    uniqueProductIds: validation.uniqueProductIds,
    errors: validation.errors,
  };
}

export async function runProfitOwnersReconcile(args) {
  const validation = await validateProductOwnerFile(args.input, args);
  if (!validation.ok) throw new Error(`商品负责人映射校验失败：${validation.errors.length} 个错误`);
  const client = await connectDatabase(await loadDatabaseConfig(args.config), 'reader');
  try {
    const reconciliation = await reconcileProductOwners(client, validation);
    const result = { validation: validationSummary(validation), reconciliation };
    console.log(JSON.stringify(result, null, 2));
    return result;
  } finally { await client.end(); }
}

export async function runProfitOwnersImport(args) {
  const validation = await validateProductOwnerFile(args.input, args);
  if (!validation.ok) throw new Error(`商品负责人映射校验失败：${validation.errors.length} 个错误`);
  const config = await loadDatabaseConfig(args.config);
  assertMaintainerAccess(config);
  const client = await connectDatabase(config, 'ingest');
  try {
    const imported = await importMissingProductOwners(client, validation);
    const result = { validation: validationSummary(validation), imported };
    console.log(JSON.stringify(result, null, 2));
    return result;
  } finally { await client.end(); }
}

export async function runProfitOwnersSync(args) {
  const validation = await validateProductOwnerFile(args.input, args);
  if (!validation.ok) throw new Error(`商品负责人映射校验失败：${validation.errors.length} 个错误`);
  const config = await loadDatabaseConfig(args.config);
  assertMaintainerAccess(config);
  const client = await connectDatabase(config, 'ingest');
  try {
    const synced = await syncProductOwners(client, validation);
    const result = { validation: validationSummary(validation), synced };
    console.log(JSON.stringify(result, null, 2));
    return result;
  } finally { await client.end(); }
}
