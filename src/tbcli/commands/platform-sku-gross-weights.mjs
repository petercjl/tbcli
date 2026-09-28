import path from 'node:path';
import { assertMaintainerAccess, connectDatabase, loadDatabaseConfig } from '../database.mjs';
import { applySkuGrossWeights, assertSkuGrossModeReady, discoverSkuGrossBillInputs, importSkuGrossBills,
  validateSkuGrossBills } from '../platform-sku-gross-weights.mjs';
import { importManualGrossWeights, readManualGrossInput } from '../platform-sku-gross-manual.mjs';

async function execute(args, mode) {
  if (!args.shopKey) throw new Error('需要 --shop-key');
  const files = await discoverSkuGrossBillInputs(args.input, args);
  // Validate every file before the first database mutation.
  const validated = await validateSkuGrossBills(files);
  const config = await loadDatabaseConfig(args.config);
  assertMaintainerAccess(config);
  const client = await connectDatabase(config, 'ingest');
  try {
    // Reject a wrong mode before importing any previously unseen courier bill.
    await assertSkuGrossModeReady(client, args.shopKey, mode);
    const imports = await importSkuGrossBills(client, validated);
    const batchIds = [...new Set(imports.map(item => item.batchId))];
    if (batchIds.some(id => !id)) throw new Error('账单导入没有返回可追溯批次 ID');
    const applied = await applySkuGrossWeights(client, {
      shopKey: args.shopKey, mode, batchIds,
      fileNames: imports.map(item => path.basename(item.file)),
    });
    const result = { ...applied, bills: imports.map(item => ({
      file:item.file,carrier:item.carrier,billMonth:item.billMonth,
      batchId:item.batchId,alreadyImported:item.alreadyImported,
      detailCount:item.validation.detailCount,
    })) };
    console.log(JSON.stringify(result, null, 2));
    return result;
  } finally { await client.end(); }
}

export const runSkuGrossInit = args => execute(args, 'init');
export const runSkuGrossUpdate = args => execute(args, 'update');

export async function runSkuGrossManualImport(args) {
  if (!args.shopKey) throw new Error('需要 --shop-key');
  const input=await readManualGrossInput(args.input);
  const config=await loadDatabaseConfig(args.config);
  assertMaintainerAccess(config);
  const client=await connectDatabase(config,'ingest');
  try {
    const result=await importManualGrossWeights(client,{shopKey:args.shopKey,input});
    console.log(JSON.stringify(result,null,2));
    return result;
  } finally {await client.end();}
}
