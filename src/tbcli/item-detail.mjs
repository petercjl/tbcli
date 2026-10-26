import {feedbackOptions,collectFeedbackPages} from './item-feedback.mjs';
import { createHash } from 'node:crypto';
import { resolveApiDelayRange, waitBeforeTaobaoApiRequest } from './api-policy.mjs';
import { watchSearchVerification } from './search-products.mjs';
import { createVerificationError } from './taobao-guard.mjs';

export const DETAIL_APIS = Object.freeze({
  description: '/h5/mtop.taobao.detail.getdesc/7.0/',
  reviews: '/h5/mtop.taobao.rate.detaillist.get/6.0/',
  questions: '/h5/mtop.taobao.wdj.list.merge.search/1.0/',
});
export const detailError=(code,message)=>Object.assign(new Error(message),{code});
const sha=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const pick=(o,keys)=>Object.fromEntries(keys.filter(k=>o?.[k]!=null).map(k=>[k,o[k]]));
export function prepareDetail(opts){
  const itemId=String(opts.itemId??'');
  if(!/^\d{1,30}$/.test(itemId))throw detailError('INVALID_ITEM_ID','请提供数字字符串 --item-id。');
  return {itemId,delayRange:resolveApiDelayRange(opts),feedback:feedbackOptions(opts)};
}
export function imageUrl(value){
  try{const u=new URL(value,'https://item.taobao.com');if(!['http:','https:'].includes(u.protocol)||!/(^|\.)(alicdn\.com|taobaocdn\.com|tbcdn\.cn)$/.test(u.hostname))return null;u.protocol='https:';u.search='';u.hash='';return u.href;}catch{return null;}
}
export function parseDetailResponse(text){
  const t=text.trim();try{return JSON.parse(t);}catch{}
  const m=t.match(/^[\w.$]+\s*\(([\s\S]*)\)\s*;?$/);
  if(m){try{return JSON.parse(m[1]);}catch{}}
  throw detailError('DETAIL_RESPONSE_INVALID','商品响应不是可解析的 JSON/JSONP。');
}
function price(value){return value?pick(value,['priceText','priceMoney','priceTitle']):null;}
export function normalizeDetail(res,itemId){
  if(String(res?.item?.itemId)!==itemId)throw detailError('ITEM_ID_MISMATCH','商品详情身份不符，已停止。');
  const properties=(res.skuBase?.props??[]).map(p=>({pid:String(p.pid),name:p.name,values:(p.values??[]).map(v=>({vid:String(v.vid),name:v.name,imageUrl:imageUrl(v.image)}))}));
  const skus=(res.skuBase?.skus??[]).map(s=>{
    const options=String(s.propPath??'').split(';').filter(Boolean).map(pair=>{const [pid,vid]=pair.split(':');const p=properties.find(p=>p.pid===pid),v=p?.values.find(v=>v.vid===vid);return {pid,vid,property:p?.name??null,name:v?.name??null,imageUrl:v?.imageUrl??null};});
    const info=res.skuCore?.sku2info?.[s.skuId];
    return {skuId:String(s.skuId),propPath:s.propPath,name:options.map(v=>v.name??`${v.pid}:${v.vid}`).join(' / '),options,imageUrls:options.map(v=>v.imageUrl).filter(Boolean),price:price(info?.subPrice??info?.price),priceBeforeDiscount:info?.subPrice?price(info.price):null,currency:'CNY',priceMoneyUnit:'fen',quantity:info?.quantity??null,quantityText:info?.quantityText??null,mappingComplete:options.length>0&&options.every(o=>o.name!=null)};
  });
  return {itemId,title:res.item.title??null,shop:pick(res.seller,['shopName','shopId']),mainImages:(res.item.images??[]).map(imageUrl).filter(Boolean),properties,skus,priceScope:'页面当前会话展示价；保留优惠标签与分单位金额，不等于所有账号的最终支付价。'};
}
export function extractDetailState(){
  const d=window.__ICE_APP_CONTEXT__?.loaderData?.home?.data;
  const r=d?.res;if(!r?.item)return null;
  // Project only product fields; exclude delivery addresses, buyer/trade context and tokens.
  const pick=(o,ks)=>Object.fromEntries(ks.filter(k=>o?.[k]!=null).map(k=>[k,o[k]]));
  return {item:pick(r.item,['itemId','title','images']),seller:pick(r.seller,['shopName','shopId']),skuBase:{props:(r.skuBase?.props??[]).map(p=>({...pick(p,['pid','name']),values:(p.values??[]).map(v=>pick(v,['vid','name','image']))})),skus:(r.skuBase?.skus??[]).map(s=>pick(s,['skuId','propPath']))},skuCore:{sku2info:Object.fromEntries(Object.entries(r.skuCore?.sku2info??{}).map(([id,s])=>[id,{...pick(s,['quantity','quantityText']),price:pick(s.price,['priceText','priceMoney','priceTitle']),subPrice:s.subPrice?pick(s.subPrice,['priceText','priceMoney','priceTitle']):null}]))}};
}
export function normalizeDescription(data,itemId){
  const components=data?.components?.componentData??{},layout=data?.components?.layout;
  let nodes=Array.isArray(layout)?layout.filter(n=>['desc_richtext','desc_richtext_pc','desc_single_image'].includes(n.key)&&!/^detail_pic_tmallPriceDesc_/.test(n.ID??'')):[];
  if(!nodes.length&&components.desc_richtext_pc)nodes=[{ID:'desc_richtext_pc',key:'desc_richtext_pc'}];
  if(!nodes.length)throw detailError('DESCRIPTION_SCHEMA_CHANGED','详情图响应缺少已知图文结构。');
  const images=[];
  for(const n of nodes){const m=components[n.ID]?.model;
    if(itemId&&m?.itemId!=null&&String(m.itemId)!==itemId)throw detailError('ITEM_ID_MISMATCH','详情图片商品身份不符。');
    if(n.key==='desc_single_image'){const u=imageUrl(m?.picUrl);if(!u)throw detailError('DESCRIPTION_SCHEMA_CHANGED','详情图片组件缺少有效图片。');images.push(u);}
    else {if(typeof m?.text!=='string')throw detailError('DESCRIPTION_SCHEMA_CHANGED','详情富文本组件缺少正文。');for(const tag of m.text.matchAll(/<img\b[^>]*>/gi)){const src=tag[0].match(/\b(?:src|data-src)\s*=\s*["']([^"']+)["']/i)?.[1];const u=imageUrl(src?.replace(/&amp;/g,'&'));if(u)images.push(u);}}
  }
  return {images,sourceComponent:[...new Set(nodes.map(n=>n.key))].join(','),scope:'按详情组件布局顺序采集富文本及独立图片，排除平台价格说明组件。'};
}
export function normalizeReviews(data,itemId){
  if(!Array.isArray(data?.rateList))throw detailError('REVIEW_SCHEMA_CHANGED','评价响应缺少评价列表。');
  const records=data.rateList.map(r=>{
    if(r.auctionNumId!=null&&String(r.auctionNumId)!==itemId)throw detailError('ITEM_ID_MISMATCH','评价商品身份不符。');
    return {...pick(r,['id','feedback','feedbackDate','createTime','skuId','skuValueStr','skuMap','rateType']),images:(r.rateResourceList??[]).filter(x=>x.type==='image'||x.type==='1').map(x=>imageUrl(x.url)).filter(Boolean)};
  });
  return {records,...pick(data,['total','totalPage','hasNext','feedAllCount','fuzzyRateCount','timePeriodDesc','foldCount']),foldInfo:pick(data.foldInfo,['defaultRateCount','defaultRateLastTime','defaultRatePercent','foldRateCount']),scope:'默认排序首个响应批次；不含未返回的折叠评价、后续页及另行打开的追评。'};
}
export function normalizeQuestions(data,itemId){
  if(String(data?.item?.itemId)!==itemId)throw detailError('ITEM_ID_MISMATCH','问大家商品身份不符。');
  const explicitEmpty=data.questionList==null&&String(data.total)==='0'&&String(data.questionTotal)==='0'&&String(data.hasNext)==='false'&&String(data.foldingCount)==='0'&&String(data.foldingHasNext)==='false';
  if(!Array.isArray(data.questionList)&&!explicitEmpty)throw detailError('QUESTION_SCHEMA_CHANGED','问大家响应缺少问题列表。');
  return {records:(data.questionList??[]).map(q=>({...pick(q,['questionId','questionTitle','answerCount','gmtCreate']),answers:(q.topAnswerList??[]).map(a=>pick(a,['answerId','answerTitle','gmtCreate','gmtCreateStr','sku','mergedAnswerHasMore']))})),...pick(data,['total','questionTotal','hasNext','foldingCount','foldingHasNext']),scope:'首个问题响应批次及其中返回的答案；不自动展开每个问题的更多回答。'};
}
export function detailRequestIdentity(request){
  try{const u=new URL(request.url());const raw=u.searchParams.get('data')??new URLSearchParams(request.postData?.()??'').get('data');const d=JSON.parse(raw);return {itemId:String(d.itemId??d.auctionNumId??d.id??''),page:d.pageNo??d.page??null,pageSize:d.pageSize??null};}catch{return {itemId:'',page:null,pageSize:null};}
}
export function observeDetailResponses(page,itemId,onRecord){
  const pending=new Set();let blocked=null;
  const listener=response=>{
    let url;try{url=new URL(response.url());}catch{return;}
    if(!/(^|\.)(taobao|tmall)\.com$/.test(url.hostname))return;
    const module=Object.keys(DETAIL_APIS).find(k=>DETAIL_APIS[k]===url.pathname);if(!module)return;
    const request=detailRequestIdentity(response.request());if(request.itemId!==itemId)return;
    const task=(async()=>{
      let timer;const text=await Promise.race([response.text(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(detailError('DETAIL_RESPONSE_TIMEOUT','商品响应读取超时。')),5000);})]).finally(()=>clearTimeout(timer));
      const parsed=parseDetailResponse(text);
      if((parsed.ret??[]).some(x=>/FAIL_SYS_USER_VALIDATE|RGV587|SESSION_EXPIRED|ILLEGAL_ACCESS|TOKEN_EXPIRED|TOKEN_EMPTY/.test(x)))throw createVerificationError('商品接口要求登录或验证');
      if(!(parsed.ret??[]).some(x=>/^SUCCESS/.test(x)))throw detailError('DETAIL_API_FAILED','商品接口未成功，停止继续采集。');
      const value=({description:normalizeDescription,reviews:normalizeReviews,questions:normalizeQuestions})[module](parsed.data,itemId);
      await onRecord({module,value,source:{kind:'page-api-response',api:url.pathname,itemId,...pick(request,['page','pageSize']),capturedAt:new Date().toISOString(),normalizedSha256:sha(value)}},{api:url.pathname.split('/')[2],v:url.pathname.split('/')[3],data:pick(JSON.parse(new URL(response.request().url()).searchParams.get('data')??new URLSearchParams(response.request().postData?.()??'').get('data')),['itemId','auctionNumId','pageNo','page','pageSize','userId','type','tagId','extraInfo','ecode','biz','showTrueCount','orderType','searchImpr','expression','skuVids','rateSrc','rateType','foldFlag'])});
    })().catch(e=>{blocked??=e;});pending.add(task);task.finally(()=>pending.delete(task));
  };page.on('response',listener);
  return {async flush(){await Promise.all([...pending]);if(blocked)throw blocked;},dispose(){page.off('response',listener);}};
}
export async function guardedDetailAction(page,guard,range,action,wait=waitBeforeTaobaoApiRequest){await guard.check();await wait(page,range);await guard.check();const result=await action();await guard.check();return result;}
async function poll(page,guard,read,timeoutMs=10000){const end=Date.now()+timeoutMs;do{await guard.check();const v=await read();if(v)return v;await page.waitForTimeout(250);}while(Date.now()<end);return null;}
export function detailCoverage(report){
  const d=report.detail;const review=report.reviews;const questions=report.questions;
  const yes=x=>x==='true'||x===true;
  return {
    mainImages:{status:d?.mainImages?.length?'captured':'unavailable',count:d?.mainImages?.length??0},
    skuImages:{status:d?.skus?.length&&d.skus.every(s=>s.imageUrls.length)?'captured':'partial',count:d?.skus?.filter(s=>s.imageUrls.length).length??0},
    skuNamesPrices:{status:d?.skus?.length&&d.skus.every(s=>s.mappingComplete&&s.price?.priceMoney!=null)?'captured':'partial',count:d?.skus?.length??0},
    descriptionImages:{status:report.description?'captured':'unavailable',count:report.description?.images?.length??0},
    reviews:{...(review?.pagination?{pagination:review.pagination}:{}),status:review?.pagination?(review.pagination.complete&&Number(review.pagination.foldedAvailable)===0?'captured':'partial'):!review?'unavailable':yes(review.hasNext)||Number(review.foldCount)>0?'partial':'captured',count:review?.records?.length??0,stopReason:review?.pagination?.stopReason??(!review?'no-response':yes(review.hasNext)?'first-batch-limit':Number(review.foldCount)>0?'folded-reviews-not-returned':'visible-list-end')},
    questions:{...(questions?.pagination?{pagination:questions.pagination}:{}),status:questions?.pagination?(questions.pagination.complete?'captured':'partial'):!questions?'unavailable':yes(questions.hasNext)||yes(questions.foldingHasNext)||Number(questions.foldingCount)>0||questions.records.some(q=>Number(q.answerCount)>q.answers.length||q.answers.some(a=>yes(a.mergedAnswerHasMore)))?'partial':'captured',count:questions?.records?.length??0,answerCount:questions?.records?.reduce((n,q)=>n+q.answers.length,0)??0},
  };
}
export async function collectItemDetail(context,plan,report,onCheckpoint=async()=>{}){
  const page=context.pages().find(p=>{try{return new URL(p.url()).searchParams.get('id')===plan.itemId;}catch{return false;}})??context.pages().find(p=>/^https:\/\/(item.taobao.com|detail.tmall.com)\//.test(p.url()))??context.pages().find(p=>p.url()==='about:blank')??context.pages()[0]??await context.newPage();
  const verification=watchSearchVerification(page);
  const templates={};let paging=false;
  const observer=observeDetailResponses(page,plan.itemId,async (r,template)=>{templates[r.module]=template;if(!paging){report[r.module]=r.value;report.sources.push(r.source);}});
  const guard={async check(){await verification.check();await observer.flush();}};
  try{
    const url=`https://item.taobao.com/item.htm?id=${plan.itemId}`;
    await guardedDetailAction(page,guard,plan.delayRange,()=>page.goto(url,{waitUntil:'domcontentloaded',timeout:30000}));
    const state=await poll(page,guard,()=>page.evaluate(extractDetailState),15000);
    if(!state)throw detailError('DETAIL_STATE_UNAVAILABLE','首屏商品数据不可用，保留已捕获内容。');
    report.detail=normalizeDetail(state,plan.itemId);report.sources.push({kind:'page-hydration',location:'__ICE_APP_CONTEXT__.loaderData.home.data.res',itemId:plan.itemId,capturedAt:new Date().toISOString(),normalizedSha256:sha(report.detail)});await onCheckpoint();
    await poll(page,guard,()=>report.description&&report.questions,8000);await onCheckpoint();
    const reviewButton=page.getByText('查看全部评价',{exact:true});
    if(await reviewButton.count()){
      await guardedDetailAction(page,guard,plan.delayRange,()=>reviewButton.first().click({timeout:8000}));
      await poll(page,guard,()=>report.reviews,10000);await onCheckpoint();
      const close=page.locator('[class^="closeWrap--"]');if(await close.count())await guardedDetailAction(page,guard,plan.delayRange,()=>close.first().click({timeout:5000}));
    }
    if(!report.questions){const questionButton=page.getByText('查看全部问答',{exact:true});if(await questionButton.count()){await guardedDetailAction(page,guard,plan.delayRange,()=>questionButton.first().click({timeout:8000}));await poll(page,guard,()=>report.questions,8000);}}
    await guard.check();paging=true;await collectFeedbackPages({page,guard,plan,report,templates,checkpoint:onCheckpoint});
    await guard.check();report.coverage=detailCoverage(report);report.status=Object.values(report.coverage).every(c=>c.status==='captured')?'completed':'partial';await onCheckpoint();return report;
  }finally{observer.dispose();verification.dispose();}
}
