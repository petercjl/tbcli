import {lstat, open} from 'node:fs/promises';
import path from 'node:path';
import {withAuthenticatedTaobaoSession} from '../browser-session.mjs';
import {DMP_CATALOG, dmpError, prepareDmpReport, prepareDmpItems, createDmpClient, collectDmpReport, normalizeDmpItems, normalizeDmpItemInfo, dmpPeriod, scrubDmpRaw} from '../dmp.mjs';

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

export async function runDmpItemInfo(opts = {}, {session = withAuthenticatedTaobaoSession, clientFactory = createDmpClient} = {}) {
 validateOptions(opts,['itemId','anchorId','timeoutMs','delayMs','minDelayMs','maxDelayMs']);
 const itemId=String(opts.itemId??'');if(!/^[1-9]\d{0,29}$/.test(itemId))throw dmpError('DMP_INVALID_INPUT','提供目标商品ID。');
 const plan=prepareDmpItems(opts),file=await outputFile(opts.out,true);
 try {
  const result=await session(opts,async({context})=>{const client=await clientFactory(context,plan);try{
  let response,request,original;
  if(opts.anchorId&&String(opts.anchorId)!==itemId){
   const anchorId=String(opts.anchorId);if(!/^[1-9]\d{0,29}$/.test(anchorId))throw dmpError('DMP_INVALID_INPUT','本店锚点ID无效。');
   const anchor=await client.request('itemInfo',{itemId:anchorId});
   if(anchor.body?.info?.ok!==true||String(anchor.body?.data?.id)!==anchorId)throw dmpError('DMP_ANCHOR_INFO_UNAVAILABLE','本店锚点资料不可用。');
   const day=await client.request('latestDay',{sceneCode:'goodsGrowPathSuccItemList'});
   const returned=typeof day.body?.data==='string'?day.body.data.trim().replaceAll('-',''):'';const latest=/^\d{8}$/.test(returned)?returned:dmpPeriod({days:1}).endDate.replaceAll('-','');
   const query={itemId:anchorId,keyword:itemId,page:'1',pageSize:'10',thedate:latest};
   response=await client.request('successItems',query);original=response;request={method:'GET',path:'/api/goods/grow/define/success/item/list',query};
   if(response.body?.info?.ok===true){const row=response.body?.data?.list?.find(x=>String(x.itemId??x.id)===itemId);response={...response,body:{...response.body,data:row??null}};}
  }else{response=await client.request('itemInfo',{itemId});request={method:'GET',path:'/api/goods/item/info',query:{itemId}};}
  const r=normalizeDmpItemInfo(response,itemId);r.account=client.account;r.source.request=request;if(original)r.source.raw=scrubDmpRaw(original.body);return r;
  }finally{await client.dispose();}});
  await save(file,result);console.log(JSON.stringify({ok:result.status==='available',status:result.status,itemId,out:path.resolve(opts.out)}));if(result.status!=='available')process.exitCode=2;return result;
 }catch(error){await save(file,{schemaVersion:1,command:'dmp item-info',itemId,status:'stopped',error:{code:error.code??'DMP_COLLECTION_FAILED'}});emitError(error,opts,opts.out);}finally{await file.close();}
}
