import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { startMaintenanceRun, recordMaintenanceEvent, finishMaintenanceRun, maintenanceRunStatus, validateMaintenancePlan } from '../src/tbcli/maintenance-run.mjs';
import { installSkill, getSkillStatus, updateSkill } from '../src/tbcli/commands/skill.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const skill = path.join(root, 'skill/tbcli');
const digest = (body) => createHash('sha256').update(body).digest('hex');
const plan = () => ({ schemaVersion: 1, timezone: 'Asia/Shanghai', warehouseKey: 'test-warehouse', policyDigest: 'a'.repeat(64), mode: 'fill-missing',
  targets: [{ dataset: 'item-overall', startDate: '2026-08-01', endDate: '2026-08-03', grain: 'day' }] });
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tbcli-maintenance-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let counter = 0;
  const json = async (value) => { const file = path.join(dir, `${counter++}.json`); await fs.writeFile(file, JSON.stringify(value), { flag: 'wx' }); return file; };
  return { dir, stateDir: path.join(dir, 'state'), json };
}
const baseEvent = { dataset: 'item-overall', startDate: '2026-08-01', endDate: '2026-08-03' };
const coverage = () => ({ datasetKey: 'item-overall', requestedPeriod: { startDate: '2026-08-01', endDate: '2026-08-03' }, complete: true, expectedPeriods: 3, coveredPeriods: 3, missingPeriods: [] });

test('status is read-only and plan validation refuses implicit scopes and secrets', async (t) => {
  const f = await fixture(t);
  assert.deepEqual((await maintenanceRunStatus(f)).runs, []);
  await assert.rejects(fs.stat(f.stateDir), /ENOENT/);
  assert.throws(() => validateMaintenancePlan({ ...plan(), password: 'never-save' }), /未允许字段/);
  assert.throws(() => validateMaintenancePlan({ ...plan(), mode: 'replace-all' }), /fill-missing/);
  assert.throws(() => validateMaintenancePlan({ ...plan(), targets: [] }), /targets/);
  assert.throws(() => validateMaintenancePlan({ ...plan(), warehouseKey: null }), /warehouseKey/);
  const missingDataset = plan(); delete missingDataset.targets[0].dataset;
  assert.throws(() => validateMaintenancePlan(missingDataset), /数据集/);
  const bad = plan(); bad.targets[0].startDate = '2026-02-30';
  assert.throws(() => validateMaintenancePlan(bad), /无效/);
  const duplicate = plan(); duplicate.targets.push(duplicate.targets[0]);
  assert.throws(() => validateMaintenancePlan(duplicate), /重复/);
});

test('single state directory excludes concurrent starts across callers and never steals stale locks', async (t) => {
  const f = await fixture(t); const input = await f.json(plan());
  const attempts = await Promise.allSettled([startMaintenanceRun({ ...f, input }), startMaintenanceRun({ ...f, input })]);
  assert.equal(attempts.filter((r) => r.status === 'fulfilled').length, 1);
  const run = attempts.find((r) => r.status === 'fulfilled').value;
  await assert.rejects(startMaintenanceRun({ ...f, input }), /RUN_ACTIVE/);
  await assert.rejects(finishMaintenanceRun({ ...f, runId: 'wrong-owner', status: 'cancelled' }), /RUN_NOT_OWNER/);
  assert.equal((await maintenanceRunStatus(f)).active.runId, run.runId);
  const result = await finishMaintenanceRun({ ...f, runId: run.runId, status: 'blocked' });
  assert.equal(result.ok, false);
  assert.deepEqual(result.pendingDatasets, ['item-overall']);
  assert.equal((await maintenanceRunStatus(f)).active, null);
  const next = await startMaintenanceRun({ ...f, input });
  assert.notEqual(next.runId, run.runId);
  assert.equal((await maintenanceRunStatus({ ...f, runId: run.runId })).result.status, 'blocked');
});

