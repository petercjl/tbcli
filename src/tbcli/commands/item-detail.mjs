import {forBrowserRole} from '../browser-target.mjs';
import {lstat,open} from 'node:fs/promises';
import path from 'node:path';
import {withAuthenticatedTaobaoSession} from '../browser-session.mjs';
import {prepareDetail,collectItemDetail,detailError,detailCoverage} from '../item-detail.mjs';

export async function runItemDetail(opts,{session=withAuthenticatedTaobaoSession,collect=collectItemDetail}={}){
  opts=forBrowserRole(opts,'buyer');
  if(!opts.out||path.extname(opts.out).toLowerCase()!=='.json')throw detailError('INVALID_OUTPUT','需要新的 --out FILE.json。');
  try{await lstat(opts.out);throw detailError('OUTPUT_EXISTS','输出已存在，请使用新文件。');}catch(e){if(e.code!=='ENOENT')throw e;}
  const plan=prepareDetail(opts);const report={schemaVersion:1,command:'item detail',itemId:plan.itemId,status:'running',startedAt:new Date().toISOString(),sources:[],collectionOptions:plan.feedback,scope:'单商品当前可访问资料；评价与问答按collectionOptions采集，保留分页、停止证据与不可用范围。',limitations:['主图与SKU来自首屏结构化数据；详情图、评价、问大家来自实际页面接口响应。','采集不触发购买、领券或账户信息导出；价格保留当前会话展示口径。','默认首批；显式分页范围与停止证据见pagination。折叠或合并隐藏内容不可用时标记partial。']};
  const file=await open(opts.out,'wx',0o600);
  const save=async()=>{report.coverage=detailCoverage(report);const bytes=Buffer.from(JSON.stringify(report,null,2)+'\n');let offset=0;while(offset<bytes.length){const {bytesWritten}=await file.write(bytes,offset,bytes.length-offset,offset);offset+=bytesWritten;}await file.truncate(bytes.length);await file.sync();};
  try{await save();await session(opts,({context})=>collect(context,plan,report,save));report.finishedAt=new Date().toISOString();await save();console.log(JSON.stringify({status:report.status,itemId:plan.itemId,out:path.resolve(opts.out),coverage:report.coverage},null,2));return report;}
  catch(e){for(const module of ['reviews','questions']){const value=report[module];if(value?.pagination?.stopReason==='running')value.pagination.stopReason=/VERIF|AUTH|ACCESS|TOKEN/.test(e.code??'')?'blocked':'interrupted';for(const q of module==='questions'?(value?.records??[]):[]){if(q.answerPagination?.stopReason==='running')q.answerPagination.stopReason='interrupted';}}report.status='partial';report.error={code:e.code??'DETAIL_FAILED',message:'采集停止，已保存成功模块；请检查页面状态。'};report.finishedAt=new Date().toISOString();await save();throw detailError(report.error.code,`商品采集停止；已有结果保存在 ${path.resolve(opts.out)}。`);}
  finally{await file.close();}
}
