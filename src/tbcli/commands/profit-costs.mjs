import { assertMaintainerAccess, connectDatabase, loadDatabaseConfig } from '../database.mjs';
import { reconcileWdtCosts, syncWdtCosts, validateWdtCostExport } from '../profit-costs.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';

const execFileAsync=promisify(execFile);

export async function runProfitCostsFetch(args) {
  if(!args.out) throw new Error('缺少 --out');
  try { await fs.stat(args.out); throw new Error(`输出文件已存在：${args.out}`); }
  catch(error) { if(error.code!=='ENOENT') throw error; }
  let stdout;
  try { ({stdout}=await execFileAsync('wdtcli',['openapi','goods','export-costs','--out',args.out,'--json'],
    {maxBuffer:2*1024*1024,timeout:300000})); }
  catch(error) {
    if(error.code==='ENOENT') throw new Error('缺少 wdtcli：请由维护者安装可用的旺店通采集入口');
    throw error;
  }
  const result=JSON.parse(stdout);
  console.log(JSON.stringify(result,null,2));
  return result;
}

function summarize(validation,reconciliation) {
  return {source:{file:validation.file,fileSha256:validation.fileSha256,
    fetchedAt:validation.fetchedAt,goodsCount:validation.goodsCount,specCount:validation.specCount},
    reconciliation};
}

export async function runProfitCostsReconcile(args) {
  const validation=await validateWdtCostExport(args.input,args);
  const client=await connectDatabase(await loadDatabaseConfig(args.config),'reader');
  try {
    const result=summarize(validation,await reconcileWdtCosts(client,validation));
    console.log(JSON.stringify(result,null,2));
    return result;
  } finally { await client.end(); }
}

export async function runProfitCostsSync(args) {
  const validation=await validateWdtCostExport(args.input,args);
  const config=await loadDatabaseConfig(args.config);
  assertMaintainerAccess(config);
  const client=await connectDatabase(config,'ingest');
  try {
    const result={source:{file:validation.file,fileSha256:validation.fileSha256,
      fetchedAt:validation.fetchedAt,goodsCount:validation.goodsCount,specCount:validation.specCount},
      synced:await syncWdtCosts(client,validation)};
    console.log(JSON.stringify(result,null,2));
    return result;
  } finally { await client.end(); }
}
