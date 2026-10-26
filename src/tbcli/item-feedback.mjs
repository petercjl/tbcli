import {createHash} from 'node:crypto';
import {detailError,normalizeReviews,normalizeQuestions,guardedDetailAction} from './item-detail.mjs';
import {createVerificationError} from './taobao-guard.mjs';
const yes=x=>x===true||x==='true', no=x=>x===false||x==='false';
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
export function feedbackOptions(opts){
 const integer=(value,name)=>{if(value==null)return null;if(!/^\d+$/.test(String(value))||!Number.isSafeInteger(Number(value))||Number(value)<1||Number(value)>10000)throw detailError('INVALID_FEEDBACK_OPTIONS',name+' 必须是1–10000的整数。');return Number(value);};
 const reviewPages=integer(opts.reviewPages,'--review-pages'),reviewLimit=integer(opts.reviewLimit,'--review-limit');
 if(reviewPages!==null&&reviewLimit!==null)throw detailError('INVALID_FEEDBACK_OPTIONS','--review-pages 与 --review-limit 二选一。');
 const questions=opts.questions??'first';if(!['first','all'].includes(questions))throw detailError('INVALID_FEEDBACK_OPTIONS','--questions 支持 first 或 all。');
 return {reviewPages,reviewLimit,questions};
}
export function checkFeedbackResponse(value){
 if((value?.ret??[]).some(x=>/FAIL_SYS_USER_VALIDATE|RGV587|SESSION_EXPIRED|ILLEGAL_ACCESS|TOKEN_EXPIRED|TOKEN_EMPTY/.test(x)))throw createVerificationError('反馈接口要求登录或验证');
 if(!(value?.ret??[]).some(x=>/^SUCCESS/.test(x)))throw detailError('DETAIL_API_FAILED','反馈接口未成功，停止采集。');return value.data;
}
export async function waitForFeedbackReply(operation,guard,timeoutMs=25000){
 let done=false,timer;
 const monitor=new Promise((resolve,reject)=>{const check=async()=>{if(done)return;try{await guard.check();if(!done)timer=setTimeout(check,100);}catch(e){reject(e);}};check();});
 let timerDeadline;const timeout=new Promise((resolve,reject)=>{timerDeadline=setTimeout(()=>reject(detailError('DETAIL_RESPONSE_TIMEOUT','反馈请求超时，已停止并保留检查点。')),timeoutMs);});
 try{return await Promise.race([operation,monitor,timeout]);}finally{done=true;clearTimeout(timer);clearTimeout(timerDeadline);}
}
export async function requestFeedback(page,guard,range,template,data){
 if(!template)throw detailError('FEEDBACK_REQUEST_UNAVAILABLE','页面未提供对应反馈请求上下文。');
 const value=await guardedDetailAction(page,guard,range,()=>waitForFeedbackReply(page.evaluate(async ({api,v,data})=>{
  if(typeof window.lib?.mtop?.request!=='function')return {ret:['CLIENT_UNAVAILABLE']};
  return new Promise(resolve=>{let finished=false;const done=x=>{if(!finished){finished=true;resolve(x);}};try{const task=window.lib.mtop.request({api,v,data,type:'get',dataType:'jsonp',ecode:1,timeout:20000,success:done,failure:done});task?.then?.(done,done);}catch{done({ret:['CLIENT_REQUEST_FAILED']});}});
 },{api:template.api,v:template.v,data}),guard));return checkFeedbackResponse(value);
}
export function normalizeAnswers(data,itemId,questionId){
 if(String(data?.id)!==questionId||String(data?.refId)!==itemId)throw detailError('ITEM_ID_MISMATCH','问题回答身份不符。');
 if(!Array.isArray(data.list?.list)||String(data.list.success)!=='true')throw detailError('ANSWER_SCHEMA_CHANGED','回答列表结构未知。');
 return {records:data.list.list.map(a=>({answerId:String(a.id),answerTitle:a.title??'',gmtCreate:a.gmtCreate,gmtCreateStr:a.gmtCreateStr,sku:a.sku,mergedAnswerHasMore:a.mergedAnswerHasMore})),isEnd:data.list.isEnd,nextPage:data.list.nextPage,totalCount:data.list.totalCount,foldingCount:data.foldingCount};
}
const source=(report,module,template,page,value,extra={})=>report.sources.push({kind:'guarded-page-api',module,api:'/h5/'+template.api.toLowerCase()+'/'+template.v+'/',itemId:report.itemId,page,capturedAt:new Date().toISOString(),normalizedSha256:hash(value),...extra});
// Raw business records stay per page. The aggregate is unique by platform identity,
// without excluding empty/default feedback: business filtering belongs to the caller.
export function mergeRecords(existing,incoming,key){const seen=new Set(existing.map(x=>String(x[key]??hash(x))));let added=0;for(const row of incoming){const id=String(row[key]??hash(row));if(!seen.has(id)){seen.add(id);existing.push(row);added++;}}return added;}
export async function collectFeedbackPages({page,guard,plan,report,templates,checkpoint,request=requestFeedback}){
 const options=plan.feedback;
 if(options.reviewPages!==null||options.reviewLimit!==null){
  const first=report.reviews,template=templates.reviews;
  if(!first||!template)throw detailError('FEEDBACK_REQUEST_UNAVAILABLE','未取得首批评价及其请求上下文。');
  const target={mode:options.reviewPages!==null?'pages':'count',pages:options.reviewPages,limit:options.reviewLimit};
  const pages=[{page:1,value:structuredClone(first)}],records=[];mergeRecords(records,first.records,'id');
  report.reviews={...first,records,pages,pagination:{...target,pagesFetched:1,stopReason:'running',complete:false},scope:'沿页面当前排序采集；数量指唯一原始记录，默认评价保留，由调用者判断有效性。'};
  const r=report.reviews;let last=first,pageNo=1;
  for(;;){
   if(options.reviewLimit!==null&&records.length>=options.reviewLimit){r.pagination.stopReason='target_reached';break;}
   if(no(last.hasNext)){r.pagination.stopReason='exhausted';break;}
   if(options.reviewPages!==null&&pageNo>=options.reviewPages){r.pagination.stopReason='page_limit_reached';break;}
   if(!yes(last.hasNext)){r.pagination.stopReason='pagination_unknown';break;}
   const data={...template.data,pageNo:pageNo+1};last=normalizeReviews(await request(page,guard,plan.delayRange,template,data),plan.itemId);pageNo++;pages.push({page:pageNo,value:last});source(report,'reviews',template,pageNo,last);
   const added=mergeRecords(records,last.records,'id');r.pagination.pagesFetched=pageNo;r.hasNext=last.hasNext;await checkpoint();
   if(added===0&&!no(last.hasNext)){r.pagination.stopReason='pagination_stalled';break;}
  }
  r.pagination.complete=r.pagination.stopReason==='exhausted';r.pagination.foldedAvailable=Number(last.foldCount??first.foldCount??0);
  r.pagination.returnedUniqueCount=records.length;r.pagination.selectedCount=options.reviewLimit===null?records.length:Math.min(records.length,options.reviewLimit);
  // Preserve the last page in pages even when its size exceeds the requested limit.
  if(options.reviewLimit!==null)r.records=records.slice(0,options.reviewLimit);
  await checkpoint();
 }
 if(options.questions==='all'){
  const first=report.questions,template=templates.questions;
  if(!first||!template)throw detailError('FEEDBACK_REQUEST_UNAVAILABLE','未取得首批问大家及其请求上下文。');
  const pages=[{page:1,value:structuredClone(first)}],records=[];mergeRecords(records,first.records,'questionId');
  report.questions={...first,records,pages,pagination:{mode:'all',pagesFetched:1,stopReason:'running',complete:false},scope:'获取问题列表后逐问题分页获取可用回答；未返回或折叠部分单独披露。'};
  const q=report.questions;let last=first,pageNo=1;
  while(yes(last.hasNext)){
   last=normalizeQuestions(await request(page,guard,plan.delayRange,template,{...template.data,page:pageNo+1}),plan.itemId);pageNo++;pages.push({page:pageNo,value:last});source(report,'questions',template,pageNo,last);const added=mergeRecords(records,last.records,'questionId');q.pagination.pagesFetched=pageNo;q.hasNext=last.hasNext;await checkpoint();if(!added&&!no(last.hasNext)){q.pagination.stopReason='pagination_stalled';break;}
  }
  if(q.pagination.stopReason==='running')q.pagination.stopReason=no(last.hasNext)?'exhausted':'pagination_unknown';
  const answerTemplate={api:'mtop.taobao.social.ugc.post.detail',v:'2.0'};
  for(const question of records){
   question.answerPages=[];question.answerPagination={stopReason:'running',complete:false};
   const answers=[];let pageNum=1;
   for(;;){
    const value=normalizeAnswers(await request(page,guard,plan.delayRange,answerTemplate,{id:question.questionId,userId:template.data.userId,params:JSON.stringify({pageNum,pageSize:10,firstAnswerId:question.answers[0]?.answerId??'',from:'answer',searchFoldingList:false,pageVersion:'v2',channel:0}),ecode:0,biz:'pc'}),plan.itemId,question.questionId);
    question.answerPages.push({page:pageNum,value});source(report,'answers',answerTemplate,pageNum,value,{questionId:question.questionId});const added=mergeRecords(answers,value.records,'answerId');question.answers=answers;question.answerPagination.pagesFetched=pageNum;await checkpoint();
    if(value.isEnd==='y'){question.answerPagination.stopReason='exhausted';question.answerPagination.complete=true;break;}
    if(value.isEnd!=='n'||!added){question.answerPagination.stopReason=added?'pagination_unknown':'pagination_stalled';break;}pageNum++;
   }
   const end=question.answerPages.at(-1)?.value;
   if(Number(end?.foldingCount)>0||question.answers.some(a=>yes(a.mergedAnswerHasMore))||Number(end?.totalCount)>question.answers.length){question.answerPagination.complete=false;question.answerPagination.stopReason='hidden_answers_not_returned';}
  }
  q.pagination.complete=q.pagination.stopReason==='exhausted'&&records.every(x=>x.answerPagination.complete)&&no(last.foldingHasNext)&&String(last.foldingCount)==='0';
  if(q.pagination.stopReason==='exhausted'&&!q.pagination.complete)q.pagination.stopReason='hidden_or_incomplete_answers';
  await checkpoint();
 }
}
