import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

export async function validateProductOwnerFile(input, { shopKey, effectiveFrom, sourceRevision } = {}) {
  if (!input) throw new Error('缺少 --input');
  if (!shopKey) throw new Error('缺少 --shop-key');
  if (!DATE.test(String(effectiveFrom || ''))) throw new Error('缺少或非法 --effective-from，必须为 YYYY-MM-DD');
  if (!String(sourceRevision || '').trim()) throw new Error('缺少 --source-revision');
  const file = path.resolve(input);
  const stat = await fsp.stat(file);
  if (!stat.isFile()) throw new Error(`商品负责人映射路径不是文件：${file}`);
  const bytes = await fsp.readFile(file);
  let parsed;
  try { parsed = JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error('商品负责人映射必须是有效 JSON'); }
  const inputRows = Array.isArray(parsed) ? parsed : parsed?.rows;
  if (!Array.isArray(inputRows)) throw new Error('商品负责人映射 JSON 必须是数组或包含 rows 数组');
  const errors = [];
  const rows = [];
  const seen = new Map();
  for (let index = 0; index < inputRows.length; index += 1) {
    const sourceRow = index + 1;
    const raw = inputRows[index] || {};
    const platformProductId = String(raw.platformProductId ?? raw.platform_product_id ?? '').trim();
    const ownerName = String(raw.ownerName ?? raw.owner_name ?? '').trim();
    if (!/^\d+$/.test(platformProductId)) errors.push({ code: 'PRODUCT_OWNER_ID_INVALID', sourceRow, value: platformProductId });
    if (!ownerName) errors.push({ code: 'PRODUCT_OWNER_NAME_REQUIRED', sourceRow, platformProductId });
    if (seen.has(platformProductId)) {
      errors.push({ code: 'PRODUCT_OWNER_ID_DUPLICATE', sourceRow, firstSourceRow: seen.get(platformProductId), platformProductId });
    } else seen.set(platformProductId, sourceRow);
    rows.push({
      platform_product_id: platformProductId,
      owner_name: ownerName,
      product_name: String(raw.productName ?? raw.product_name ?? '').trim() || null,
      source_record_id: String(raw.sourceRecordId ?? raw.source_record_id ?? '').trim() || null,
      source_row: sourceRow,
    });
  }
  if (!rows.length) errors.push({ code: 'PRODUCT_OWNER_ROWS_EMPTY' });
  return {
    ok: errors.length === 0,
    file,
    sourceFile: path.basename(file),
    fileSha256: sha256(bytes),
    sourceMetadata: !Array.isArray(parsed) && parsed?.sourceMetadata && typeof parsed.sourceMetadata === 'object'
      ? parsed.sourceMetadata : {},
    shopKey,
    effectiveFrom,
    sourceRevision: String(sourceRevision).trim(),
    rowCount: rows.length,
    uniqueProductIds: seen.size,
    rows,
    errors,
  };
}

export async function reconcileProductOwners(client, validation) {
  if (!validation?.ok) throw new Error('商品负责人映射未通过校验');
  const ids = validation.rows.map((row) => row.platform_product_id);
  const current = await client.query(`
    SELECT version_id,platform_product_id,owner_name,source_revision,effective_from::text,effective_to::text,status
    FROM master.current_product_owners
    WHERE shop_key=$1 AND platform_product_id=ANY($2::text[])
  `, [validation.shopKey, ids]);
  const byId = new Map(current.rows.map((row) => [String(row.platform_product_id), row]));
  const matched = [];
  const missing = [];
  const conflicts = [];
  for (const row of validation.rows) {
    const prior = byId.get(row.platform_product_id);
    if (!prior) missing.push(row);
    else if (prior.owner_name === row.owner_name) matched.push({ ...row, database_owner_name: prior.owner_name });
    else conflicts.push({ ...row, database_owner_name: prior.owner_name,
      database_source_revision: prior.source_revision, database_version_id: prior.version_id,
      database_effective_from: prior.effective_from });
  }
  return {
    shopKey: validation.shopKey,
    sourceRows: validation.rowCount,
    matchedCount: matched.length,
    missingCount: missing.length,
    conflictCount: conflicts.length,
    matched,
    missing,
    conflicts,
  };
}

