import {createHash} from 'node:crypto';
import {imageUrl,detailError,prepareDetail,guardedDetailAction} from './item-detail.mjs';
import {watchSearchVerification} from './search-products.mjs';

export const ITEM_SUMMARY_CONTRACT = Object.freeze({version:1,command:'item summary',browserRole:'buyer',maxMainImages:5,fields:['itemUrl','title','mainImages','shop','soldCount','entryPrice','reviewCount'],scope:'Current buyer-page product summary, independent of dated DMP performance'});
function link(value){try{const u=new URL(value,'https://item.taobao.com');if(!['http:','https:'].includes(u.protocol)||u.username||u.password||!/(^|\.)(taobao|tmall)\.com$/.test(u.hostname))return null;u.protocol='https:';u.search='';u.hash='';return u.href;}catch{return null;}}
export function displayedCount(value){
 const text=value==null?null:String(value).trim();
 if(!text)return {text:null,value:null,kind:'unavailable'};
 const m=text.replaceAll(',','').match(/(\d+(?:\.\d+)?)\s*(万|亿|千)?\s*(\+|以上)?/);
 if(!m)return {text,value:null,kind:'unknown'};
 const valueNumber=Number(m[1])*({万:10000,亿:100000000,千:1000}[m[2]]??1);
 return {text,value:valueNumber,kind:m[3]?'lower-bound':m[2]?'rounded':'exact'};
}
// A narrow projection excludes trade, delivery, buyer identity and signed requests.
export function extractSummaryState(){
 const r=window.__ICE_APP_CONTEXT__?.loaderData?.home?.data?.res;if(!r?.item)return null;
 const pick=(o,ks)=>Object.fromEntries(ks.filter(k=>o?.[k]!=null).map(k=>[k,o[k]]));
 const price=o=>pick(o,['priceText','priceMoney','priceTitle','priceDesc','hiddenPrice']);
 return {item:pick(r.item,['itemId','title','images']),seller:pick(r.seller,['shopId','shopName','pcShopUrl']),salesDesc:r.componentsVO?.titleVO?.salesDesc??null,reviewTotal:r.componentsVO?.rateVO?.totalCount??null,prices:{extra:price(r.componentsVO?.priceVO?.extraPrice),base:price(r.componentsVO?.priceVO?.price),summarySub:price(r.skuCore?.sku2info?.['0']?.subPrice),summaryBase:price(r.skuCore?.sku2info?.['0']?.price)}};
}
export function normalizeSummary(state,itemId,pageUrl){
 if(String(state?.item?.itemId)!==itemId)throw detailError('ITEM_ID_MISMATCH','商品首屏身份不符，已停止。');
 const url=new URL(pageUrl);if(!['item.taobao.com','detail.tmall.com'].includes(url.hostname)||url.searchParams.get('id')!==itemId)throw detailError('ITEM_ID_MISMATCH','商品页面地址与目标ID不符。');
 const mainImages=[...new Set((state.item.images??[]).map(imageUrl).filter(Boolean))].slice(0,5);
 const candidates=[['componentsVO.priceVO.extraPrice',state.prices?.extra],['skuCore.sku2info.0.subPrice',state.prices?.summarySub],['componentsVO.priceVO.price',state.prices?.base],['skuCore.sku2info.0.price',state.prices?.summaryBase]];
 const [priceSource,price]=candidates.find(([,v])=>v?.priceText!=null&&!['true',true].includes(v.hiddenPrice))??[null,null];
 const shopId=state.seller?.shopId==null?null:String(state.seller.shopId),shopUrl=link(state.seller?.pcShopUrl);
 const product={itemId,title:state.item.title??null,itemUrl:`https://${url.hostname}/item.htm?id=${itemId}`,mainImages,mainImageUrl:mainImages[0]??null,shop:{shopId,shopName:state.seller?.shopName??null,url:shopUrl??(/^\d+$/.test(shopId??'')?`https://shop${shopId}.taobao.com/`:null)},soldCount:{...displayedCount(state.salesDesc),scope:'页面已售展示口径，时间范围以原文为准'},entryPrice:price?{text:String(price.priceText),priceMoney:price.priceMoney==null?null:String(price.priceMoney),priceMoneyUnit:'fen',currency:'CNY',label:price.priceTitle??null,qualifier:price.priceDesc??null,source:priceSource,scope:'当前买家会话首屏入口展示价；优惠及起价保留原文'}:{text:null,priceMoney:null,currency:'CNY',source:null},reviewCount:{...displayedCount(state.reviewTotal),scope:'商品页用户评价显示总数，独立于评价明细条数'},linkSources:{itemUrl:'canonicalized-from-page-url',shopUrl:shopUrl?'seller.pcShopUrl':shopId?'constructed-from-shopId':null}};
 const coverage={itemUrl:'captured',title:product.title?'captured':'unavailable',mainImages:mainImages.length===5?'captured':mainImages.length?'partial':'unavailable',shop:product.shop.shopName&&product.shop.url?'captured':'partial',soldCount:product.soldCount.text?'captured':'unavailable',entryPrice:product.entryPrice.text?'captured':'unavailable',reviewCount:product.reviewCount.text?'captured':'unavailable'};
 return {product,coverage,status:Object.values(coverage).every(s=>s==='captured')?'complete':'partial'};
}
export async function collectItemSummary(context,opts,report,checkpoint=async()=>{}){
 const plan=prepareDetail(opts);
 const matching=context.pages().find(p=>{try{const u=new URL(p.url());return ['item.taobao.com','detail.tmall.com'].includes(u.hostname)&&u.searchParams.get('id')===plan.itemId;}catch{return false;}});
 const page=matching??await context.newPage(),guard=watchSearchVerification(page);
 try{
  await guardedDetailAction(page,guard,plan.delayRange,()=>matching?Promise.resolve():page.goto(`https://item.taobao.com/item.htm?id=${plan.itemId}`,{waitUntil:'domcontentloaded',timeout:30000}));
  let state;const end=Date.now()+20000;
  do{await guard.check();state=await page.evaluate(extractSummaryState);if(state)break;await page.waitForTimeout(250);}while(Date.now()<end);
  if(!state)throw detailError('DETAIL_STATE_UNAVAILABLE','商品首屏资料不可用。');
  Object.assign(report,normalizeSummary(state,plan.itemId,page.url()));
  report.source={kind:'page-hydration',browserRole:'buyer',itemId:plan.itemId,capturedAt:new Date().toISOString(),location:'__ICE_APP_CONTEXT__.loaderData.home.data.res',pageUrl:report.product.itemUrl,normalizedSha256:createHash('sha256').update(JSON.stringify(report.product)).digest('hex')};
  await guard.check();await checkpoint();return report;
 }finally{guard.dispose();}
}
