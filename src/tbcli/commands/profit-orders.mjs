import {
  connectDatabase,
  loadDatabaseConfig,
  assertMaintainerAccess,
} from '../database.mjs';
import {
  ensureProfitOrderSchema,
  getProfitOrderCoverage,
  importProfitOrderExport,
  listProfitOrderIdentities,
  scanForbiddenOrderKeys,
  validateProfitOrderExport,
} from '../profit-orders.mjs';

function print(value, json) {
  console.log(json ? JSON.stringify(value, null, 2) : JSON.stringify(value, null, 2));
}

function validationSummary(result) {
  return {
    ok: result.ok,
    file: result.file,
    fileSha256: result.fileSha256,
    ordersSha256: result.ordersSha256,
    shopKey: result.shopKey,
    shopName: result.shopName,
    coverageStart: result.coverageStart,
    coverageEnd: result.coverageEnd,
    orderCount: result.orderCount,
    lineCount: result.lineCount,
    shipmentCount: result.shipmentCount,
    fallbackLineKeys: result.fallbackLineKeys,
    errors: result.errors,
  };
}

export async function runProfitOrdersInit(args) {
  const config = await loadDatabaseConfig(args.config);
  assertMaintainerAccess(config);
  const client = await connectDatabase(config, 'ingest');
  try {
    await ensureProfitOrderSchema(client);
    print({ initialized: true, objects: ['meta.profit_source_batches', 'raw.wdt_order_headers', 'raw.wdt_order_lines', 'raw.shipments'] }, args.json);
  } finally { await client.end(); }
}

export async function runProfitOrdersValidate(args) {
  if (!args.input) throw new Error('缺少 --input');
  const result = await validateProfitOrderExport(args.input, args);
  const forbiddenKeys = scanForbiddenOrderKeys(result.file);
  const output = { ...validationSummary(result), forbiddenKeys };
  if (!result.ok || forbiddenKeys.length) {
    print(output, args.json);
    throw new Error(`旺店通订单导出校验失败：${result.errors.length} 个契约错误，${forbiddenKeys.length} 个隐私字段`);
  }
  print(output, args.json);
}

export async function runProfitOrdersImport(args) {
  if (!args.input) throw new Error('缺少 --input');
  const validation = await validateProfitOrderExport(args.input, args);
  const forbiddenKeys = scanForbiddenOrderKeys(validation.file);
  if (!validation.ok || forbiddenKeys.length) {
    throw new Error(`旺店通订单导出未通过入库前校验：${validation.errors.length} 个契约错误，${forbiddenKeys.length} 个隐私字段`);
  }
  const config = await loadDatabaseConfig(args.config);
  assertMaintainerAccess(config);
  const client = await connectDatabase(config, 'ingest');
  try {
    const imported = await importProfitOrderExport(client, validation);
    print({ validation: validationSummary(validation), imported }, args.json);
  } finally { await client.end(); }
}

export async function runProfitOrdersCoverage(args) {
  const config = await loadDatabaseConfig(args.config);
  const client = await connectDatabase(config, 'reader');
  try { print(await getProfitOrderCoverage(client, args), args.json); }
  finally { await client.end(); }
}

export async function runProfitOrdersIdentity(args) {
  const config = await loadDatabaseConfig(args.config);
  const client = await connectDatabase(config, 'reader');
  try { print(await listProfitOrderIdentities(client), args.json); }
  finally { await client.end(); }
}