export async function importMissingProductOwners(client, validation) {
  if (!validation?.ok) throw new Error('商品负责人映射未通过入库前校验');
  await client.query('BEGIN');
  try {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`tbcli:profit-owners:${validation.shopKey}`]);
    const previous = await client.query(`
      SELECT batch_id,status,row_count,product_count,effective_from::text,imported_at,activated_at
      FROM meta.master_data_batches WHERE source_sha256=$1
    `, [validation.fileSha256]);
    if (previous.rowCount) {
      const reconciliation = await reconcileProductOwners(client, validation);
      await client.query('COMMIT');
      return { alreadyImported: true, batch: previous.rows[0], inserted: 0, reconciliation };
    }
    const reconciliation = await reconcileProductOwners(client, validation);
    if (!reconciliation.missingCount) {
      await client.query('COMMIT');
      return { alreadyImported: false, noChanges: true, inserted: 0, reconciliation };
    }
    const metadata = {
      ...validation.sourceMetadata,
      sourceRevision: validation.sourceRevision,
      sourceRowCount: validation.rowCount,
      matchedCount: reconciliation.matchedCount,
      conflictCount: reconciliation.conflictCount,
      mode: 'insert-missing-only',
    };
    const batch = await client.query(`
      INSERT INTO meta.master_data_batches(
        data_type,source_file,source_sha256,source_metadata,shop_key,status,row_count,
        product_count,sku_count,mapped_sku_count,effective_from,activated_at
      ) VALUES('product-owners',$1,$2,$3::jsonb,$4,'approved',$5,$5,0,0,$6::date,now())
      RETURNING batch_id,status,row_count,product_count,effective_from::text,imported_at,activated_at
    `, [validation.sourceFile, validation.fileSha256, JSON.stringify(metadata), validation.shopKey,
      reconciliation.missingCount, validation.effectiveFrom]);
    const insertedRows = reconciliation.missing.map((row) => ({
      platform_product_id: row.platform_product_id,
      owner_name: row.owner_name,
    }));
    await client.query(`
      INSERT INTO master.product_owner_versions(
        batch_id,shop_key,platform_product_id,owner_name,product_type,source_revision,
        effective_from,effective_to,status
      )
      SELECT $1::uuid,$2,x.platform_product_id,x.owner_name,NULL,$3,$4::date,NULL,'approved'
      FROM jsonb_to_recordset($5::jsonb) AS x(platform_product_id text,owner_name text)
    `, [batch.rows[0].batch_id, validation.shopKey, validation.sourceRevision,
      validation.effectiveFrom, JSON.stringify(insertedRows)]);
    const verified = await client.query(`
      SELECT platform_product_id,owner_name FROM master.current_product_owners
      WHERE shop_key=$1 AND platform_product_id=ANY($2::text[])
    `, [validation.shopKey, insertedRows.map((row) => row.platform_product_id)]);
    const verifiedById = new Map(verified.rows.map((row) => [String(row.platform_product_id), row.owner_name]));
    const verificationErrors = insertedRows.filter((row) => verifiedById.get(row.platform_product_id) !== row.owner_name);
    if (verificationErrors.length) throw new Error(`商品负责人写后核验失败：${verificationErrors.length} 条`);
    await client.query('COMMIT');
    return {
      alreadyImported: false,
      inserted: insertedRows.length,
      batch: batch.rows[0],
      conflictsPreserved: reconciliation.conflictCount,
      verification: { ok: true, verified: insertedRows.length },
      reconciliation,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

export async function syncProductOwners(client, validation) {
  if (!validation?.ok) throw new Error('商品负责人映射未通过同步前校验');
  await client.query('BEGIN');
  try {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`tbcli:profit-owners:${validation.shopKey}`]);
    const before = await reconcileProductOwners(client, validation);
    const changes = [...before.missing.map((row) => ({ ...row, action: 'insert' })),
      ...before.conflicts.map((row) => ({ ...row, action: 'supersede' }))];
    if (!changes.length) {
      await client.query('COMMIT');
      return { noChanges: true, inserted: 0, superseded: 0,
        verification: { ok: true, matched: before.matchedCount }, reconciliation: before };
    }
    for (const row of before.conflicts) {
      if (!row.database_version_id || !DATE.test(String(row.database_effective_from || ''))
        || row.database_effective_from > validation.effectiveFrom) {
        throw new Error(`商品 ${row.platform_product_id} 的现有版本无法安全接续`);
      }
    }
    const operationDigest = sha256(JSON.stringify({ fileSha256: validation.fileSha256,
      shopKey: validation.shopKey, effectiveFrom: validation.effectiveFrom,
      changes: changes.map((row) => [row.platform_product_id, row.owner_name,
        row.database_version_id ?? null]) }));
    const previous = await client.query(`
      SELECT batch_id FROM meta.master_data_batches WHERE source_sha256=$1
    `, [operationDigest]);
    if (previous.rowCount) throw new Error('相同来源与版本差异已同步过，但当前映射再次出现差异；请核查版本历史');
    const metadata = { ...validation.sourceMetadata, sourceRevision: validation.sourceRevision,
      sourceFileSha256: validation.fileSha256, sourceRowCount: validation.rowCount,
      matchedCount: before.matchedCount, missingCount: before.missingCount,
      conflictCount: before.conflictCount, mode: 'sync-current-versioned' };
    const batch = await client.query(`
      INSERT INTO meta.master_data_batches(
        data_type,source_file,source_sha256,source_metadata,shop_key,status,row_count,
        product_count,sku_count,mapped_sku_count,effective_from,activated_at
      ) VALUES('product-owners',$1,$2,$3::jsonb,$4,'approved',$5,$5,0,0,$6::date,now())
      RETURNING batch_id,status,row_count,product_count,effective_from::text,imported_at,activated_at
    `, [validation.sourceFile, operationDigest, JSON.stringify(metadata), validation.shopKey,
      changes.length, validation.effectiveFrom]);
    for (const row of before.conflicts) {
      const sameDay = row.database_effective_from === validation.effectiveFrom;
      const updated = sameDay
        ? await client.query(`
          UPDATE master.product_owner_versions SET status='retired'
          WHERE version_id=$1 AND shop_key=$2 AND platform_product_id=$3
            AND status='approved' AND effective_to IS NULL
        `, [row.database_version_id, validation.shopKey, row.platform_product_id])
        : await client.query(`
          UPDATE master.product_owner_versions SET effective_to=$1::date - 1
          WHERE version_id=$2 AND shop_key=$3 AND platform_product_id=$4
            AND status='approved' AND effective_to IS NULL
        `, [validation.effectiveFrom, row.database_version_id, validation.shopKey,
          row.platform_product_id]);
      if (updated.rowCount !== 1) throw new Error(`商品 ${row.platform_product_id} 的旧版本状态已变化，停止同步`);
    }
    await client.query(`
      INSERT INTO master.product_owner_versions(
        batch_id,shop_key,platform_product_id,owner_name,product_type,source_revision,
        effective_from,effective_to,status
      )
      SELECT $1::uuid,$2,x.platform_product_id,x.owner_name,NULL,$3,$4::date,NULL,'approved'
      FROM jsonb_to_recordset($5::jsonb) AS x(platform_product_id text,owner_name text)
    `, [batch.rows[0].batch_id, validation.shopKey, validation.sourceRevision,
      validation.effectiveFrom, JSON.stringify(changes.map((row) => ({
        platform_product_id: row.platform_product_id, owner_name: row.owner_name,
      })))]);
    const after = await reconcileProductOwners(client, validation);
    if (after.missingCount || after.conflictCount || after.matchedCount !== validation.rowCount)
      throw new Error(`商品负责人同步写后核验失败：缺失 ${after.missingCount}、冲突 ${after.conflictCount}`);
    await client.query('COMMIT');
    return { noChanges: false, inserted: before.missingCount,
      superseded: before.conflictCount, batch: batch.rows[0],
      verification: { ok: true, matched: after.matchedCount }, reconciliation: after };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
