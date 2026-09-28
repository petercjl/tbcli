import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const keyOf = (row) => `${row.platform_product_id}|${row.platform_sku_id}|${row.erp_spec_no}`;

export function buildAuthoritativeComponents(source, shopKey) {
  if (source?.source !== 'wdtcli:platform-sku-suite-snapshot/v1' || source.shopKey !== shopKey
    || !Array.isArray(source.skus) || !Array.isArray(source.suites)
    || source.skus.length !== source.platformSkuCount
    || source.suites.length !== source.suiteCount
    || source.productQueryFailures?.length)
    throw new Error('旺店通平台 SKU/组合装快照来源、店铺或完整性校验失败');
  const suites = new Map();
  for (const suite of source.suites) {
    const no = String(suite.suiteNo ?? '').trim();
    if (!no) continue;
    if (!suites.has(no)) suites.set(no, []);
    suites.get(no).push(suite);
  }
  const skuKeys = new Set(), rows = [], issues = [], covered = new Set();
  for (const sku of source.skus) {
    const productId = String(sku.platformGoodsId ?? '').trim();
    const skuId = String(sku.platformSkuId ?? '').trim();
    const skuKey = `${productId}|${skuId}`;
    if (!productId || !skuId) {
      issues.push({ platformProductId: productId || null, platformSkuId: skuId || null,
        reason: 'platform_sku_id_missing' });
      continue;
    }
    if (skuKeys.has(skuKey)) throw new Error(`平台 SKU 编码重复：${skuKey}`);
    skuKeys.add(skuKey);
    let components;
    if (sku.matchType === 'single') {
      if (sku.systemGoods?.length !== 1) {
        issues.push({ platformProductId: productId, platformSkuId: skuId, reason: 'direct_target_not_unique' });
        continue;
      }
      components = [{ specNo: sku.systemGoods[0].specNo, quantity: 1 }];
    } else if (sku.matchType === 'suite') {
      if (sku.suites?.length !== 1) {
        issues.push({ platformProductId: productId, platformSkuId: skuId, reason: 'suite_target_not_unique' });
        continue;
      }
      const suiteNo = String(sku.suites[0].suiteNo ?? '');
      const candidates = (suites.get(suiteNo) ?? []).filter((item) => Number(item.deleted) === 0);
      const suite = candidates.length === 1 ? candidates[0] : null;
      if (!suite) {
        issues.push({ platformProductId: productId, platformSkuId: skuId, suiteNo,
          reason: candidates.length > 1 ? 'suite_ambiguous' : 'suite_missing_or_deleted' });
        continue;
      }
      if (sku.suites[0].suiteId != null && suite.suiteId != null
        && String(sku.suites[0].suiteId) !== String(suite.suiteId)) {
        issues.push({ platformProductId: productId, platformSkuId: skuId, suiteNo,
          reason: 'suite_id_mismatch' });
        continue;
      }
      components = (suite.components ?? []).filter((item) => Number(item.deleted) === 0);
      if (!components.length) {
        issues.push({ platformProductId: productId, platformSkuId: skuId, suiteNo, reason: 'suite_empty' });
        continue;
      }
    } else {
      issues.push({ platformProductId: productId, platformSkuId: skuId, reason: 'platform_sku_unmapped' });
      continue;
    }
    const bySpec = new Map();
    let invalid = false;
    for (const component of components) {
      const specNo = String(component.specNo ?? '').trim();
      const quantity = Number(component.quantity);
      if (!specNo || !Number.isFinite(quantity) || quantity <= 0) { invalid = true; break; }
      bySpec.set(specNo, (bySpec.get(specNo) ?? 0) + quantity);
    }
    if (invalid) {
      issues.push({ platformProductId: productId, platformSkuId: skuId, reason: 'component_invalid' });
      continue;
    }
    covered.add(skuKey);
    for (const [specNo, quantity] of bySpec) rows.push({
      platform_product_id: productId, platform_sku_id: skuId, erp_spec_no: specNo,
      component_qty: quantity, image_url: sku.imageUrl ?? null,
    });
  }
  rows.sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
  return { rows, issues, coveredSkuCount: covered.size, sourceSkuCount: skuKeys.size,
    productCount: new Set(rows.map((row) => row.platform_product_id)).size };
}

