import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const DEFAULT_MAINTENANCE_STATE = path.join(os.homedir(), '.local', 'state', 'tbcli', 'report-maintenance');
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const HASH = /^[a-f0-9]{64}$/;

function requireValue(ok, message) { if (!ok) throw new Error(message); }
function exactKeys(value, keys) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value), '需要 JSON 对象');
  requireValue(Object.keys(value).every((key) => keys.includes(key)), '存在未允许字段；禁止把密码、登录态或原始错误正文写入运行记录');
}
function dates(value) {
  for (const key of ['startDate', 'endDate']) {
    requireValue(DATE.test(value[key]) && Number.isFinite(Date.parse(value[key]))
      && new Date(value[key]).toISOString().slice(0, 10) === value[key], `无效 ${key}`);
  }
  requireValue(value.startDate <= value.endDate, '日期区间倒置');
}
export function validateMaintenancePlan(plan) {
  exactKeys(plan, ['schemaVersion', 'timezone', 'warehouseKey', 'policyDigest', 'mode', 'targets']);
  requireValue(plan.schemaVersion === 1 && plan.mode === 'fill-missing', '仅支持 schemaVersion=1 / fill-missing');
  requireValue(typeof plan.warehouseKey === 'string' && ID.test(plan.warehouseKey) && HASH.test(plan.policyDigest), '需要非秘密 warehouseKey 和规则 SHA-256');
  requireValue(typeof plan.timezone === 'string', '需要明确时区');
  new Intl.DateTimeFormat('en', { timeZone: plan.timezone }).format();
  requireValue(Array.isArray(plan.targets) && plan.targets.length > 0 && plan.targets.length <= 100, 'targets 必须有 1–100 张明确表');
  const seen = new Set();
  for (const target of plan.targets) {
    exactKeys(target, ['dataset', 'startDate', 'endDate', 'grain']);
    requireValue(typeof target.dataset === 'string' && ID.test(target.dataset) && !seen.has(target.dataset), '数据集键无效或重复');
    requireValue(['day', 'week'].includes(target.grain), 'grain 必须是 day 或 week');
    dates(target); seen.add(target.dataset);
  }
  return plan;
}

