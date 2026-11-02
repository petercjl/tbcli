import {withAuthenticatedTaobaoSession} from '../browser-session.mjs';
import {createDmpClient,dmpError} from '../dmp.mjs';
import {AUDIENCE_DIMENSIONS,prepareDmpAudience,audienceBody,normalizeAudience} from '../dmp-audience.mjs';
import {outputFile,save,emitError} from './dmp.mjs';

export async function runDmpAudience(opts={}, {session=withAuthenticatedTaobaoSession,clientFactory=createDmpClient}={}){
  const allowed=new Set(['_','json','out','itemId','days','audienceType','browserRole','cdpUrl','profileDir','chromePath','sessionMode','timeoutMs','delayMs','minDelayMs','maxDelayMs']);
  if((opts._&&opts._.join(' ')!=='dmp audience')||Object.keys(opts).some(k=>!allowed.has(k))||opts.browserRole&&opts.browserRole!=='merchant')throw dmpError('DMP_INVALID_INPUT','竞品画像使用商家会话及明确支持的参数。');
  const plan=prepareDmpAudience(opts),file=await outputFile(opts.out,true);
  const report={schemaVersion:1,audienceVersion:1,command:'dmp audience',itemId:plan.itemId,audienceType:plan.type,audienceLabel:plan.behavior.label,period:{type:'rolling',days:plan.days,label:'最近'+plan.days+'天',actualDatesVerified:false},status:'running',startedAt:new Date().toISOString(),dimensions:[],warnings:['滚动周期实际起止日期未回显；人数不等于成交笔数。','策略标签可能重叠，人数合计不作为去重覆盖规模。']};
  try{
    await save(file,report);
    await session({...opts,browserRole:'merchant'},async({context})=>{
      const client=await clientFactory(context,plan);
      try{for(const dim of AUDIENCE_DIMENSIONS){const body=audienceBody(plan,dim);const result=normalizeAudience(await client.request('audience',{},body),dim,body);report.dimensions.push(result);await save(file,report);if(result.status==='unavailable')throw dmpError(result.error,'画像请求不可用，保留已有数据并停止。');}}
      finally{await client.dispose();}
    });
    report.status='complete';report.finishedAt=new Date().toISOString();await save(file,report);
    console.log(JSON.stringify({ok:true,status:report.status,itemId:report.itemId,audienceType:report.audienceType,period:report.period,out:opts.out,dimensions:report.dimensions.map(d=>({id:d.id,status:d.status,countSum:d.countSum}))}));return report;
  }catch(error){report.status='stopped';report.error={code:error.code??'DMP_COLLECTION_FAILED'};report.finishedAt=new Date().toISOString();await save(file,report);emitError(error,opts,opts.out);return report;}
  finally{await file.close();}
}
