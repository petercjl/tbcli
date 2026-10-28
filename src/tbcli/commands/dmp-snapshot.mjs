import {lstat,open} from 'node:fs/promises';
import path from 'node:path';
import {withAuthenticatedTaobaoSession} from '../browser-session.mjs';
import {prepareDmpTarget,metricsBody,createDmpClient,scrubDmpRaw,dmpError} from '../dmp.mjs';

export function prepareDmpSnapshot(opts,now){
 const allowed=['_','json','out','itemId','itemIds','startDate','endDate','days','timeoutMs','delayMs','minDelayMs','maxDelayMs','browserRole','cdpUrl','profileDir','chromePath','sessionMode'];
 if(Object.keys(opts).some(k=>!allowed.includes(k)))throw dmpError('DMP_INVALID_INPUT','独立商品快照仅接受目标商品和日期及声明的会话选项。');
 const {itemIds,period,delayRange,timeoutMs}=prepareDmpTarget(opts,now);
 if(itemIds.length!==1)throw dmpError('DMP_INVALID_INPUT','快照每次查询一个商品。');
 return {itemIds,period,delayRange,timeoutMs};
}
export function snapshotRequests(plan,contextItemId){
 const itemId=plan.itemIds[0],period=plan.period,body=metricsBody(itemId,period),conf=JSON.parse(body.conf);
 conf.indexList.push({aggr:'SUM',fieldId:6896},{aggr:'SUM',fieldId:6897});body.conf=JSON.stringify(conf);
 const query={itemId:contextItemId,succItemIds:itemId,startDate:period.startDate,endDate:period.endDate};
 const table={datasetId:175,type:'TABLE',conf:JSON.stringify({columnList:[],conditionList:[{fieldId:7460},{fieldId:7463}],indexList:[7469,7468,7465,7464].map(fieldId=>({aggr:'SUM',fieldId})),rowList:[{fieldId:7459}],userPageSize:100}),filterCondition:JSON.stringify([{id:7460,fieldId:7460,name:'商品ID',expression:'item_id',type:'dim',dataType:'number',displayType:'MULTI_SELECTOR',status:1,datasetId:175,values:[itemId]},{id:7463,fieldId:7463,name:'分区',expression:'ds',type:'dim',dataType:'string',displayType:'DATE_RANGE',dataFormat:'yyyyMMdd',status:1,datasetId:175,values:[period.startDate,period.endDate]}]),page:1,pageSize:100};
 return [{name:'metrics7',kind:'metrics',query:{},body},{name:'scenes',kind:'scenes',query,needsContext:true},{name:'keywords',kind:'keywords',query,needsContext:true},{name:'crowdRanges',kind:'crowd',query,needsContext:true},{name:'crowdTable',kind:'metrics',query:{},body:table}];
}
export function snapshotStatus(response){
 if(response.httpStatus!==200||response.body?.info?.ok!==true)return'unavailable';
 const d=response.body.data;if(d===null||d===undefined)return'unavailable';
 if(Array.isArray(d)?!d.length:!Object.keys(d).length)return'empty';
 if(d.TABLE&&!d.TABLE.columns?.length)return'empty';
 return'returned';
}
export async function resolveOwnedContext(client){
 const response=await client.request('items',{page:'1',pageSize:'20'});
 const rows=response.httpStatus===200&&response.body?.info?.ok===true?response.body?.data?.list:[];
 const item=Array.isArray(rows)?rows.find(x=>/^[1-9]\d{0,29}$/.test(String(x.id??''))):null;
 return {selection:'automatic-owned-item',status:item?'selected':'unavailable',itemId:item?String(item.id):null,source:{request:{kind:'items',query:{page:'1',pageSize:'20'}},response:scrubDmpRaw(response)},...(!item?{error:{code:'DMP_OWNED_CONTEXT_UNAVAILABLE',message:'当前账户未返回可用的接口上下文商品，已有目标商品数据保留。'}}:{})};
}
export async function collectSnapshot(client,plan,out,checkpoint=async()=>{}){
 out.account=client.account;let context;
 for(const initial of snapshotRequests(plan)){
  let spec=initial;
  if(spec.needsContext){
   if(!context){context=await resolveOwnedContext(client);out.executionContext=context;await checkpoint(out);}
   if(context.status!=='selected'){out.modules[spec.name]={status:'unavailable',reason:'context-unavailable',error:context.error,request:null,response:null};await checkpoint(out);continue;}
   spec={...spec,query:{...spec.query,itemId:context.itemId}};
  }
  const response=await client.request(spec.kind,spec.query,spec.body);
  let status=snapshotStatus(response);const d=response.body?.data;
  if(status==='returned'&&spec.name==='keywords'&&Array.isArray(d?.succItem)&&d.succItem.length===0)status='empty';
  if(status==='returned'&&spec.name==='scenes'&&Array.isArray(d)&&!d.some(row=>Object.values(row).some(v=>v&&typeof v==='object'&&v.succItemValue!==null&&v.succItemValue!==undefined)))status='empty';
  out.modules[spec.name]={status,capturedAt:new Date().toISOString(),request:{kind:spec.kind,query:spec.query,...(spec.body?{body:spec.body}:{})},response:scrubDmpRaw(response)};
  await checkpoint(out);
 }
 out.capabilityGaps=Object.entries(out.modules).filter(([,m])=>m.reason==='context-unavailable').map(([name,m])=>({module:name,...m.error}));
 out.status=Object.values(out.modules).some(m=>m.status==='unavailable')?'partial':'complete';
 return out;
}
export async function runDmpSnapshot(opts={},deps={}){
 const allowed=new Set(['_','json','out','itemId','startDate','endDate','days','timeoutMs','delayMs','minDelayMs','maxDelayMs','browserRole', 'cdpUrl','profileDir','chromePath','sessionMode']);
 if(Object.keys(opts).some(k=>!allowed.has(k))||(opts._&&opts._.length!==2))throw dmpError('DMP_INVALID_INPUT','快照参数不支持。');
 const plan=prepareDmpSnapshot(opts);
 if(plan.itemIds.length!==1)throw dmpError('DMP_INVALID_INPUT','快照每次查询一个商品。');
 if(!opts.out||path.extname(opts.out).toLowerCase()!=='.json')throw dmpError('DMP_INVALID_OUTPUT','提供新的JSON输出文件。');
 try{await lstat(opts.out);throw dmpError('OUTPUT_EXISTS','输出文件已存在。');}catch(e){if(e.code!=='ENOENT')throw e;}
 const file=await open(opts.out,'wx',0o600),result={snapshotVersion:2,subject:{mode:'target-only',itemId:plan.itemIds[0]},requiredModules:['metrics7','scenes','keywords','crowdRanges','crowdTable'],itemId:plan.itemIds[0],period:plan.period,status:'running',modules:{},startedAt:new Date().toISOString()};
 const save=async()=>{const b=Buffer.from(JSON.stringify(result,null,2));let offset=0;while(offset<b.length){const w=await file.write(b,offset,b.length-offset,offset);offset+=w.bytesWritten;}await file.truncate(b.length);await file.sync();};
 try{
  await save();await (deps.session??withAuthenticatedTaobaoSession)(opts,async({context})=>{const client=await(deps.clientFactory??createDmpClient)(context,plan);try{await collectSnapshot(client,plan,result,save);}finally{await client.dispose();}});
  result.finishedAt=new Date().toISOString();await save();console.log(JSON.stringify({ok:result.status==='complete',status:result.status,out:path.resolve(opts.out),modules:Object.fromEntries(Object.entries(result.modules).map(([k,v])=>[k,v.status]))}));
  if(result.status!=='complete')process.exitCode=2;return result;
 }catch(e){result.status='stopped';result.error={code:e.code??'DMP_COLLECTION_FAILED'};await save();console.log(JSON.stringify({ok:false,status:'stopped',out:path.resolve(opts.out),code:result.error.code}));process.exitCode=1;return result;}finally{await file.close();}
}
