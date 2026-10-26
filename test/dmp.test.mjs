import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp, readFile, writeFile, lstat, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {parseArgs} from '../src/tbcli/args.mjs';
import {DMP_PATHS, COST_FIELDS, METRIC_FIELDS, prepareDmpReport, dmpPeriod, metricsBody, normalizeDmpCosts, normalizeDmpMetrics, dmpComputed, guardedDmpRequest, collectDmpReport, scrubDmpRaw, createDmpClient} from '../src/tbcli/dmp.mjs';
import {runDmpReport} from '../src/tbcli/commands/dmp.mjs';

const now = new Date('2026-04-01T17:00:00Z');
const period = {startDate: '2026-04-01', endDate: '2026-04-02', days: 2};
const response = data => ({httpStatus: 200, body: {info: {ok: true}, data}});
const row = (date, value = 0) => ({date, ...Object.fromEntries(Object.values(COST_FIELDS).map(k => [k, value]))});
const costs = () => response({lineInfo: [row('20260401', '1.01'), row('20260402', 0)], stages: [{actionText: '[]'}]});
const metrics = () => response({INDEX_CARD: {fields: Object.values(METRIC_FIELDS).reverse().map(id => ({id})), values: ['9', '0', '100', '2.345', '10'].map(value => ({value}))}, rangeDesc: '数据范围为：2026-04-01至2026-04-02'});

