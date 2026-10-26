import {normalizeDetail,extractDetailState,observeDetailResponses,guardedDetailAction,prepareDetail,detailError} from './item-detail.mjs';
import {watchSearchVerification} from './search-products.mjs';

export function normalizeVideos(head){
  if(!Array.isArray(head?.videos))return {status:'unavailable',records:[],reason:'headImageVO.videos unavailable'};
  const records=[];
  for(const [index,v] of head.videos.entries()){
    const raw=typeof v==='string'?v:v?.url??v?.videoUrl??v?.videoPlayUrl??v?.playUrl;
    if(typeof raw!=='string'||!raw.trim())continue;
    let url;try{url=new URL(raw,'https://item.taobao.com');}catch{}
    // Taobao hydration still emits HTTP for this official playback endpoint.
    if(url?.protocol==='http:'&&url.hostname==='cloud.video.taobao.com'&&url.pathname.startsWith('/play/'))url.protocol='https:';
    if(!url||url.username||url.password||url.protocol!=='https:'||!/(^|\.)(alicdn\.com|taobaocdn\.com|tbcdn\.cn|taobao\.com)$/.test(url.hostname))continue;
    const poster=typeof v==='object'?(v.videoThumbnailURL??v.coverUrl??v.videoCover??v.cover??v.picUrl):null;
    let posterUrl;try{const p=new URL(poster,'https://item.taobao.com');if(poster&&p.protocol==='https:'&&!p.username&&!p.password&&/(^|\.)(alicdn\.com|taobaocdn\.com|tbcdn\.cn|taobao\.com)$/.test(p.hostname))posterUrl=p.href;}catch{}
    records.push({url:url.href,sourceIndex:index,...(posterUrl?{posterUrl}:{}),...(Number(v?.width)>0?{width:Number(v.width)}:{}),...(Number(v?.height)>0?{height:Number(v.height)}:{})});
  }
  return {status:head.videos.length===0?'absent':records.length===head.videos.length?'captured':'partial',records,evidence:'componentsVO.headImageVO.videos',sourceCount:head.videos.length};
}
export function mediaCoverage(report){return {
  mainImages:{status:report.detail?.mainImages?.length?'captured':'unavailable',count:report.detail?.mainImages?.length??0},
  mainVideos:{status:report.mainVideos?.status??'unavailable',count:report.mainVideos?.records?.length??0},
  descriptionImages:{status:report.description?'captured':'unavailable',count:report.description?.images?.length??0},
  skuImages:{status:report.detail?.properties?'captured':'unavailable',count:report.detail?.properties?.flatMap(p=>p.values).filter(v=>v.imageUrl).length??0}
};}
export async function collectItemMedia(context,opts,report,checkpoint=async()=>{}){
  const plan=prepareDetail(opts),page=await context.newPage(),verification=watchSearchVerification(page);
  const observer=observeDetailResponses(page,plan.itemId,async r=>{if(r.module==='description'){report.description=r.value;report.sources.push(r.source);}});
  const guard={async check(){await verification.check();await observer.flush();}};
  try{
    await guardedDetailAction(page,guard,plan.delayRange,()=>page.goto(`https://item.taobao.com/item.htm?id=${plan.itemId}`,{waitUntil:'domcontentloaded',timeout:30000}));
    let state;const end=Date.now()+20000;
    do{await guard.check();state=await page.evaluate(extractDetailState);if(state)break;await page.waitForTimeout(250);}while(Date.now()<end);
    if(!state)throw detailError('DETAIL_STATE_UNAVAILABLE','商品首屏数据不可用。');
    report.detail=normalizeDetail(state,plan.itemId);
    report.mainVideos=normalizeVideos(await page.evaluate(()=>window.__ICE_APP_CONTEXT__?.loaderData?.home?.data?.res?.componentsVO?.headImageVO?{videos:window.__ICE_APP_CONTEXT__.loaderData.home.data.res.componentsVO.headImageVO.videos}:null));
    report.sources.push({kind:'page-hydration',itemId:plan.itemId,capturedAt:new Date().toISOString(),location:'__ICE_APP_CONTEXT__.loaderData.home.data.res'});await checkpoint();
    const descriptionEnd=Date.now()+10000;
    while(!report.description&&Date.now()<descriptionEnd){await page.waitForTimeout(250);await guard.check();}
    await guard.check();report.coverage=mediaCoverage(report);report.status=Object.values(report.coverage).every(v=>['captured','absent'].includes(v.status))?'completed':'partial';await checkpoint();return report;
  }finally{observer.dispose();verification.dispose();/* Keep the visible page for manual verification. */}
}
