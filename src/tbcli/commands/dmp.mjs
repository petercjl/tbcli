import {lstat, open} from 'node:fs/promises';
import path from 'node:path';
import {withAuthenticatedTaobaoSession} from '../browser-session.mjs';
import {DMP_CATALOG, dmpError, prepareDmpReport, prepareDmpItems, createDmpClient, collectDmpReport, normalizeDmpItems} from '../dmp.mjs';

function validateOptions(opts, own) {
  const allowed = new Set(['_', 'json', 'out', 'cdpUrl', 'profileDir', 'chromePath', 'sessionMode', ...own]);
  if ((opts._ && opts._.length !== 2) || Object.keys(opts).some(k => !allowed.has(k))) throw dmpError('DMP_INVALID_INPUT', 'DMP 命令包含未知或不适用的参数；请查阅 dmp catalog 和命令帮助。');
}

async function outputFile(out, required = false) {
  if (!out && !required) return null;
  if (!out || path.extname(out).toLowerCase() !== '.json') throw dmpError('DMP_INVALID_OUTPUT', '需要新的 --out FILE.json。');
  try { await lstat(out); throw dmpError('OUTPUT_EXISTS', '输出已存在，请使用新的文件名。'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return open(out, 'wx', 0o600);
}
async function save(file, data) {
  if (!file) return;
  const buffer = Buffer.from(JSON.stringify(data, null, 2) + '\n');
  let offset = 0;
  while (offset < buffer.length) { const written = await file.write(buffer, offset, buffer.length - offset, offset); offset += written.bytesWritten; }
  await file.truncate(buffer.length); await file.sync();
}
function emitError(error, opts, out) {
  const result = {ok: false, code: error.code ?? 'DMP_COLLECTION_FAILED', message: 'DMP 取数停止；已取得的数据保留在输出文件。', ...(out ? {out: path.resolve(out)} : {})};
  if (opts.json) console.log(JSON.stringify(result));
  else console.error(`${result.code}: ${result.message}`);
  process.exitCode = 1;
}
export async function runDmpCatalog(opts = {}) {
  validateOptions(opts, []);
  const file = await outputFile(opts.out);
  try { await save(file, DMP_CATALOG); console.log(JSON.stringify(DMP_CATALOG, null, 2)); return DMP_CATALOG; }
  finally { await file?.close(); }
}
export async function runDmpItems(opts = {}, {session = withAuthenticatedTaobaoSession, clientFactory = createDmpClient} = {}) {
  validateOptions(opts, ['page', 'pageSize', 'timeoutMs', 'delayMs', 'minDelayMs', 'maxDelayMs']);
  const plan = prepareDmpItems(opts), file = await outputFile(opts.out);
  try {
    const result = await session(opts, async ({context}) => {
      const client = await clientFactory(context, plan);
      try { return {...normalizeDmpItems(await client.request('items', {page: String(plan.page), pageSize: String(plan.pageSize)}), plan), account: client.account}; }
      finally { await client.dispose(); }
    });
    await save(file, result); console.log(JSON.stringify(result, null, 2)); return result;
  } catch (error) { await save(file, {status: 'failed', error: {code: error.code ?? 'DMP_COLLECTION_FAILED'}}); emitError(error, opts, opts.out); }
  finally { await file?.close(); }
}
export async function runDmpReport(opts = {}, {session = withAuthenticatedTaobaoSession, clientFactory = createDmpClient} = {}) {
  validateOptions(opts, ['itemId', 'itemIds', 'anchorId', 'modules', 'startDate', 'endDate', 'days', 'timeoutMs', 'delayMs', 'minDelayMs', 'maxDelayMs']);
  const plan = prepareDmpReport(opts), file = await outputFile(opts.out, true);
  const report = {schemaVersion: 1, command: 'dmp report', status: 'running', startedAt: new Date().toISOString(), period: plan.period, anchorId: plan.anchorId, modules: plan.modules, requestPolicy: plan.delayRange, items: [], warnings: ['推广字段单位尚未独立核验；CNY 计算仅为所提供方法下的假设。', '数据可用性限于当前账户、目标商品和日期，无法保证任意商品 ID。']};
  try {
    await save(file, report);
    await session(opts, async ({context}) => {
      const client = await clientFactory(context, plan);
      try { await collectDmpReport(client, plan, report, () => save(file, report)); }
      finally { await client.dispose(); }
    });
    report.finishedAt = new Date().toISOString(); await save(file, report);
    console.log(JSON.stringify({ok: report.status === 'complete', status: report.status, out: path.resolve(opts.out), account: report.account, period: report.period, items: report.items.map(e => ({itemId: e.itemId, costs: e.costs.status, metrics: e.metrics.status, computed: e.computed}))}, null, 2));
    if (report.status !== 'complete') process.exitCode = 2;
    return report;
  } catch (error) {
    report.status = 'stopped'; report.finishedAt = new Date().toISOString(); report.error = {code: error.code ?? 'DMP_COLLECTION_FAILED'};
    await save(file, report); emitError(error, opts, opts.out); return report;
  } finally { await file.close(); }
}