test('journal checks file hashes, stage prerequisites, scope and full final coverage', async (t) => {
  const f = await fixture(t); const run = await startMaintenanceRun({ ...f, input: await f.json(plan()) });
  const opts = { ...f, runId: run.runId };
  const artifact = await f.json({ fixture: 'source-workbook-placeholder' });
  const hash = digest(await fs.readFile(artifact));
  const event = { ...baseEvent, artifact, sha256: hash, rows: 1 };
  const record = async (value) => recordMaintenanceEvent({ ...opts, input: await f.json(value) });
  await assert.rejects(record({ ...event, stage: 'verified' }), /下载记录/);
  await record({ ...event, stage: 'downloaded' });
  await assert.rejects(record({ ...event, stage: 'verified', sha256: 'b'.repeat(64) }), /ARTIFACT_CHANGED/);
  await assert.rejects(record({ ...event, stage: 'imported' }), /验证记录/);
  await record({ ...event, stage: 'verified' });
  await record({ ...event, stage: 'imported' });
  await assert.rejects(finishMaintenanceRun({ ...opts, status: 'success' }), /不能报成功/);
  await assert.rejects(record({ ...event, stage: 'failed', errorCode: 'TEST_ERROR', endDate: '2026-08-04' }), /超出/);
  const badReceipt = await f.json({ ...coverage(), coveredPeriods: 2 });
  await assert.rejects(record({ ...baseEvent, stage: 'coverage', artifact: badReceipt, sha256: digest(await fs.readFile(badReceipt)) }), /COVERAGE_INCOMPLETE/);
  const receipt = await f.json(coverage());
  const receiptEvent = { ...baseEvent, stage: 'coverage', artifact: receipt, sha256: digest(await fs.readFile(receipt)) };
  await record(receiptEvent);
  await record({ ...baseEvent, stage: 'failed', errorCode: 'CLEANUP_REQUIRED' });
  await assert.rejects(finishMaintenanceRun({ ...opts, status: 'success' }), /不能报成功/);
  await record(receiptEvent);
  const result = await finishMaintenanceRun({ ...opts, status: 'success' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.pendingDatasets, []);
  const saved = await maintenanceRunStatus(opts);
  assert.equal(saved.events.length, 6);
  assert.equal(saved.result.status, 'success');
  assert.equal(saved.active, null);
  await assert.rejects(record(receiptEvent), /ENOENT/);
});

test('already-complete coverage supports a no-download successful run', async (t) => {
  const f = await fixture(t); const run = await startMaintenanceRun({ ...f, input: await f.json(plan()) });
  const receipt = await f.json(coverage());
  await recordMaintenanceEvent({ ...f, runId: run.runId, input: await f.json({ ...baseEvent, stage: 'coverage', artifact: receipt, sha256: digest(await fs.readFile(receipt)) }) });
  assert.equal((await finishMaintenanceRun({ ...f, runId: run.runId, status: 'success' })).ok, true);
});

test('runtime storage rejects package, symlink-to-package, Git and managed skill paths', async (t) => {
  const f = await fixture(t); const input = await f.json(plan());
  await assert.rejects(startMaintenanceRun({ input, stateDir: path.join(root, 'test-state') }), /插件安装目录/);
  const link = path.join(f.dir, 'package-link'); await fs.symlink(root, link, 'dir');
  await assert.rejects(startMaintenanceRun({ input, stateDir: path.join(link, 'new-child') }), /插件安装目录/);
  await assert.rejects(startMaintenanceRun({ input, stateDir: path.join(f.dir, 'skills', 'state') }), /Skill/);
  const repo = path.join(f.dir, 'repo'); await fs.mkdir(path.join(repo, '.git'), { recursive: true });
  await assert.rejects(startMaintenanceRun({ input, stateDir: path.join(repo, 'state') }), /Git 工作树/);
});

test('real CLI entry routes run commands and returns machine-readable evidence', async (t) => {
  const f = await fixture(t); const input = await f.json(plan());
  const cli = (...args) => JSON.parse(execFileSync(process.execPath, [path.join(root, 'scripts/tbcli.mjs'), 'maintenance', ...args, '--state-dir', f.stateDir, '--json'], { env: { ...process.env, TBCLI_UPDATE_CHECK: '0' }, encoding: 'utf8' }));
  assert.equal(cli('run-status').active, null);
  const started = cli('run-start', '--input', input);
  assert.equal(cli('run-status', '--run-id', started.runId).manifest.plan.targets.length, 1);
  const failedEvent = await f.json({ ...baseEvent, stage: 'failed', errorCode: 'AUTH_REQUIRED' });
  assert.equal(cli('run-record', '--run-id', started.runId, '--input', failedEvent).sequence, 1);
  assert.equal(cli('run-finish', '--run-id', started.runId, '--status', 'blocked').status, 'blocked');
});

test('one 19-table registry retains names and per-table daily switches', async () => {
  const text = await fs.readFile(path.join(skill, 'references/report-maintenance.md'), 'utf8');
  const table = text.slice(text.indexOf('| 业务表 |'), text.indexOf('\n\n', text.indexOf('| 业务表 |')));
  const rows = table.split('\n').slice(2).map((row) => row.split('|').slice(1, -1).map((cell) => cell.trim()));
  assert.equal(rows.length, 19);
  assert.equal(new Set(rows.map((r) => r[1])).size, 19);
  assert.ok(rows.every((r) => r.length === 6 && ['是', '否'].includes(r[5])));
  assert.equal(rows.find((r) => r[0] === '商品-连带')[3], '`week`');
  assert.ok(rows.filter((r) => r[0].startsWith('无界-')).every((r) => r[4].includes('15天转化')));
  assert.ok(rows.find((r) => r[0] === '商品-整体')[4].includes('--device overall'));
});

test('managed install and stale-copy update distribute the whole daily module together', async (t) => {
  const f = await fixture(t); const targetDir = path.join(f.dir, 'agent-target');
  const installed = await installSkill({ targetDir, mode: 'copy' });
  assert.equal(installed.current, true);
  const files = ['references/daily-update.md', 'references/report-maintenance.md', 'references/maintenance-run-contract.md', 'references/queries/daily-update.md', 'capabilities.json', 'adapters/sealseek.json'];
  for (const file of files) assert.equal(await fs.readFile(path.join(installed.destination, file), 'utf8'), await fs.readFile(path.join(skill, file), 'utf8'));
  const manifestPath = path.join(installed.destination, '.tbcli-managed.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath));
  // Test-owned managed copy simulates an older installed digest, not a real user installation.
  await fs.writeFile(manifestPath, JSON.stringify({ ...manifest, sourceDigest: 'old-fixture-version' }));
  assert.equal((await getSkillStatus(targetDir)).state, 'stale');
  const updated = await updateSkill({ targetDir });
  t.after(() => fs.rm(updated.backup, { recursive: true, force: true }));
  assert.equal(updated.current, true);
  assert.equal(await fs.readFile(path.join(updated.destination, 'references/daily-update.md'), 'utf8'), await fs.readFile(path.join(skill, 'references/daily-update.md'), 'utf8'));
});
