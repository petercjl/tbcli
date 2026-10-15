import {waitBeforeTaobaoApiRequest,resolveApiDelayRange} from './api-policy.mjs';
import {assertPageNotVerifying,isVerificationSignal} from './taobao-guard.mjs';
import {financeError,clean,hash} from './finance-core.mjs';
export function parseExactJson(text){
 let out='';for(let i=0;i<text.length;){const c=text[i];if(c==='"'){const start=i++;while(i<text.length){if(text[i]==='\\'){i+=2;continue;}if(text[i++]==='"')break;}out+=text.slice(start,i);}else if(/[\d-]/.test(c)){const token=/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i))?.[0];if(!token){out+=c;i++;continue;}const unsafe=/^-?\d+$/.test(token)&&(BigInt(token)>BigInt(Number.MAX_SAFE_INTEGER)||BigInt(token)<BigInt(Number.MIN_SAFE_INTEGER));out+=unsafe?JSON.stringify(token):token;i+=token.length;}else{out+=c;i++;}}return JSON.parse(out);
}
export function orderFact(r){
 if(!r.orderInfo?.id||!Array.isArray(r.subOrders)||!r.orderInfo.createTime)throw financeError('ORDER_SCHEMA_CHANGED','订单主账缺少主单号、创建时间或子单列表。');
 return {id:String(r.orderInfo.id),createdAt:r.orderInfo.createTime,status:r.statusInfo?.text??null,actualFee:r.payInfo?.actualFee??null,amountMeaning:'平台列表实收款展示值；待付款或已关闭订单也可能展示该值，不等于资金已入账。',currency:r.extra?.currency??'CNY',flags:{inHold:r.extra?.inHold??null,presentOrder:r.presentOrder??null},items:r.subOrders.map(s=>({id:String(s.idStr??s.id),title:s.itemInfo?.title??null,sku:s.itemInfo?.skuText??[],quantity:String(s.quantity??''),price:s.priceInfo??{},status:s.statusInfo?.text??null,operations:(s.operations??[]).map(o=>({text:o.text,id:o.id??null,type:o.type??null})),extra:s.itemInfo?.extra??[],skuId:s.itemInfo?.skuId==null?null:String(s.itemInfo.skuId)})),operations:(r.statusInfo?.operations??[]).map(o=>({id:o.id??null,text:o.text,type:o.type})),payAnnotations:r.payInfo?.postType??null};
}
export async function monitorOrderRequest(page,request,{timeoutMs=30000,pollMs=500}={}){
 let timer,interval,checking=false;const guard=new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(financeError('ORDER_REQUEST_TIMEOUT','订单请求超时，成功分页已保留。')),timeoutMs);interval=setInterval(async()=>{if(checking)return;checking=true;try{await assertPageNotVerifying(page);}catch(e){reject(e);}finally{checking=false;}},pollMs);});
 try{return await Promise.race([request,guard]);}finally{clearTimeout(timer);clearInterval(interval);}
}
export async function queryOrdersPage(page,{tab,pageNum,cursor=null,opts={},wait=waitBeforeTaobaoApiRequest}={}){
 if(tab==='before3Months'&&pageNum>1&&!cursor)throw financeError('ORDER_CURSOR_REQUIRED','历史订单下一页需要原响应游标。');
 if(!['latest3Months','before3Months'].includes(tab)||!Number.isInteger(pageNum)||pageNum<1)throw financeError('ORDER_SCOPE_INVALID','订单分区或页码无效。');
 await wait(page,resolveApiDelayRange(opts));
 const request=page.evaluate(async({tab,pageNum,cursor})=>{
  const r=await fetch('https://trade.taobao.com/trade/itemlist/asyncSold.htm?event_submit_do_query=1&_input_charset=utf8',{method:'POST',credentials:'include',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({isQnNew:'true',isHideNick:'true',prePageNo:String(Math.max(1,pageNum-1)),sifg:'0',action:tab==='before3Months'?'itemlist/SoldHisQueryAction':'itemlist/SoldQueryAction',close:'0',pageNum:String(pageNum),orderStatus:'',rateStatus:'',queryMore:'false',tabCode:tab,...(cursor?{lastStartRow:cursor}:{})}),signal:AbortSignal.timeout(20000)});
  const bytes=await r.arrayBuffer();const contentType=r.headers.get('content-type')??'';const charset=/charset\s*=\s*([^;\s]+)/i.exec(contentType)?.[1]??'gb18030';return {status:r.status,redirected:r.redirected,verification:/login|captcha|punish|_____tmd_____/.test(r.url),contentType,text:new TextDecoder(charset).decode(bytes)};
 },{tab,pageNum,cursor});
 const response=await monitorOrderRequest(page,request);
 await assertPageNotVerifying(page);
 if(response.redirected||response.verification)throw financeError('TAOBAO_VERIFICATION_REQUIRED','订单接口要求登录或验证。');if(response.status!==200)throw financeError('ORDER_HTTP_FAILED','订单主账请求失败。');
 if(response.text.includes('\ufffd'))throw financeError('ORDER_ENCODING_FAILED','订单响应出现编码替换字符，停止采集。');
 let d;try{d=parseExactJson(response.text);}catch{if(isVerificationSignal(response.text.slice(0,2000)))throw financeError('TAOBAO_VERIFICATION_REQUIRED','订单接口要求验证。');throw financeError('ORDER_SCHEMA_CHANGED','订单接口未返回有效JSON。');}
 if(d.query?.useCheckcode===true||d.query?.errorCheckcode===true)throw financeError('TAOBAO_VERIFICATION_REQUIRED','订单接口要求验证。');
 if(d.error){if(isVerificationSignal(d.error))throw financeError('TAOBAO_VERIFICATION_REQUIRED','订单接口要求验证。');throw financeError('ORDER_RESPONSE_FAILED','订单接口返回业务错误。');}
 if(!d.page||!Array.isArray(d.mainOrders)||d.query?.tabCode!==tab||Number(d.page.currentPage)!==pageNum)throw financeError('ORDER_SCOPE_MISMATCH','平台返回的订单分区或页码与请求不一致。');
 return clean({rows:d.mainOrders.map(orderFact),page:pageNum,total:tab==='before3Months'?null:Number(d.page.totalNumber),reportedTotal:Number(d.page.totalNumber),totalPages:tab==='before3Months'?null:Number(d.page.totalPage),prefetchCount:d.page.prefetchCount??null,hasNext:tab==='before3Months'?d.mainOrders.length>0:pageNum<Number(d.page.totalPage),cursor:tab==='before3Months'?(d.query.lastStartRow??null):null,pagingMode:tab==='before3Months'?'cursor-until-empty':'total-pages',tab,contentType:response.contentType,sourceRef:'taobao:asyncSold'});
}
export async function collectOrders(client,{onPage,maxPages=10000}={}){
 const all=new Map(),evidence=[];for(const tab of ['latest3Months','before3Months']){const seen=new Set();let count=0;let expected;let cursor=null;
 for(let n=1;n<=maxPages;n++){const p=await client(tab,n,cursor);const fingerprint=hash(p.rows.map(r=>r.id));if(p.rows.length&&seen.has(fingerprint))throw financeError('ORDER_PAGE_STALLED','订单分页重复。');seen.add(fingerprint);if(p.hasNext&&!p.rows.length)throw financeError('ORDER_EMPTY_NEXT','还有下一页但订单为空。');if(p.total!=null)expected??=p.total;if(p.total!=null&&p.total!==expected)throw financeError('ORDER_SNAPSHOT_CHANGED','采集期间订单总数变化，需保存后重新核查。');await onPage(tab,n,p);count+=p.rows.length;for(const row of p.rows){if(all.has(row.id)&&hash(all.get(row.id))!==hash(row))throw financeError('ORDER_CONFLICT','跨分区重复订单存在冲突。');all.set(row.id,row);}if(!p.hasNext){if(p.total!=null&&count!==p.total)throw financeError('ORDER_COUNT_MISMATCH','订单分页数量与平台总数不符。');evidence.push({tab,rows:count,pages:n,total:p.total,stopReason:p.pagingMode==='cursor-until-empty'?'terminal-empty-page':'reported-total'});break;}if(tab==='before3Months'){if(!p.cursor||p.cursor===cursor)throw financeError('ORDER_CURSOR_STALLED','历史订单游标未前进。');cursor=p.cursor;}if(n===maxPages)throw financeError('PAGE_LIMIT','订单分页超过保护上限。');}}
 return {rows:[...all.values()],evidence};
}
