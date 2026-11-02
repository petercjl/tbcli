import {dmpError, prepareDmpItems, scrubDmpRaw} from './dmp.mjs';

import {AUDIENCE_TYPES,AUDIENCE_DIMENSIONS,AUDIENCE_CONTRACT} from './dmp-audience-contract.mjs';
export {AUDIENCE_TYPES,AUDIENCE_DIMENSIONS,AUDIENCE_CONTRACT};
export function prepareDmpAudience(opts={}) {
  const itemId=String(opts.itemId??'').trim(), days=Number(opts.days??30),type=opts.audienceType??'purchase';
  if(!/^[1-9]\d{0,29}$/.test(itemId)||!AUDIENCE_CONTRACT.days.includes(days)||!Object.hasOwn(AUDIENCE_TYPES,type))throw dmpError('DMP_INVALID_INPUT','提供商品ID；--days 为7/15/30/90，--audience-type 为purchase/browse/favorite/cart/search。');
  return {...prepareDmpItems(opts),itemId,days,type,behavior:AUDIENCE_TYPES[type]};
}
export function audienceBody(plan,dimension){
  const select=(optionGroupId,values,names)=>({tagId:'283736',optionGroupId,tagName:'同行宝贝行为人群',values,names});
  return {appCode:'dmpInsight',needUnknown:true,tagId:dimension.tagId,selectTagOptionSetDTO:{operator:1,selectTagOptionSetDTO:[{operator:1,selects:[select(303279,plan.itemId,plan.itemId),select(303280,plan.behavior.code,plan.behavior.label),select(303281,String(plan.days),'最近'+plan.days+'天')]}]}};
}
export function normalizeAudience(response,dimension,request){
  const result={...dimension,status:'unavailable',rows:[],countSum:null,source:{fetchedAt:new Date().toISOString(),request:{method:'POST',path:AUDIENCE_CONTRACT.path,body:request},httpStatus:response.httpStatus,raw:scrubDmpRaw(response.body)}};
  if(response.error||response.httpStatus!==200||response.body?.info?.ok!==true)return {...result,error:response.error??(response.httpStatus!==200?'HTTP_'+response.httpStatus:'DMP_PROVIDER_FAILURE')};
  const chart=response.body?.data?.result?.chartDataFull??response.body?.data?.chartDataFull;
  if(!Array.isArray(chart))return {...result,error:'DMP_SCHEMA_CHANGED'};
  const seen=new Set();
  for(const row of chart){
    const raw=row?.optionNum, key=String(row?.optionValue??row?.optionName??'');
    if(!row||!key||seen.has(key)||!['number','string'].includes(typeof raw)||String(raw).trim()===''||!Number.isFinite(Number(raw))||Number(raw)<0||!String(row.optionName??'').trim())return {...result,error:'DMP_SCHEMA_CHANGED'};
    seen.add(key);result.rows.push({label:row.optionName==='unknown'?'未知':row.optionName,optionValue:key,count:Number(raw),platformRate:row.rate??null});
  }
  result.countSum=result.rows.reduce((n,r)=>n+r.count,0);
  result.rows=result.rows.map(r=>({...r,normalizedShare:result.countSum>0?r.count/result.countSum:null})).sort((a,b)=>b.count-a.count);
  return {...result,status:chart.length?'returned':'empty',countMeaning:dimension.multiLabel?'label-count-sum-not-unique-people':'returned-dimension-count-sum',rateMeaning:dimension.multiLabel?'platform-rate-may-sum-above-one':'platform-rate-raw'};
}
