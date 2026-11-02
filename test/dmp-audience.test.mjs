import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {prepareDmpAudience,audienceBody,normalizeAudience,AUDIENCE_DIMENSIONS} from '../src/tbcli/dmp-audience.mjs';
import {createDmpClient} from '../src/tbcli/dmp.mjs';
import {runDmpAudience} from '../src/tbcli/commands/dmp-audience.mjs';
import {parseArgs} from '../src/tbcli/args.mjs';
const row=(name,count,rate)=>({optionName:name,optionValue:name,optionNum:count,rate});
const ok=rows=>({httpStatus:200,body:{info:{ok:true},data:{result:{chartDataFull:rows}}}});
test('portrait options default to 30-day purchase and build exact peer behavior filters',()=>{
 const p=prepareDmpAudience(parseArgs(['dmp','audience','--item-id','123']));assert.equal(p.days,30);assert.equal(p.type,'purchase');
 const b=audienceBody(p,AUDIENCE_DIMENSIONS[0]);assert.equal(b.tagId,114554);assert.deepEqual(b.selectTagOptionSetDTO.selectTagOptionSetDTO[0].selects.map(x=>[x.optionGroupId,x.values]),[[303279,'123'],[303280,'4'],[303281,'30']]);
 for(const t of ['purchase','browse','favorite','cart','search'])for(const days of [7,15,30,90])assert.equal(prepareDmpAudience({itemId:'123',audienceType:t,days}).days,days);
 for(const opts of [{days:31},{days:''},{audienceType:'all'},{itemId:'x'}])assert.throws(()=>prepareDmpAudience({itemId:'123',...opts}),{code:'DMP_INVALID_INPUT'});
});
test('counts, unknowns, raw rates, overlapping tags and empty results retain distinct meanings',()=>{
 const d=AUDIENCE_DIMENSIONS[0],r=normalizeAudience(ok([row('female','8','.8'),row('unknown','2','.2')]),d,{});assert.equal(r.countSum,10);assert.equal(r.rows[1].label,'未知');assert.equal(r.rows[1].normalizedShare,.2);assert.equal(r.rows[0].platformRate,'.8');
 const tags=normalizeAudience(ok([row('a',8,'.8'),row('b',7,'.7')]),AUDIENCE_DIMENSIONS[4],{});assert.equal(tags.countSum,15);assert.equal(tags.rows[0].normalizedShare,8/15);assert.equal(tags.countMeaning,'label-count-sum-not-unique-people');
 assert.equal(normalizeAudience(ok([]),d,{}).status,'empty');assert.equal(normalizeAudience(ok([row('a',0,'0')]),d,{}).rows[0].normalizedShare,null);
 for(const raw of [null,'',false,-1,'NaN'])assert.equal(normalizeAudience(ok([row('a',raw,'0')]),d,{}).error,'DMP_SCHEMA_CHANGED');
 assert.equal(normalizeAudience({httpStatus:200,body:{info:{ok:true},data:{}}},d,{}).status,'unavailable');
});
test('POST goes through authenticated shared client and guards stop subsequent requests',async()=>{
 const previous={fetch:globalThis.fetch,document:globalThis.document};let checks=0;const calls=[];
 globalThis.document={cookie:'_tb_token_=fixture'};
 globalThis.fetch=async(url,init)=>{calls.push({url:new URL(url),init});return {status:200,url:String(url),text:async()=>JSON.stringify(String(url).includes('loginuserinfo')?{data:{csrfId:'fixture'}}:ok([]).body)};};
 const page={url:()=> 'https://dmp.taobao.com/',evaluate:async()=>{checks++;return {url:'https://dmp.taobao.com/',title:'DMP',text:'',frames:''};},evaluateHandle:async()=>{const state={};return {evaluate:(fn,spec)=>fn(state,spec),dispose:async()=>{}};}};
 try{const c=await createDmpClient({pages:()=>[page]},{delayRange:{minDelayMs:0,maxDelayMs:0},timeoutMs:1000});await c.request('audience',{},audienceBody(prepareDmpAudience({itemId:'123'}),AUDIENCE_DIMENSIONS[0]));await c.dispose();assert.equal(calls.length,2);assert.equal(calls[1].url.pathname,'/api/dmp/insight/tag/chart');assert.equal(calls[1].init.method,'POST');assert.equal(calls[1].init.credentials,'include');assert.ok(checks>=6);assert.equal(JSON.parse(calls[1].init.body).needUnknown,true);}finally{globalThis.fetch=previous.fetch;if(previous.document===undefined)delete globalThis.document;else globalThis.document=previous.document;}
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'portrait-')),oldLog=console.log,oldExit=process.exitCode;console.log=()=>{};
 try{const out=path.join(dir,'data.json');let count=0;const r=await runDmpAudience({itemId:'123',out,json:true},{session:async(opts,cb)=>{assert.equal(opts.browserRole,'merchant');return cb({context:{}});},clientFactory:async()=>({request:async()=>{if(++count===2)throw Object.assign(Error('stop'),{code:'TAOBAO_VERIFICATION_REQUIRED'});return ok([row('female',2,'1')]);},dispose:async()=>{}})});assert.equal(count,2);assert.equal(r.status,'stopped');assert.equal(JSON.parse(fs.readFileSync(out)).dimensions.length,1);await assert.rejects(runDmpAudience({itemId:'123',out}),{code:'OUTPUT_EXISTS'});await assert.rejects(runDmpAudience({itemId:'123',out,startDate:'2026-01-01'}),{code:'DMP_INVALID_INPUT'});}finally{console.log=oldLog;process.exitCode=oldExit;fs.rmSync(dir,{recursive:true,force:true});}
});
