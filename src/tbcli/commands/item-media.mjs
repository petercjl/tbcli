import {lstat,open} from 'node:fs/promises';
import path from 'node:path';
import {withAuthenticatedTaobaoSession} from '../browser-session.mjs';
import {collectItemMedia,mediaCoverage} from '../item-media.mjs';
import {prepareDetail,detailError} from '../item-detail.mjs';
export async function runItemMedia(opts,{session=withAuthenticatedTaobaoSession,collect=collectItemMedia}={}){
  prepareDetail(opts);
  if(!opts.out||path.extname(opts.out).toLowerCase()!=='.json')throw detailError('INVALID_OUTPUT','需要新的 --out FILE.json。');
  try{await lstat(opts.out);throw detailError('OUTPUT_EXISTS','输出已存在，请使用新文件。');}catch(e){if(e.code!=='ENOENT')throw e;}
  const report={schemaVersion:1,command:'item media',itemId:String(opts.itemId),status:'running',startedAt:new Date().toISOString(),sources:[]},file=await open(opts.out,'wx',0o600);
  const save=async()=>{report.coverage=mediaCoverage(report);const b=Buffer.from(JSON.stringify(report,null,2)+'\n');let offset=0;while(offset<b.length){const r=await file.write(b,offset,b.length-offset,offset);offset+=r.bytesWritten;}await file.truncate(b.length);await file.sync();};
  try{await save();await session(opts,({context})=>collect(context,opts,report,save));report.finishedAt=new Date().toISOString();await save();console.log(JSON.stringify({status:report.status,itemId:report.itemId,out:path.resolve(opts.out),coverage:report.coverage}));return report;}
  catch(e){report.status='partial';report.error={code:e.code??'MEDIA_COLLECTION_FAILED',message:'采集停止，成功模块已保留。'};await save();throw detailError(report.error.code,`采集停止；结果保存在 ${path.resolve(opts.out)}。`);}finally{await file.close();}
}
