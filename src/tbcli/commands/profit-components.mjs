import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { assertMaintainerAccess, connectDatabase, loadDatabaseConfig } from '../database.mjs';
import { reconcileComponents, syncComponents, validateComponentSnapshot } from '../profit-components.mjs';

const execFileAsync = promisify(execFile);

async function wdtcli(args) {
  let stdout;
  try { ({ stdout } = await execFileAsync('wdtcli', args, { maxBuffer: 50 * 1024 * 1024, timeout: 600000 })); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error('缺少 wdtcli 旺店通采集入口');
    throw new Error(`旺店通采集失败：${String(error.stderr || error.message).slice(0, 500)}`);
  }
  try { return JSON.parse(stdout); }
  catch { throw new Error('wdtcli 未返回有效 JSON'); }
}

export async function runProfitComponentsFetch(args) {
  if (!args.shopKey || !args.shopId || !args.out || !args.replaceBatchId)
    throw new Error('需要 --shop-key、--shop-id、--replace-batch-id 和 --out');
  const out = path.resolve(args.out);
  try { await fs.stat(out); throw new Error(`输出文件已存在：${out}`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const client = await connectDatabase(await loadDatabaseConfig(args.config), 'reader');
  let historicalIds;
  try {
    const found = await client.query(`SELECT DISTINCT platform_product_id
      FROM master.platform_sku_component_versions WHERE shop_key=$1 AND batch_id=$2
      ORDER BY platform_product_id`, [args.shopKey, args.replaceBatchId]);
    historicalIds = found.rows.map((row) => String(row.platform_product_id));
  } finally { await client.end(); }
  if (!historicalIds.length) throw new Error('待替换批次没有平台商品，拒绝采集空快照');
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tbcli-components-'));
  try {
    const activePath = path.join(tempDir, 'active.json');
    const suitesPath = path.join(tempDir, 'suites.json');
    await wdtcli(['web', 'platform-goods', 'active', '--shop-id', String(args.shopId),
      '--out', activePath, '--json']);
    const active = JSON.parse(await fs.readFile(activePath, 'utf8'));
    if (active.channel !== 'erp-web' || active.status !== 1
      || String(active.shopId) !== String(args.shopId)
      || active.skus?.length !== active.platformSkuCount)
      throw new Error('旺店通在售平台 SKU 快照不完整');
    const skus = new Map(active.skus.map((sku) =>
      [`${sku.platformGoodsId}|${sku.platformSkuId}`, sku]));
    for (const productId of historicalIds) {
      const response = await wdtcli(['web', 'platform-goods', 'skus', '--goods-id', productId,
        '--shop-id', String(args.shopId), '--json']);
      if (response.channel !== 'erp-web' || response.platformGoodsId !== productId
        || String(response.shopId) !== String(args.shopId)
        || response.skus?.length !== response.returned)
        throw new Error(`平台商品 ${productId} 查询不完整`);
      for (const sku of response.skus) skus.set(`${sku.platformGoodsId}|${sku.platformSkuId}`, sku);
    }
    await wdtcli(['openapi', 'suites', 'export', '--out', suitesPath, '--json']);
    const suites = JSON.parse(await fs.readFile(suitesPath, 'utf8'));
    if (suites.channel !== 'openapi' || suites.endpoint !== 'suites_query.php'
      || suites.suites?.length !== suites.totalCount)
      throw new Error('旺店通组合装快照不完整');
    const output = { source: 'wdtcli:platform-sku-suite-snapshot/v1', shopKey: args.shopKey,
      shopId: String(args.shopId), capturedAt: new Date().toISOString(),
      historicalProductCount: historicalIds.length, activeProductCount: active.productCount,
      platformSkuCount: skus.size, suiteCount: suites.totalCount,
      productQueryFailures: [], skus: [...skus.values()], suites: suites.suites };
    await fs.writeFile(out, `${JSON.stringify(output)}\n`, { flag: 'wx', mode: 0o600 });
    const stat = await fs.stat(out);
    if (!stat.isFile() || stat.size === 0 || (stat.mode & 0o077))
      throw new Error('旺店通快照文件权限或大小校验失败');
    const result = { out, size: stat.size, historicalProductCount: historicalIds.length,
      activeProductCount: active.productCount, platformSkuCount: skus.size,
      suiteCount: suites.totalCount, capturedAt: output.capturedAt };
    console.log(JSON.stringify(result, null, 2));
    return result;
  } finally { await fs.rm(tempDir, { recursive: true, force: true }); }
}

export async function runProfitComponentsReconcile(args) {
  const validation = await validateComponentSnapshot(args.input, args);
  const client = await connectDatabase(await loadDatabaseConfig(args.config), 'reader');
  try {
    const reconciliation = await reconcileComponents(client, validation, args.replaceBatchId);
    const result = { source: { file: validation.file, sha256: validation.fileSha256,
      capturedAt: validation.capturedAt }, reconciliation };
    if (args.out) {
      const out = path.resolve(args.out);
      try { await fs.stat(out); throw new Error(`输出文件已存在：${out}`); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      await fs.writeFile(out, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      const stat = await fs.stat(out);
      if (!stat.isFile() || stat.size === 0 || (stat.mode & 0o077))
        throw new Error('核对报告权限或大小校验失败');
      result.out = out;
    }
    console.log(JSON.stringify(result, null, 2));
    return result;
  } finally { await client.end(); }
}

export async function runProfitComponentsSync(args) {
  if (!args.yes) throw new Error('确认替换精确旧批次后需传 --yes');
  const validation = await validateComponentSnapshot(args.input, args);
  const config = await loadDatabaseConfig(args.config);
  assertMaintainerAccess(config);
  const client = await connectDatabase(config, 'ingest');
  try {
    const result = await syncComponents(client, validation, {
      replaceBatchId: args.replaceBatchId, expectedOldCount: args.expectedOldCount,
      backupOut: args.backupOut,
    });
    console.log(JSON.stringify(result, null, 2));
    return result;
  } finally { await client.end(); }
}
