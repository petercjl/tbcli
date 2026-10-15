import {waitBeforeTaobaoApiRequest,resolveApiDelayRange,randomDelayMs} from './api-policy.mjs';
import {assertPageNotVerifying,isVerificationSignal} from './taobao-guard.mjs';
import {financeError,clean,nextDay} from './finance-core.mjs';
import {normalizeAlipayBalance} from './alipay-balance.mjs';
const bool=v=>v===true||v==='true'?true:v===false||v==='false'?false:undefined;
const HOME='https://myseller.taobao.com/home.htm/whale-accountant/index';
const ALIPAY='https://b.alipay.com/page/mbillexprod/account/detail';
export async function alipayGuard(page){const s=await page.evaluate(()=>({url:location.href,title:document.title,text:document.body?.innerText?.slice(0,1200)??''}));if(/auth\.alipay\.com|\/login|captcha|securityCheck/i.test(s.url)||/扫码登录|密码登录|安全验证|滑动验证|验证码/.test(s.title+' '+s.text))throw financeError('ALIPAY_AUTH_REQUIRED','支付宝需要登录或验证，请在原浏览器完成后恢复。');}
export async function guardedRequest(page,opts,call,{alipay=false,wait=waitBeforeTaobaoApiRequest,sleep=ms=>new Promise(r=>setTimeout(r,ms))}={}){
 const range=resolveApiDelayRange(opts);
 if(alipay){await alipayGuard(page);await sleep(randomDelayMs(range.minDelayMs,range.maxDelayMs));await alipayGuard(page);}else await wait(page,range);
 const result=await call();if(alipay)await alipayGuard(page);else await assertPageNotVerifying(page);
 const values=v=>typeof v==='string'?[v]:Array.isArray(v)?v.flatMap(values):v&&typeof v==='object'?Object.values(v).flatMap(values):[];
 if(isVerificationSignal(values(result).join('\n')))throw financeError(alipay?'ALIPAY_AUTH_REQUIRED':'TAOBAO_VERIFICATION_REQUIRED','平台要求登录或验证，采集已停止。');return clean(result);
}
export async function createFinanceClient(context,opts){
 let page=context.pages().find(p=>p.url().startsWith('https://myseller.taobao.com/'));
 if(!page){page=await context.newPage();await page.goto(HOME,{waitUntil:'domcontentloaded'});}await assertPageNotVerifying(page);
 let ap;
 async function alipay(){if(!ap){ap=context.pages().find(p=>p.url().startsWith(ALIPAY));if(!ap){ap=await context.newPage();await ap.goto(ALIPAY,{waitUntil:'domcontentloaded'});}await alipayGuard(ap);}return ap;}
 const fund=async(endpoint,body,method='POST')=>{
  if(!/^\/(monthBill|dayBill|billDetail)\/(renderBillSummaryPage|renderBillDetailPage|queryBillSummary|queryBillStatistics|queryBillDetail|queryExpenseBillByDay|queryExpenseBillSummary)$/.test(endpoint))throw financeError('ENDPOINT_DENIED','账单接口不在只读白名单。');
  const r=await guardedRequest(page,opts,()=>page.evaluate(async({endpoint,body,method})=>{let url='https://fundtax.taobao.com/api/union'+endpoint+'?_input_charset=utf-8';if(method==='GET')url+='&'+new URLSearchParams(body);const response=await fetch(url,{method,credentials:'include',headers:method==='POST'?{'content-type':'application/json'}:undefined,body:method==='POST'?JSON.stringify(body):undefined,signal:AbortSignal.timeout(20000)});if(!response.ok)throw new Error('FINANCE_HTTP_'+response.status);return response.json();},{endpoint,body,method}));
  if(r.success===false||r.success==='false'||r.content==null)throw financeError('FINANCE_RESPONSE_FAILED','淘宝账单请求未成功或结构发生变化。');return r.content;
 };
 async function mtop(api,data,{deposit=false}={}){
  if(!['mtop.taobao.finance.fund.bill.query','mtop.taobao.finance.fund.account.overview.get','mtop.taobao.finance.fund.merchant.checkRole','mtop.alibaba.jibu.accounting.jour.get'].includes(api))throw financeError('ENDPOINT_DENIED','接口不在只读白名单。');
  let target=page;
  if(deposit){let dp=context.pages().find(p=>p.url().startsWith('https://jibu.taobao.com/'));if(!dp){dp=await context.newPage();await dp.goto('https://jibu.taobao.com/?onlybill=true&nolayout=true#/home',{waitUntil:'domcontentloaded'});}target=dp;}
  await target.waitForFunction(()=>!!window.lib?.mtop?.request,{timeout:15000});
  const r=await guardedRequest(target,opts,()=>target.evaluate(async({api,data,deposit})=>window.lib.mtop.request({api,v:'1.0',data,...(deposit?{ecode:1}:{})}),{api,data,deposit}));
  if(!r.ret?.some(v=>v.startsWith('SUCCESS')))throw financeError('FINANCE_RESPONSE_FAILED','平台账单请求失败。');return r.data;
 }
 async function pay(endpoint,form={}){
  if(!['cardList.json','fundAccountDetailInit.json','fundAccountDetail.json','salesOrderInit.json','tradeListQuery.json'].includes(endpoint))throw financeError('ENDPOINT_DENIED','支付宝接口不在只读白名单。');
  const p=await alipay();
  return guardedRequest(p,opts,()=>p.evaluate(async({endpoint,form})=>{
   const entries=performance.getEntriesByType('resource').map(e=>e.name);const known=entries.findLast(u=>u.includes('mbillexprod.alipay.com/enterprise/')&&new URL(u).searchParams.has('ctoken'));
   if(!known)throw new Error('ALIPAY_SESSION_NOT_READY');const url=new URL(known);url.pathname='/enterprise/'+endpoint;
   const r=await fetch(url.href,{method:'POST',credentials:'include',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams(form),signal:AbortSignal.timeout(20000)});if(!r.ok)throw new Error('ALIPAY_HTTP_'+r.status);return r.json();
  },{endpoint,form}),{alipay:true});
 }
 async function currentAlipayBalance(accountId){
  let p=context.pages().find(p=>p.url().startsWith('https://b.alipay.com/page/bizfund/assetManage'));
  if(!p){p=await context.newPage();await p.goto('https://b.alipay.com/page/bizfund/assetManage',{waitUntil:'domcontentloaded'});}
  await alipayGuard(p);
  await p.waitForFunction(()=>performance.getEntriesByType('resource').some(r=>{try{const u=new URL(r.name);return u.hostname==='uemprod.alipay.com'&&u.pathname==='/service.json'&&u.searchParams.get('operation')==='mrchcenter.artisan.v2.ext.query';}catch{return false;}}),{timeout:15000});
  const response=await guardedRequest(p,opts,()=>p.evaluate(async()=>{
   const known=performance.getEntriesByType('resource').map(r=>r.name).findLast(n=>{try{const u=new URL(n);return u.hostname==='uemprod.alipay.com'&&u.pathname==='/service.json'&&u.searchParams.get('operation')==='mrchcenter.artisan.v2.ext.query';}catch{return false;}});
   if(!known)throw new Error('ALIPAY_SESSION_NOT_READY');
   const original=new URL(known);const u=new URL('https://uemprod.alipay.com/service.json');
   u.searchParams.set('operation','mrchcenter.artisan.v2.ext.query');u.searchParams.set('_input_charset','utf-8');u.searchParams.set('_output_charset','utf-8');const token=original.searchParams.get('ctoken');if(token)u.searchParams.set('ctoken',token);
   const body=new URLSearchParams({data:JSON.stringify({pageSource:'fund_home_pc_merchant',parameters:{switchToNew:'true'}})});
   const r=await fetch(u,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body,credentials:'include',signal:AbortSignal.timeout(20000)});if(!r.ok)throw new Error('ALIPAY_HTTP_'+r.status);return r.json();
  }),{alipay:true});
  return normalizeAlipayBalance(response,accountId);
 }
 return {fund,mtop,pay,currentAlipayBalance,async identity(){
  const role=await mtop('mtop.taobao.finance.fund.merchant.checkRole',{});const accounts=await pay('cardList.json');
  const identity=await page.evaluate(()=>{const c=window.QN_WORKBENCH_CFG;return {pageTitle:document.title,origin:location.origin,shop:c?.shopInfo?{shopName:c.shopInfo.shopName,shopId:String(c.shopInfo.shopId??''),nick:c.shopInfo.nick}:null,seller:c?.user?{sellerId:String(c.user.userid??''),nick:c.user.nick,isSubaccount:c.user.issub}:null};});
  return {schemaVersion:1,pageIdentity:identity,capturedAt:new Date().toISOString(),timezone:'Asia/Shanghai',taobao:role,alipay:accounts,bindingStatus:'unverified',note:'当前浏览器账户；店铺与支付宝的归属仍需平台绑定证据或调用者确认。'};
 },async page(source,dataset,window,n,accountId,catalog){
  if(source==='taobao'){
   const d=catalog.datasets.find(d=>d.id===dataset);if(!d)throw financeError('DATASET_UNKNOWN','账单不在实时目录。');
   let c;
   if(d.kind==='detail'){const dateMonth=d.dateType==='month';c=await fund('/billDetail/queryBillDetail',{searchCondition:{billCode:d.billCode,bizCode:d.bizCode,subBizCode:d.subBizCode,billCycleFrom:dateMonth?window.from.slice(0,7):window.from,billCycleTo:dateMonth?window.to.slice(0,7):window.to},billDirection:d.direction,pageNo:n,pageSize:100});}
   else {c=await fund(`/${d.kind==='month'?'monthBill':'dayBill'}/${d.kind==='day'&&d.direction==='EXPENSE'?'queryExpenseBillByDay':'queryBillSummary'}`,{searchCondition:{billCode:d.billCode,billCycleFrom:d.kind==='month'?window.from.slice(0,7):window.from,billCycleTo:d.kind==='month'?window.to.slice(0,7):window.to},billDirection:d.direction,pageNo:n,pageSize:100});}
   return {rows:c.data,hasNext:bool(c.hasNext),total:c.count==null?null:Number(c.count),sourceRef:'fundtax:'+dataset};
  }
  if(source==='aggregate'){
   const c=await mtop('mtop.taobao.finance.fund.bill.query',{pageNo:n,pageSize:100,billCycleFrom:dataset==='months'?window.from.slice(0,7):window.from,billCycleTo:dataset==='months'?window.to.slice(0,7):window.to,billCode:({ledger:'BILL_DETAIL',withdrawals:'WITHDRAW_DETAIL',freezes:'FROZEN_DETAIL',months:'BILL_MONTH_AGG'})[dataset],...(dataset==='freezes'?{searchCondition:JSON.stringify({FREEZE_TYPE:'FROZEN,UNFROZEN'})}:{})});const t=c.tableValues;return {rows:t?.data,hasNext:bool(t?.hasNext),total:t?.totalNum==null?null:Number(t.totalNum),summary:c.summaries,fields:c.tableHeader,sourceRef:'mtop:fund.bill.query:'+dataset};
  }
  if(source==='deposit'){
   const c=await mtop('mtop.alibaba.jibu.accounting.jour.get',{pageSize:100,pageNum:n,startTime:window.from+' 00:00:00',endTime:window.to+' 23:59:59',paymentChannelType:dataset==='cash'?1:2,bizCode:'taobao.jibu',...(dataset==='cash'?{outOrderId:null}:{insurancePolicyNo:''})},{deposit:true});const t=c.model;if(!t||!Number.isInteger(Number(t.total)))throw financeError('SCHEMA_CHANGED','保证金分页结构变化。');return {rows:t.list??[],hasNext:n*100<Number(t.total),total:Number(t.total),unit:'cent',sourceRef:'mtop:jibu.accounting.jour.get:'+dataset};
  }
  if(source==='alipay'&&dataset==='trades'){
   const c=await pay('tradeListQuery.json',{entityFilterType:'1',tradeFrom:'ALL',targetTradeOwner:'USERID',zftSmid:'',pageNum:String(n),pageSize:'100',startTime:window.from+' 00:00:00',endTime:nextDay(window.to)+' 00:00:00',status:'ALL',billUserId:accountId,timeType:'gmtTradeCreate',sortType:'0',_input_charset:'gbk'});
   if(c.status!=='succeed'||!c.result?.paging)throw financeError('ALIPAY_RESPONSE_FAILED','支付宝交易订单请求失败。');const t=c.result;return {rows:t.detail,hasNext:Number(t.paging.current)*Number(t.paging.sizePerPage)<Number(t.paging.totalItems),total:Number(t.paging.totalItems),summary:t.summary,timeBasis:'trade-creation',semantics:'order-status-not-cash-ledger',sourceRef:'alipay:tradeListQuery'};
  }
  const c=await pay('fundAccountDetail.json',{showType:'0',accountType:'',settleBillRadio:'1',billUserId:accountId,startDateInput:window.from+' 00:00:00',endDateInput:nextDay(window.to)+' 00:00:00',pageNum:String(n),pageSize:'100',queryEntrance:'1',querySettleAccount:'false',switchToFrontEnd:'true',_input_charset:'gbk'});
  if(c.status!=='succeed'||!c.result?.paging)throw financeError('ALIPAY_RESPONSE_FAILED','支付宝账单请求失败。');const t=c.result;return {rows:t.detail,hasNext:Number(t.paging.current)*Number(t.paging.sizePerPage)<Number(t.paging.totalItems),total:Number(t.paging.totalItems),summary:t.summary,sourceRef:'alipay:fundAccountDetail'};
 }};
}
export async function financeCatalog(client,source,{dataset}={}){
 const base={schemaVersion:1,source,asOf:new Date().toISOString(),timezone:'Asia/Shanghai',currency:'CNY',availableDateRange:null,datasets:[]};
 if(source==='taobao'){
  for(const direction of ['INCOME','EXPENSE']){if(dataset&&!dataset.startsWith(direction.toLowerCase()))continue;const r=await client.fund('/monthBill/renderBillSummaryPage',{billDirection:direction},'GET');for(const bill of r.billTypeTreeVO??[])base.datasets.push(...['month','day'].map(kind=>({id:`${direction.toLowerCase()}-${kind}:${bill.code}`,kind,direction,billCode:bill.code,name:bill.name,dateType:kind,fields:r.summaryReportRenderVO??null})));
   for(const b of r.billTypeTreeVO??[])for(const z of b.child??[])for(const s of z.child??[]){const id=[direction.toLowerCase(),b.code,z.code,s.code].join(':');if(dataset&&dataset!==id)continue;const meta=await client.fund('/billDetail/renderBillDetailPage',{billDirection:direction,billCode:b.code,bizCode:z.code,subBizCode:s.code},'GET');const fields=meta.searchRenderVO?.fieldList??[];base.datasets.push({id:[direction.toLowerCase(),b.code,z.code,s.code].join(':'),kind:'detail',direction,billCode:b.code,bizCode:z.code,subBizCode:s.code,name:[b.name,z.name,s.name].join('/'),dateType:fields.some(f=>f.inputType==='dateMonth')?'month':'day',fields:meta});}
  }base.warnings=['目录按当前店铺动态返回；未知历史日期边界保持 null。月粒度明细只能按整月请求。'];
 }else{
 const defs={aggregate:[['ledger','资金收支流水'],['withdrawals','提现记录'],['freezes','冻结与解冻事件'],['months','官方月结余额']],deposit:[['cash','现金保证金流水'],['insurance','保险保证金流水']],alipay:[['ledger','支付宝资金流水及期间官方余额'],['trades','支付宝交易订单状态（按创建时间）']]};base.datasets=(defs[source]??[]).map(([id,name])=>({id,name,dateType:id==='months'?'month':'day',unit:source==='deposit'?'cent':'yuan',semantics:id==='trades'?'order-status-not-cash-ledger':'source-facts',timeBasis:id==='trades'?'trade-creation':null,fields:null}));base.warnings=['字段与分页证据以实际响应为准；未返回历史数据不等于余额为零。'];if(source==='alipay'){const init=await client.pay(dataset==='trades'?'salesOrderInit.json':'fundAccountDetailInit.json');if(init.status!=='succeed')throw financeError('ALIPAY_RESPONSE_FAILED','支付宝目录请求失败。');base.availableDateRange={from:init.billWebInitDate??null,to:null};base.filters={bizTypeList:init.bizTypeList??[],accountTypeList:init.accountTypeList??[]};}
 }if(dataset)base.datasets=base.datasets.filter(d=>d.id===dataset);return base;
}