export async function validateComponentSnapshot(input, { shopKey, effectiveFrom } = {}) {
  if (!input || !shopKey || !DATE.test(String(effectiveFrom ?? '')))
    throw new Error('需要 --input、--shop-key 和 YYYY-MM-DD 格式的 --effective-from');
  const file = path.resolve(input);
  const stat = await fs.stat(file);
  if (!stat.isFile()) throw new Error('输入必须是旺店通快照文件');
  const bytes = await fs.readFile(file);
  let source;
  try { source = JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error('旺店通快照不是有效 JSON'); }
  if (!Number.isFinite(Date.parse(source.capturedAt))
    || new Date(source.capturedAt).toISOString().slice(0, 10) > effectiveFrom)
    throw new Error('旺店通快照时间无效或晚于生效日期');
  const built = buildAuthoritativeComponents(source, shopKey);
  if (!built.rows.length) throw new Error('旺店通快照没有可批准的子件关系');
  return { file, sourceFile: path.basename(file), fileSha256: sha256(bytes), shopKey,
    effectiveFrom, capturedAt: source.capturedAt, ...built };
}

export async function reconcileComponents(client, validation, replaceBatchId) {
  if (!replaceBatchId) throw new Error('缺少 --replace-batch-id 精确指定旧批次');
  const old = await client.query(`SELECT version_id,platform_product_id,platform_sku_id,
    erp_spec_no,component_qty,status,effective_from::text,effective_to::text
    FROM master.platform_sku_component_versions WHERE shop_key=$1 AND batch_id=$2
    ORDER BY version_id`, [validation.shopKey, replaceBatchId]);
  const oldByKey = new Map(old.rows.map((row) => [keyOf(row), Number(row.component_qty)]));
  const newByKey = new Map(validation.rows.map((row) => [keyOf(row), Number(row.component_qty)]));
  const changed = [], added = [], removed = [];
  for (const [key, quantity] of newByKey) {
    if (!oldByKey.has(key)) added.push(key);
    else if (oldByKey.get(key) !== quantity) changed.push({ key, before: oldByKey.get(key), after: quantity });
  }
  for (const key of oldByKey.keys()) if (!newByKey.has(key)) removed.push(key);
  return { shopKey: validation.shopKey, replaceBatchId, oldRowCount: old.rowCount,
    newRowCount: validation.rows.length, coveredSkuCount: validation.coveredSkuCount,
    sourceSkuCount: validation.sourceSkuCount, issueCount: validation.issues.length,
    issues: validation.issues, changedCount: changed.length, addedCount: added.length,
    removedCount: removed.length, changed, added, removed };
}

async function oldRows(client, shopKey, batchId) {
  const master = await client.query(`SELECT version_id,batch_id,shop_key,platform_product_id,
    platform_sku_id,erp_spec_no,component_qty,ratio_evidence_count,ratio_consistency,
    image_url,effective_from::text,effective_to::text,status
    FROM master.platform_sku_component_versions WHERE shop_key=$1 AND batch_id=$2
    ORDER BY version_id`, [shopKey, batchId]);
  const raw = await client.query(`SELECT id,batch_id,entity_type,natural_key,row_data,source_row
    FROM raw.master_profit_profile_rows WHERE batch_id=$1 AND entity_type='component' ORDER BY id`, [batchId]);
  return { master: master.rows, raw: raw.rows };
}

