import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseArgs } from '../src/tbcli/args.mjs';
import { reconcileProductOwners, syncProductOwners, validateProductOwnerFile } from '../src/tbcli/profit-owners.mjs';
import { businessCapabilities } from '../src/tbcli/command-registry.mjs';

test('product owner mapping validates and reconciles matched missing and conflicts', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tbcli-profit-owners-'));
  const file = path.join(dir, 'owners.json');
  await fs.writeFile(file, JSON.stringify({ rows: [
    { platformProductId: '1001', ownerName: '吴晓燕' },
    { platformProductId: '1002', ownerName: '许能文' },
    { platformProductId: '1003', ownerName: '杨中鑫' },
  ] }));
  const validation = await validateProductOwnerFile(file, {
    shopKey: 'tmall:sanju-flagship', effectiveFrom: '2026-09-24', sourceRevision: 'test:1',
  });
  assert.equal(validation.ok, true);
  const client = { query: async () => ({ rows: [
    { platform_product_id: '1001', owner_name: '吴晓燕' },
    { platform_product_id: '1003', owner_name: '其他人', source_revision: 'old' },
  ] }) };
  const result = await reconcileProductOwners(client, validation);
  assert.equal(result.matchedCount, 1);
  assert.equal(result.missingCount, 1);
  assert.equal(result.conflictCount, 1);
  assert.equal(result.missing[0].platform_product_id, '1002');
});

test('product owner commands parse required provenance flags and are discoverable', () => {
  const args = parseArgs(['profit','owners','import','--input','owners.json','--shop-key','shop',
    '--effective-from','2026-09-24','--source-revision','aitable:1']);
  assert.equal(args.effectiveFrom, '2026-09-24');
  assert.equal(args.sourceRevision, 'aitable:1');
  const ids = businessCapabilities().map((item) => item.id);
  assert.ok(ids.includes('product-owner-reconcile'));
  assert.ok(ids.includes('product-owner-import-missing'));
  assert.ok(ids.includes('product-owner-sync'));
});

test('owner sync versions earlier and same-day conflicts, inserts missing, and verifies all rows', async () => {
  const current = new Map([
    ['1001', { version_id: '1', platform_product_id: '1001', owner_name: '吴晓燕', effective_from: '2026-07-01' }],
    ['1002', { version_id: '2', platform_product_id: '1002', owner_name: '杨中鑫', effective_from: '2026-09-24' }],
  ]);
  const statements = [];
  const client = { query: async (sql, params = []) => {
    statements.push(sql);
    if (sql.includes('FROM master.current_product_owners')) return { rows: [...current.values()] };
    if (sql.includes('FROM meta.master_data_batches')) return { rowCount: 0, rows: [] };
    if (sql.includes('INSERT INTO meta.master_data_batches')) return { rowCount: 1, rows: [{ batch_id: 'batch-1' }] };
    if (sql.includes("SET status='retired'")) { current.delete(params[2]); return { rowCount: 1 }; }
    if (sql.includes('SET effective_to=')) { current.delete(params[3]); return { rowCount: 1 }; }
    if (sql.includes('INSERT INTO master.product_owner_versions')) {
      for (const row of JSON.parse(params[4])) current.set(row.platform_product_id, row);
      return { rowCount: 3 };
    }
    return { rowCount: 1, rows: [] };
  } };
  const validation = { ok: true, shopKey: 'tmall:sanju-flagship', effectiveFrom: '2026-09-24',
    sourceRevision: 'feishu:1100', sourceFile: 'source.json', fileSha256: 'hash',
    sourceMetadata: {}, rowCount: 3, rows: [
      { platform_product_id: '1001', owner_name: '许能文' },
      { platform_product_id: '1002', owner_name: '许能文' },
      { platform_product_id: '1003', owner_name: '杨中鑫' },
    ] };
  const result = await syncProductOwners(client, validation);
  assert.equal(result.inserted, 1);
  assert.equal(result.superseded, 2);
  assert.deepEqual(result.verification, { ok: true, matched: 3 });
  assert.ok(statements.some((sql) => sql.includes("SET status='retired'")));
  assert.ok(statements.some((sql) => sql.includes('SET effective_to=')));
  assert.equal(statements.at(-1), 'COMMIT');
});
