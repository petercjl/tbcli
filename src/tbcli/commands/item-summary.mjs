import {lstat,open} from 'node:fs/promises';
import path from 'node:path';
import {forBrowserRole} from '../browser-target.mjs';
import {withAuthenticatedTaobaoSession} from '../browser-session.mjs';
import {prepareDetail,detailError} from '../item-detail.mjs';
import {collectItemSummary} from '../item-summary.mjs';
export async function runItemSummary(opts,{session=withAuthenticatedTaobaoSession,collect=collectItemSummary}={}){
 opts=forBrowserRole(opts,'buyer');prepareDetail(opts);
 const allowed=new Set(['_','itemId','out','json','browserRole','cdpUrl','profileDir','chromePath','sessionMode','delayMs','minDelayMs','maxDelayMs']);
 if(Object.keys(opts).some(k=>!allowed.has(k))||(opts._&&opts._.length!==2))throw detailError('INVALID_ARGUMENT','商品概要参数不适用，请查看 item summary 合同。');
 if(!opts.out||path.extname(opts.out).toLowerCase()!=='.json')throw detailError('INVALID_OUTPUT','需要新的 --out FILE.json。');
 try{await lstat(opts.out);throw detailError('OUTPUT_EXISTS','输出已存在，请使用新文件。');}catch(e){if(e.code!=='ENOENT')throw e;}
 const report={schemaVersion:1,summaryVersion:1,command:'item summary',itemId:String(opts.itemId),status:'running',startedAt:new Date().toISOString(),browserRole:'buyer'},file=await open(opts.out,'wx',0o600);
 const save=async()=>{const b=Buffer.from(JSON.stringify(report,null,2)+'\n');let offset=0;while(offset<b.length){const r=await file.write(b,offset,b.length-offset,offset);offset+=r.bytesWritten;}await file.truncate(b.length);await file.sync();};
 try{await save();await session(opts,({context})=>collect(context,opts,report,save));report.finishedAt=new Date().toISOString();await save();console.log(JSON.stringify({ok:true,status:report.status,itemId:report.itemId,out:path.resolve(opts.out),coverage:report.coverage}));return report;}
 catch(e){report.status='stopped';report.error={code:e.code??'SUMMARY_COLLECTION_FAILED',message:'商品概要采集停止；已保存资料保留。'};await save();throw detailError(report.error.code,`商品概要采集停止；请检查淘宝买家浏览器，证据保存在 ${path.resolve(opts.out)}。`);}finally{await file.close();}
}
