import path from 'node:path';
import {open,unlink} from 'node:fs/promises';
import {withAuthenticatedTaobaoSession} from '../browser-session.mjs';
import {createFinanceClient,financeCatalog} from '../finance-provider.mjs';
import {absent,writeNew,financeError,openRun,windows,collectPages,boundary,day,nextDay,hash} from '../finance-core.mjs';
function validate(opts){if(!['taobao','aggregate','deposit','alipay'].includes(opts.source))throw financeError('INVALID_SOURCE','--source 应为 taobao、aggregate、deposit 或 alipay。');}
export async function executeFinance(action,opts,{session=withAuthenticatedTaobaoSession,createClient=createFinanceClient}={}){
 if(action!=='identity')validate(opts);
 if(['fetch','balances'].includes(action)&&(!opts.accountId||!opts.shopKey||!opts.out))throw financeError('SCOPE_REQUIRED','需要明确 --shop-key、--account-id 和新的 --out。');
 let run,lock;
 if(action==='fetch'){
  if(!opts.dataset)throw financeError('DATASET_REQUIRED','需要明确 --dataset。');
  run=await openRun(opts);lock=await open(path.join(run.root,'.collect.lock'),'wx',0o600);
 }else if(opts.out)await absent(opts.out);
 try{
  const result=await session(opts,async({context})=>{
   const client=await createClient(context,opts);
   if(action==='identity')return client.identity();
   if(action==='catalog')return financeCatalog(client,opts.source,{dataset:opts.dataset});
   if(action==='balances')return getBalance(client,opts);
   const catalog=await financeCatalog(client,opts.source,{dataset:opts.dataset});if(catalog.availableDateRange?.from&&opts.startDate<catalog.availableDateRange.from)throw financeError('DATE_RANGE_UNAVAILABLE','起始日期早于平台当前可查询范围。');const ds=catalog.datasets.find(d=>d.id===opts.dataset);if(!ds)throw financeError('DATASET_UNKNOWN','指定账单不在实时目录中。');
   if(ds.dateType==='month'&&(opts.startDate.slice(8)!=='01'||nextDay(opts.endDate).slice(8)!=='01'))throw financeError('MONTH_SCOPE_REQUIRED','月粒度账单需要完整自然月边界。');
   const chunks=windows(opts.startDate,opts.endDate,{monthly:ds.dateType==='month'});const pageEvidence=[];
   for(const w of chunks){const key=hash(w);const result=await collectPages(async n=>{const id=`${key}:${n}`;return run.completed.get(id)?.payload??client.page(opts.source,opts.dataset,w,n,opts.accountId,catalog);},{source:opts.source,dataset:opts.dataset,onPage:(n,p)=>run.shard(`${key}:${n}`,{...p,window:w,page:n})});pageEvidence.push({window:w,...result});}
   const dates=[...run.completed.values()].flatMap(v=>(v.payload.rows??[]).map(r=>r.billCycle??r.accountTime??r.tradeTime??r.createTime??r.frozenDate??r.ds??r.gmtCreate).filter(Boolean).map(String)).sort();
   return run.finish({status:'complete',catalog,coverage:{requested:{from:opts.startDate,to:opts.endDate},collectionComplete:true,observedRecordRange:dates.length?{min:dates[0],max:dates.at(-1)}:null,businessCompleteness:'not-assessed',asOf:new Date().toISOString(),rows:pageEvidence.reduce((s,p)=>s+p.count,0),pageEvidence},bindingStatus:'caller-specified-unverified',warnings:['成功仅表示指定账单分页完成；账户归属、历史可用范围和经营分类由应用层检查。']});
  });
  if(action!=='fetch'&&opts.out)await writeNew(opts.out,result);
  console.log(JSON.stringify(action==='fetch'?{status:result.status,manifestPath:result.manifestPath,runId:result.runId,coverage:result.coverage}:result,null,2));return result;
 }catch(e){
  if(run){const saved=await run.finish({status:'partial',error:{code:e.code??'FINANCE_FAILED',message:'采集停止，成功分片已保留。'},coverage:{collectionComplete:false},warnings:['完成登录或验证后使用同一范围与 runId 恢复。']});throw financeError(e.code??'FINANCE_FAILED',`采集停止；证据 ${saved.manifestPath}；恢复标识 ${run.run.runId}。`);}throw e;
 }finally{if(lock){await lock.close();await unlink(path.join(run.root,'.collect.lock'));}}
}
export async function getBalance(client,opts){
 const capturedAt=new Date().toISOString();const b={schemaVersion:1,source:opts.source,shopKey:opts.shopKey,accountId:opts.accountId,requestedAt:opts.at,capturedAt,effectiveAt:null,currency:'CNY',unit:'yuan',sourceKind:null,status:'unavailable',total:null,available:null,frozen:null,withdrawing:null};
 if(!opts.at)throw financeError('AT_REQUIRED','余额需要 --at now 或带 +08:00 时区的自然月边界。');
 if(opts.at==='now'&&opts.source==='alipay'){
  const current=await client.currentAlipayBalance(opts.accountId);
  Object.assign(b,current,{status:'available',effectiveAt:new Date().toISOString(),sourceKind:'account_snapshot'});
 }else if(opts.at==='now'&&['aggregate','deposit'].includes(opts.source)){
  const data=await client.mtop('mtop.taobao.finance.fund.account.overview.get',{accountTypes:opts.source==='aggregate'?'AGGREGATED':'JIBU'});const t=opts.source==='aggregate'?data.aggregatedAccount:data.jibuOverview;
  if(t&&t.totalBalance!=null)Object.assign(b,{status:'available',effectiveAt:capturedAt,sourceKind:'account_snapshot',total:String(t.totalBalance),available:t.availableBalance==null?null:String(t.availableBalance),frozen:(t.frozenBalance??t.freezeBalance)==null?null:String(t.frozenBalance??t.freezeBalance),withdrawing:t.withdrawingBalance==null?null:String(t.withdrawingBalance),sourceRef:'mtop:fund.account.overview.get',evidence:data});
 }else{
  const edge=boundary(opts.at);if(!edge)throw financeError('UNSUPPORTED_BALANCE_BOUNDARY','该来源目前只支持 now 或上海时区自然月边界。');
  const end=new Date(Date.parse(edge.day+'T00:00:00Z')-86400000).toISOString().slice(0,10);const w={from:edge.month+'-01',to:end};
  if(opts.source==='aggregate'){const p=await client.page('aggregate','months',w,1,opts.accountId,{});const r=p.rows?.find(r=>String(r.ds).replace('-','')===edge.month.replace('-',''));if(r?.endingBalance!=null)Object.assign(b,{status:'available',effectiveAt:opts.at,sourceKind:'official_statement',total:String(r.endingBalance),sourceRef:p.sourceRef,evidence:p});}
  if(opts.source==='alipay'){
   const p=await client.page('alipay','ledger',w,1,opts.accountId,{});
   if(p.summary?.showEnd===true&&p.summary.endBalance!=null)Object.assign(b,{status:'available',effectiveAt:opts.at,sourceKind:'official_statement',total:String(p.summary.endBalance),sourceRef:p.sourceRef,evidence:{window:w,balanceField:'endBalance',summary:p.summary}});
   else {const d=new Date(edge.day+'T00:00:00Z');const end=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).toISOString().slice(0,10);const window={from:edge.day,to:end};const q=await client.page('alipay','ledger',window,1,opts.accountId,{});if(q.summary?.showBegin===true&&q.summary.beginBalance!=null)Object.assign(b,{status:'available',effectiveAt:opts.at,sourceKind:'official_statement',total:String(q.summary.beginBalance),sourceRef:q.sourceRef,evidence:{window,balanceField:'beginBalance',summary:q.summary}});}
  }
 }
 b.supportedGranularity=opts.source==='deposit'?'current-snapshot':opts.source==='aggregate'?'current-snapshot,month-boundary':opts.source==='alipay'?'current-snapshot,completed-month-boundary':'none';
 if(b.status==='unavailable')b.reason='平台未提供该时点的独立余额；保留 null。';return b;
}
export const runFinanceIdentity=opts=>executeFinance('identity',opts);
export const runFinanceCatalog=opts=>executeFinance('catalog',opts);
export const runFinanceFetch=opts=>executeFinance('fetch',opts);
export const runFinanceBalances=opts=>executeFinance('balances',opts);