test('DMP parses options, IDs stay strings, explicit anchor and module choices are preserved', () => {
  const p = prepareDmpReport(parseArgs(['dmp', 'report', '--item-ids', '123，456 123', '--anchor-id', '999', '--days', '7', '--modules', 'all']), now);
  assert.deepEqual(p.itemIds, ['123', '456']); assert.equal(p.anchorId, '999'); assert.equal(p.period.days, 7);
  assert.equal(p.period.endDate, '2026-04-01'); assert.equal(p.period.startDate, '2026-03-26');
  assert.deepEqual(p.delayRange, {minDelayMs: 1000, maxDelayMs: 2000});
});
test('DMP preflight refuses ambiguous inputs, invalid dates, implicit anchors and future data', () => {
  for (const opts of [{itemId: '1'}, {itemId: '1', itemIds: '2'}, {itemId: '1e9', modules: 'metrics'}, {itemId: '1', modules: 'typo'}, {itemId: '1', modules: 'metrics', anchorId: '2'}]) assert.throws(() => prepareDmpReport(opts, now), {code: 'DMP_INVALID_INPUT'});
  for (const opts of [{startDate: '2026-02-30', endDate: '2026-03-01'}, {startDate: '2026-04-02', endDate: '2026-04-02'}, {startDate: '2026-04-01'}, {days: 7, startDate: '2026-03-01', endDate: '2026-03-07'}, {days: ''}, {days: '1.5'}]) assert.throws(() => dmpPeriod(opts, now), {code: 'DMP_INVALID_INPUT'});
});
test('dataset156 sends one target and an explicit inclusive period, retaining complete precision', () => {
  const body = metricsBody('123', period), conf = JSON.parse(body.conf), filters = JSON.parse(body.filterCondition);
  assert.equal(body.datasetId, 156); assert.equal(body.type, 'INDEX_CARD');
  assert.deepEqual(conf.indexList.map(x => x.fieldId), [6986, 6895, 6813, 8291, 8290]);
  assert.deepEqual(filters[0].values, ['2026-04-01', '2026-04-02']); assert.deepEqual(filters[1].values, ['123']);
});
test('complete promotion coverage sums numbers, retains zero and keeps unit unverified', () => {
  const c = normalizeDmpCosts(costs(), period);
  assert.equal(c.status, 'complete'); assert.equal(c.totals.total, 5.05); assert.equal(c.daily[1].total, 0); assert.equal(c.unit, 'unverified'); assert.equal(c.stages[0].actionText, '[]');
});
test('missing, duplicate, invalid and out-of-period promotion records cannot become complete totals', () => {
  for (const rows of [[null, row('20260402')], [row('20260401')], [row('20260401'), row('20260401'), row('20260402')], [row('20260401'), row('20260402'), row('20260403')], [row('bad'), row('20260402')], [row('20260401'), {...row('20260402'), [COST_FIELDS.keyword]: null}], [row('20260401'), {...row('20260402'), [COST_FIELDS.keyword]: ''}]]) {
    const c = normalizeDmpCosts(response({lineInfo: rows}), period); assert.equal(c.status, 'partial'); assert.equal(c.totals, null);
  }
  assert.equal(normalizeDmpCosts(response({lineInfo: []}), period).status, 'empty');
  assert.equal(normalizeDmpCosts({httpStatus: 200, body: {}}, period).error, 'DMP_EMPTY_RESPONSE');
  assert.equal(normalizeDmpCosts({httpStatus: 200, body: {info: {ok: false, message: '当前商家无权查询本品'}}}, period).error, 'DMP_PERMISSION_DENIED');
});
test('metric parser maps by field ID rather than field order; wrong periods and null are partial', () => {
  const m = normalizeDmpMetrics(metrics(), period); assert.equal(m.status, 'complete'); assert.equal(m.values.avgOrderValue, 2.345); assert.equal(m.values.paidClicks, 0);
  const mismatch = metrics(); mismatch.body.data.rangeDesc = '数据范围为：2026-04-01'; assert.equal(normalizeDmpMetrics(mismatch, period).status, 'partial');
  const missing = metrics(); missing.body.data.INDEX_CARD.values[0].value = null; assert.equal(normalizeDmpMetrics(missing, period).status, 'partial');
  const duplicate = metrics(); duplicate.body.data.INDEX_CARD.fields[0].id = duplicate.body.data.INDEX_CARD.fields[1].id; assert.equal(normalizeDmpMetrics(duplicate, period).error, 'DMP_SCHEMA_CHANGED');
  const single = metrics(); single.body.data.rangeDesc = '数据范围为：2026-04-01'; assert.equal(normalizeDmpMetrics(single, {...period, endDate: period.startDate, days: 1}).status, 'complete');
});
test('derived metrics use full-precision price and protect zero denominator', () => {
  const out = dmpComputed({metrics: normalizeDmpMetrics(metrics(), period), costs: normalizeDmpCosts(costs(), period)});
  assert.equal(out.estimatedGmv, 23.45); assert.equal(out.assumingCostsAreCny.blendedCpc, null);
  assert.equal(dmpComputed({metrics: {status: 'partial'}}).estimatedGmv, undefined);
});
test('shared policy checks before and after the delay and after the response', async () => {
  const events = [];
  await guardedDmpRequest({}, {}, async () => {events.push('request'); return response({});}, {wait: async () => events.push('wait'), check: async () => events.push('check')});
  assert.deepEqual(events, ['check', 'wait', 'check', 'request', 'check']);
  for (const r of [{httpStatus: 429}, {httpStatus: 403}, {httpStatus: 200, verification: true}, {httpStatus: 200, body: {info: {message: '请完成验证'}}}]) await assert.rejects(guardedDmpRequest({}, {}, async () => r, {wait: async () => {}, check: async () => {}}), {code: 'TAOBAO_VERIFICATION_REQUIRED'});
  let called = false;
  await assert.rejects(guardedDmpRequest({}, {}, async () => {called = true;}, {check: async () => {throw Error('blocked');}})); assert.equal(called, false);
});
test('createDmpClient routes identity and data through shared guarded waiting and detects blocked data', async () => {
  let calls = 0, disposed = false;
  const page = {url: () => 'https://dmp.taobao.com/index_new.html', evaluate: async () => ({url: 'https://dmp.taobao.com', title: 'DMP', text: '', frames: ''}), evaluateHandle: async () => ({evaluate: async (_fn, spec) => {calls++; return spec.kind === 'login' ? {httpStatus: 200, body: {loggedIn: true, account: 'test'}} : {httpStatus: 429};}, dispose: async () => {disposed = true;}})};
  const client = await createDmpClient({pages: () => [page]}, {delayRange: {minDelayMs: 0, maxDelayMs: 0}, timeoutMs: 1000});
  await assert.rejects(client.request('costs'), {code: 'TAOBAO_VERIFICATION_REQUIRED'}); await client.dispose(); assert.equal(calls, 2); assert.equal(disposed, true);
});
test('partial costs do not block independent metrics; verification stops later modules and items', async () => {
  const plan = {itemIds: ['1'], anchorId: '2', modules: 'all', period}, seen = [];
  const report = {items: []};
  await collectDmpReport({account: 'test', request: async (kind, query, body) => {seen.push({kind, query, body}); return kind === 'costs' ? {httpStatus: 200, body: {}} : metrics();}}, plan, report);
  assert.equal(report.status, 'partial'); assert.equal(report.items[0].metrics.status, 'complete'); assert.equal(report.items[0].costs.status, 'unavailable'); assert.equal(seen[0].query.itemId, '2'); assert.equal(seen[0].query.successItemId, '1'); assert.equal(seen[1].body.datasetId, 156);
  let n = 0;
  await assert.rejects(collectDmpReport({request: async () => {n++; throw Object.assign(Error('verify'), {code: 'TAOBAO_VERIFICATION_REQUIRED'});}}, {...plan, itemIds: ['1', '3']}, {items: []})); assert.equal(n, 1);
});
test('raw response scrubbing removes auth keys without removing business fields', () => {
  assert.deepEqual(scrubDmpRaw({csrfId: 'secret', _tb_token_: 'secret', data: {gmv: 1, note: 'https://test/?_csrf=secret&x=1'}}), {data: {gmv: 1, note: 'https://test/?_csrf=[redacted]&x=1'}});
});
test('command preflight protects existing outputs and authenticates before client use; stopped output remains readable', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tbcli-dmp-test-')), out = path.join(dir, 'data.json');
  const originalExit = process.exitCode, originalLog = console.log; console.log = () => {};
  try {
    await writeFile(out, 'owned', {flag: 'wx'}); let entered = false;
    const opts = {itemId: '1', modules: 'metrics', startDate: '2026-04-01', endDate: '2026-04-02', out, json: true};
    await assert.rejects(runDmpReport(opts, {session: async () => {entered = true;}}), {code: 'OUTPUT_EXISTS'}); assert.equal(entered, false); assert.equal(await readFile(out, 'utf8'), 'owned');
    const fresh = path.join(dir, 'new.json'); const events = [];
    await runDmpReport({...opts, out: fresh}, {session: async (_o, cb) => {events.push('auth'); return cb({context: {}});}, clientFactory: async () => {events.push('client'); return {dispose: async () => {}, request: async () => {throw Object.assign(Error('verify'), {code: 'TAOBAO_VERIFICATION_REQUIRED'});}};}});
    assert.deepEqual(events, ['auth', 'client']); const saved = JSON.parse(await readFile(fresh, 'utf8')); assert.equal(saved.status, 'stopped'); assert.equal(saved.error.code, 'TAOBAO_VERIFICATION_REQUIRED'); if (process.platform !== 'win32') assert.equal((await lstat(fresh)).mode & 0o777, 0o600);
    await assert.rejects(runDmpReport({...opts, _: ['dmp', 'report', '--typo']}), {code: 'DMP_INVALID_INPUT'});
  } finally {console.log = originalLog; process.exitCode = originalExit; await rm(dir, {recursive: true, force: true});}
});