export async function syncComponents(client, validation, { replaceBatchId, expectedOldCount, backupOut } = {}) {
  if (!replaceBatchId || !Number.isInteger(Number(expectedOldCount)) || !backupOut)
    throw new Error('需要 --replace-batch-id、--expected-old-count 和 --backup-out');
  const backupPath = path.resolve(backupOut);
  try { await fs.stat(backupPath); throw new Error(`备份文件已存在：${backupPath}`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const before = await oldRows(client, validation.shopKey, replaceBatchId);
  if (before.master.length !== Number(expectedOldCount))
    throw new Error(`旧组件行数变化：预期 ${expectedOldCount}，实际 ${before.master.length}`);
  const backup = { source: 'tbcli:platform-sku-component-backup/v1', shopKey: validation.shopKey,
    replaceBatchId, exportedAt: new Date().toISOString(), master: before.master, raw: before.raw };
  const backupBytes = Buffer.from(`${JSON.stringify(backup)}\n`);
  await fs.writeFile(backupPath, backupBytes, { flag: 'wx', mode: 0o600 });
  const stat = await fs.stat(backupPath);
  if (!stat.isFile() || stat.size !== backupBytes.length || (stat.mode & 0o077))
    throw new Error('旧组件备份权限或大小校验失败，未修改数据库');
  await client.query('BEGIN');
  try {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',
      [`tbcli:profit-components:${validation.shopKey}`]);
    const current = await oldRows(client, validation.shopKey, replaceBatchId);
    if (sha256(JSON.stringify(current)) !== sha256(JSON.stringify(before)))
      throw new Error('旧组件在备份后发生变化，事务已回滚');
    const prior = await client.query(`SELECT batch_id FROM meta.master_data_batches
      WHERE source_sha256=$1`, [validation.fileSha256]);
    if (prior.rowCount) throw new Error('此旺店通组件快照已经入库');
    const removed = await client.query(`DELETE FROM master.platform_sku_component_versions
      WHERE shop_key=$1 AND batch_id=$2`, [validation.shopKey, replaceBatchId]);
    if (removed.rowCount !== before.master.length) throw new Error('旧主数据删除行数异常');
    const rawRemoved = await client.query(`DELETE FROM raw.master_profit_profile_rows
      WHERE batch_id=$1 AND entity_type='component'`, [replaceBatchId]);
    if (rawRemoved.rowCount !== before.raw.length) throw new Error('旧来源组件删除行数异常');
    const batch = await client.query(`INSERT INTO meta.master_data_batches(
      data_type,source_file,source_sha256,source_metadata,shop_key,status,row_count,
      product_count,sku_count,mapped_sku_count,effective_from,activated_at)
      VALUES('platform-sku-component-wdt',$1,$2,$3::jsonb,$4,'approved',$5,$6,$7,$7,$8::date,now())
      RETURNING batch_id`, [validation.sourceFile, validation.fileSha256,
      JSON.stringify({ source: 'wdtcli:platform-sku-suite-snapshot/v1', capturedAt: validation.capturedAt,
        replacedBatchId: replaceBatchId, backupSha256: sha256(backupBytes),
        sourceSkuCount: validation.sourceSkuCount, issueCount: validation.issues.length }),
      validation.shopKey, validation.rows.length, validation.productCount,
      validation.coveredSkuCount, validation.effectiveFrom]);
    const newBatchId = batch.rows[0].batch_id;
    for (let index = 0; index < validation.rows.length; index += 500) {
      const chunk = validation.rows.slice(index, index + 500);
      await client.query(`INSERT INTO master.platform_sku_component_versions(
        batch_id,shop_key,platform_product_id,platform_sku_id,erp_spec_no,component_qty,
        ratio_evidence_count,ratio_consistency,image_url,effective_from,effective_to,status)
        SELECT $1::uuid,$2,x.platform_product_id,x.platform_sku_id,x.erp_spec_no,
          x.component_qty,0,NULL,x.image_url,$3::date,NULL,'approved'
        FROM jsonb_to_recordset($4::jsonb) AS x(platform_product_id text,platform_sku_id text,
          erp_spec_no text,component_qty numeric,image_url text)`,
      [newBatchId, validation.shopKey, validation.effectiveFrom, JSON.stringify(chunk)]);
    }
    const check = await client.query(`SELECT platform_product_id,platform_sku_id,erp_spec_no,
      component_qty FROM master.current_platform_sku_components
      WHERE shop_key=$1 AND batch_id=$2`, [validation.shopKey, newBatchId]);
    const after = new Map(check.rows.map((row) => [keyOf(row), Number(row.component_qty)]));
    if (after.size !== validation.rows.length || validation.rows.some((row) =>
      after.get(keyOf(row)) !== Number(row.component_qty)))
      throw new Error('新组件写后核验失败，事务已回滚');
    await client.query('COMMIT');
    return { backupPath, backupSha256: sha256(backupBytes), replacedRows: removed.rowCount,
      removedRawRows: rawRemoved.rowCount, newBatchId, insertedRows: validation.rows.length,
      coveredSkuCount: validation.coveredSkuCount, issueCount: validation.issues.length,
      verification: { ok: true, matchedRows: after.size } };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
}