async function readJson(file) {
  const stat = await fs.stat(file);
  requireValue(stat.isFile() && stat.size <= 1024 * 1024, 'JSON 必须是至多 1MiB 的文件');
  return JSON.parse(await fs.readFile(file, 'utf8'));
}
async function writeNew(file, data) {
  await fs.writeFile(file, `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}
async function exists(file) {
  try { await fs.lstat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
async function resolveState(input) {
  const requested = path.resolve(input || DEFAULT_MAINTENANCE_STATE);
  // Resolve even an absent leaf through its real existing ancestor (symlink-safe).
  const suffix = []; let ancestor = requested;
  while (!await exists(ancestor)) { suffix.unshift(path.basename(ancestor)); ancestor = path.dirname(ancestor); }
  const resolved = path.join(await fs.realpath(ancestor), ...suffix);
  const packageRoot = await fs.realpath(PACKAGE_ROOT);
  requireValue(resolved !== path.parse(resolved).root && resolved !== os.homedir(), '不能使用根目录或用户主目录作为运行目录');
  requireValue(resolved !== packageRoot && !resolved.startsWith(`${packageRoot}${path.sep}`), '运行记录不能放进插件安装目录');
  requireValue(!resolved.split(path.sep).some((part) => ['node_modules', '.git', 'skills', 'skill_pool'].includes(part)), '运行记录不能放进 Git、npm 或 Skill 目录');
  for (let parent = resolved; ; parent = path.dirname(parent)) {
    requireValue(!await exists(path.join(parent, '.git')), '运行记录不能放进 Git 工作树');
    if (parent === path.dirname(parent)) break;
  }
  return resolved;
}
async function withOperation(state, action) {
  await fs.mkdir(state, { recursive: true, mode: 0o700 });
  const lock = path.join(state, 'operation.lock');
  try { await fs.mkdir(lock, { mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('STATE_BUSY：其他进程正在记录；异常中断后需管理员核查锁，不自动抢占'); throw error; }
  try { return await action(); } finally { await fs.rmdir(lock); }
}
function runDir(state, runId) {
  requireValue(typeof runId === 'string' && ID.test(runId), '需要有效 --run-id');
  return path.join(state, 'runs', runId);
}
async function activeRun(state, runId) {
  const active = await readJson(path.join(state, 'active.json'));
  requireValue(active.runId === runId, 'RUN_NOT_OWNER：不是当前运行，不允许修改记录或解锁');
  return active;
}
async function loadRun(state, runId) {
  const dir = runDir(state, runId);
  const manifest = await readJson(path.join(dir, 'manifest.json'));
  const names = (await fs.readdir(path.join(dir, 'events'))).filter((name) => /^\d{6}\.json$/.test(name)).sort();
  const events = [];
  for (const name of names) events.push(await readJson(path.join(dir, 'events', name)));
  const result = await exists(path.join(dir, 'result.json')) ? await readJson(path.join(dir, 'result.json')) : null;
  return { dir, manifest, events, result };
}

export async function startMaintenanceRun({ stateDir, input } = {}) {
  requireValue(input, '缺少 --input <计划.json>');
  const plan = validateMaintenancePlan(await readJson(input));
  const state = await resolveState(stateDir);
  return withOperation(state, async () => {
    requireValue(!await exists(path.join(state, 'active.json')), 'RUN_ACTIVE：已有运行；先查看 run-status，禁止自动抢锁');
    const runId = randomUUID(); const dir = runDir(state, runId);
    await fs.mkdir(path.join(dir, 'events'), { recursive: true, mode: 0o700 });
    await fs.mkdir(path.join(dir, 'artifacts'), { mode: 0o700 });
    const manifest = { schemaVersion: 1, runId, startedAt: new Date().toISOString(), plan };
    await writeNew(path.join(dir, 'manifest.json'), manifest);
    await writeNew(path.join(state, 'active.json'), { runId, startedAt: manifest.startedAt });
    return { ok: true, runId, stateDir: state, runDir: dir, artifactDir: path.join(dir, 'artifacts'), plan };
  });
}

function validateEvent(event, plan) {
  exactKeys(event, ['dataset', 'startDate', 'endDate', 'stage', 'artifact', 'sha256', 'rows', 'errorCode']);
  dates(event);
  const target = plan.targets.find((target) => target.dataset === event.dataset);
  requireValue(target && event.startDate >= target.startDate && event.endDate <= target.endDate, '事件超出显式计划范围');
  requireValue(['downloaded', 'verified', 'imported', 'coverage', 'failed'].includes(event.stage), '未知事件阶段');
  if (event.stage === 'failed') {
    requireValue(/^[A-Z][A-Z0-9_]{0,79}$/.test(event.errorCode), '失败只记录标准 errorCode，不记录秘密或原始错误正文');
  } else {
    requireValue(typeof event.artifact === 'string' && path.isAbsolute(event.artifact) && HASH.test(event.sha256), '非失败事件必须提供本地文件绝对路径和 SHA-256');
  }
  if (event.rows !== undefined) requireValue(Number.isSafeInteger(event.rows) && event.rows >= 0, 'rows 必须是非负整数');
  return target;
}
export async function recordMaintenanceEvent({ stateDir, runId, input } = {}) {
  requireValue(input, '缺少 --input <事件.json>');
  const event = await readJson(input); const state = await resolveState(stateDir);
  return withOperation(state, async () => {
    await activeRun(state, runId);
    const run = await loadRun(state, runId);
    requireValue(!run.result, '运行已结束');
    validateEvent(event, run.manifest.plan);
    if (event.stage !== 'failed') {
      const actual = createHash('sha256').update(await fs.readFile(event.artifact)).digest('hex');
      requireValue(actual === event.sha256, 'ARTIFACT_CHANGED：文件散列不一致');
    }
    const same = run.events.filter((entry) => entry.dataset === event.dataset && entry.startDate === event.startDate && entry.endDate === event.endDate);
    if (event.stage === 'verified') requireValue(same.some((entry) => entry.stage === 'downloaded' && entry.sha256 === event.sha256), '验证前缺少同一文件下载记录');
    if (event.stage === 'imported') requireValue(same.some((entry) => entry.stage === 'verified' && entry.sha256 === event.sha256), '导入前缺少同一文件验证记录');
    if (event.stage === 'coverage') {
      const receipt = await readJson(event.artifact);
      requireValue(receipt.datasetKey === event.dataset && receipt.requestedPeriod?.startDate === event.startDate
        && receipt.requestedPeriod?.endDate === event.endDate && receipt.complete === true
        && Array.isArray(receipt.missingPeriods) && receipt.missingPeriods.length === 0
        && Number.isInteger(receipt.expectedPeriods) && receipt.expectedPeriods > 0
        && receipt.coveredPeriods === receipt.expectedPeriods, 'COVERAGE_INCOMPLETE：覆盖回执范围或完整性不符');
    }
    const record = { ...event, recordedAt: new Date().toISOString() };
    await writeNew(path.join(run.dir, 'events', `${String(run.events.length + 1).padStart(6, '0')}.json`), record);
    return { ok: true, runId, sequence: run.events.length + 1, event: record };
  });
}

export async function finishMaintenanceRun({ stateDir, runId, status } = {}) {
  requireValue(['success', 'partial', 'blocked', 'cancelled'].includes(status), '--status 必须是 success、partial、blocked 或 cancelled');
  const state = await resolveState(stateDir);
  return withOperation(state, async () => {
    await activeRun(state, runId);
    const run = await loadRun(state, runId);
    if (run.result) {
      requireValue(run.result.status === status, '已有终态不可改写');
      await fs.unlink(path.join(state, 'active.json'));
      return { ...run.result, recoveredUnlock: true };
    }
    const complete = run.manifest.plan.targets.filter((target) => {
      const matching = run.events.filter((event) => event.dataset === target.dataset);
      const last = matching.at(-1);
      return last?.stage === 'coverage' && last.startDate === target.startDate && last.endDate === target.endDate;
    }).map((target) => target.dataset);
    requireValue(status !== 'success' || complete.length === run.manifest.plan.targets.length, '不能报成功：每张表需要最后一次完整检查区间的覆盖回执');
    const result = { ok: status === 'success', runId, status, completedDatasets: complete,
      pendingDatasets: run.manifest.plan.targets.map((target) => target.dataset).filter((dataset) => !complete.includes(dataset)),
      finishedAt: new Date().toISOString(), eventCount: run.events.length };
    await writeNew(path.join(run.dir, 'result.json'), result);
    await fs.unlink(path.join(state, 'active.json'));
    return result;
  });
}

export async function maintenanceRunStatus({ stateDir, runId } = {}) {
  const state = await resolveState(stateDir);
  const active = await exists(path.join(state, 'active.json')) ? await readJson(path.join(state, 'active.json')) : null;
  if (runId) return { ok: true, stateDir: state, active, ...await loadRun(state, runId) };
  const dirs = await exists(path.join(state, 'runs')) ? await fs.readdir(path.join(state, 'runs')) : [];
  const runs = [];
  for (const id of dirs.filter((id) => ID.test(id))) {
    const dir = runDir(state, id);
    if (!await exists(path.join(dir, 'manifest.json'))) continue;
    const manifest = await readJson(path.join(dir, 'manifest.json'));
    const result = await exists(path.join(dir, 'result.json')) ? await readJson(path.join(dir, 'result.json')) : null;
    runs.push({ runId: id, startedAt: manifest.startedAt, status: result?.status || 'unfinished', plan: manifest.plan });
  }
  return { ok: true, stateDir: state, active, runs: runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt)) };
}
