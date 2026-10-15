import {createHash,randomUUID} from 'node:crypto';
import {lstat,mkdir,writeFile,readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
export const financeError=(code,message)=>Object.assign(new Error(message),{code});
export const hash=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
export function clean(value,key=''){
 if(/token|cookie|authorization|password|secret|signature|^sign$|^headers$|^url$/i.test(key))return undefined;
 if(typeof value==='number'&&/(?:id|no)$/i.test(key)&&!Number.isSafeInteger(value))throw financeError('UNSAFE_IDENTIFIER','平台以不安全数值返回业务ID，已停止以免精度损失。');
 if(Array.isArray(value))return value.map(v=>clean(v));
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,clean(v,k)]).filter(([,v])=>v!==undefined));
 return typeof value==='string'?value.trim():value;
}
export function cents(v){
 const s=String(v).trim();if(!/^-?\d+(\.\d{1,2})?$/.test(s))throw financeError('INVALID_MONEY','金额必须为精确的元数值，最多两位小数。');
 const [a,b='']=s.replace('-','').split('.');return (s.startsWith('-')?-1n:1n)*(BigInt(a)*100n+BigInt(b.padEnd(2,'0')));
}
export function day(s){if(!/^\d{4}-\d{2}-\d{2}$/.test(s??'')||new Date(s+'T00:00:00Z').toISOString().slice(0,10)!==s)throw financeError('INVALID_DATE','日期应为有效的 YYYY-MM-DD。');return s;}
export const nextDay=s=>new Date(Date.parse(day(s)+'T00:00:00Z')+86400000).toISOString().slice(0,10);
export function windows(from,to,{monthly=false}={}){
 day(from);day(to);if(from>to)throw financeError('INVALID_DATE','开始日期晚于结束日期。');
 const out=[];let start=from;
 while(start<=to){const d=new Date(start+'T00:00:00Z');const monthEnd=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).toISOString().slice(0,10);const limit=new Date(d.getTime()+29*86400000).toISOString().slice(0,10);const end=[to,monthEnd,...(monthly?[]:[limit])].sort()[0];out.push({from:start,to:end});start=nextDay(end);}return out;
}
export function boundary(at){
 if(!/^\d{4}-\d{2}-\d{2}T00:00:00\+08:00$/.test(at??''))return null;
 const s=day(at.slice(0,10));if(s.slice(8)!=='01')return null;
 return {day:s,month:new Date(Date.parse(s+'T00:00:00Z')-86400000).toISOString().slice(0,7)};
}
export function rowKey(source,dataset,r){
 const id=r.accountLogId??r.jourId??r.id??r.bizNo;
 return String(id??hash(r))+(dataset==='freezes'?`:${r.frozenType}:${r.frozenDate}:${r.frozenAmount}`:'');
}
export async function writeNew(file,value){await writeFile(file,JSON.stringify(clean(value),null,2)+'\n',{flag:'wx',mode:0o600});}
export async function absent(file){try{await lstat(file);throw financeError('OUTPUT_EXISTS','输出已存在，请选择新路径。');}catch(e){if(e.code!=='ENOENT')throw e;}}
export async function openRun(opts){
 const root=path.resolve(opts.out);const scope={source:opts.source,dataset:opts.dataset,shopKey:opts.shopKey,accountId:opts.accountId,from:day(opts.startDate),to:day(opts.endDate)};
 if(scope.from>scope.to)throw financeError('INVALID_DATE','日期范围无效。');
 let run;
 if(opts.resume){run=JSON.parse(await readFile(path.join(root,'run.json'),'utf8'));if(run.runId!==opts.resume||hash(run.scope)!==hash(scope))throw financeError('RESUME_SCOPE_MISMATCH','恢复的运行标识、账户或日期范围不符。');}
 else{await absent(root);await mkdir(root,{mode:0o700});run={schemaVersion:1,runId:randomUUID(),scope,startedAt:new Date().toISOString()};await writeNew(path.join(root,'run.json'),run);}
 const completed=new Map();for(const f of (await readdir(root)).filter(f=>/^shard-.*\.json$/.test(f))){const v=JSON.parse(await readFile(path.join(root,f),'utf8'));if(v.sha256!==hash(v.payload))throw financeError('EVIDENCE_CHANGED','分片校验失败。');completed.set(v.key,{...v,file:f});}
 return {root,run,completed,async shard(key,payload){if(completed.has(key))return completed.get(key);const v={key,sha256:hash(payload),payload:clean(payload)};v.sha256=hash(v.payload);const file=`shard-${hash(key)}.json`;await writeNew(path.join(root,file),v);completed.set(key,{...v,file});return completed.get(key);},async finish(data){const name=`manifest-${randomUUID()}.json`;const manifest={...run,...data,finishedAt:new Date().toISOString(),shards:[...completed.values()].map(v=>({key:v.key,file:v.file,sha256:v.sha256}))};await writeNew(path.join(root,name),manifest);return {...manifest,manifestPath:path.join(root,name)};}};
}
export async function collectPages(request,{source,dataset,onPage,maxPages=10000}){
 const seen=new Set();let count=0;const evidence=[];
 for(let n=1;n<=maxPages;n++){
  const p=await request(n);if(!Array.isArray(p.rows)||typeof p.hasNext!=='boolean')throw financeError('SCHEMA_CHANGED','账单分页结构不符合契约。');
  if(p.hasNext&&!p.rows.length)throw financeError('EMPTY_NEXT_PAGE','平台声明还有下一页但返回空页。');
  const fingerprint=hash(p.rows.map(r=>rowKey(source,dataset,r)));if(p.rows.length&&seen.has(fingerprint))throw financeError('PAGINATION_STALLED','分页重复，采集停止。');seen.add(fingerprint);
  await onPage(n,p);count+=p.rows.length;evidence.push({page:n,rows:p.rows.length,hasNext:p.hasNext,reportedTotal:p.total??null});
  if(!p.hasNext){if(p.total!=null&&p.total>0&&count!==p.total)throw financeError('COUNT_MISMATCH','返回记录总数与分页数量不符。');return {count,evidence};}
 }throw financeError('PAGE_LIMIT','分页超过保护上限。');
}
