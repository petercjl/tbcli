import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {DMP_CATALOG} from '../src/tbcli/dmp.mjs';
import {prepareDmpSnapshot,snapshotRequests,collectSnapshot,runDmpSnapshot} from '../src/tbcli/commands/dmp-snapshot.mjs';
const plan=()=>prepareDmpSnapshot({itemId:'123',startDate:'2026-03-01',endDate:'2026-03-07'},new Date('2026-04-01T00:00:00Z'));
const response=data=>({httpStatus:200,body:{info:{ok:true},data}});
function client(log=[],items=[{id:'456'}]){return {account:'test',request:async(kind,query,body)=>{log.push({kind,query,body});if(kind==='items')return response({list:items});if(kind==='scenes')return response([{sceneId:435,click:{itemValue:999,succItemValue:'10~20'}}]);if(kind==='keywords')return response({item:[{keyword:'owned'}],succItem:[{keyword:'target'}]});if(kind==='crowd')return response([{target:1}]);return response({value:0});},dispose:async()=>{}};}
test('single target input and five modules; comparison query context is an internal account product',()=>{
 assert.equal(DMP_CATALOG.snapshot.subjectMode,'target-only');assert.ok(DMP_CATALOG.snapshot.contextPolicy.includes('Automatically'));
 const specs=snapshotRequests(plan(),'456');assert.equal(specs.length,5);for(const s of specs.filter(x=>x.needsContext))assert.deepEqual(s.query,{itemId:'456',succItemIds:'123',startDate:'2026-03-01',endDate:'2026-03-07'});
 assert.deepEqual(JSON.parse(specs[0].body.filterCondition)[1].values,['123']);assert.deepEqual(JSON.parse(specs[4].body.filterCondition)[0].values,['123']);assert.throws(()=>prepareDmpSnapshot({itemId:'123',anchorId:'old'}),{code:'DMP_INVALID_INPUT'});
});
test('automatically chooses first valid owned ID once and completes all five sources without user input',async()=>{
 const log=[],out={modules:{}};await collectSnapshot(client(log,[{id:null},{id:'bad'},{id:'456'},{id:'789'}]),plan(),out);
 assert.equal(out.status,'complete');assert.equal(out.executionContext.itemId,'456');assert.equal(log.filter(x=>x.kind==='items').length,1);assert.equal(log.length,6);assert.equal(out.capabilityGaps.length,0);
 assert.ok(log.filter(x=>['scenes','keywords','crowd'].includes(x.kind)).every(x=>x.query.itemId==='456'&&x.query.succItemIds==='123'));assert.deepEqual(Object.keys(out.modules),['metrics7','scenes','keywords','crowdRanges','crowdTable']);
});
test('empty or denied owned list preserves independent sources and explicit context failure, never inserts a saved ID',async()=>{
 const out={modules:{}};await collectSnapshot(client([],[]),plan(),out);assert.equal(out.status,'partial');assert.equal(out.modules.metrics7.status,'returned');assert.equal(out.modules.crowdTable.status,'returned');assert.equal(out.capabilityGaps.length,3);assert.equal(out.executionContext.itemId,null);assert.equal(out.modules.scenes.error.code,'DMP_OWNED_CONTEXT_UNAVAILABLE');assert.equal(out.modules.scenes.request,null);
 const c=client();const request=c.request;c.request=(k,q,b)=>k==='items'?Promise.resolve({httpStatus:200,body:{info:{ok:false,message:'denied'},data:null}}):request(k,q,b);const denied={modules:{}};await collectSnapshot(c,plan(),denied);assert.equal(denied.executionContext.source.response.body.info.message,'denied');assert.equal(denied.modules.crowdTable.status,'returned');
});
test('verification during automatic discovery stops every later request and preserves first module',async()=>{
 let n=0;const c=client(),request=c.request;c.request=async(k,q,b)=>{n++;if(k==='items')throw Object.assign(Error(),{code:'TAOBAO_VERIFICATION_REQUIRED'});return request(k,q,b);};const out={modules:{}};await assert.rejects(collectSnapshot(c,plan(),out),{code:'TAOBAO_VERIFICATION_REQUIRED'});assert.equal(n,2);assert.deepEqual(Object.keys(out.modules),['metrics7']);
});
test('owned-only scene and keyword responses remain target-empty',async()=>{
 const c=client(),request=c.request;c.request=async(k,q,b)=>k==='scenes'?response([{click:{itemValue:999,succItemValue:null}}]):k==='keywords'?response({item:[{keyword:'owned'}],succItem:[]}):request(k,q,b);const out={modules:{}};await collectSnapshot(c,plan(),out);assert.equal(out.modules.scenes.status,'empty');assert.equal(out.modules.keywords.status,'empty');
});
test('actual command authenticates first, creates v2, protects existing files and rejects public context arguments',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'dmp-auto-context-')),out=path.join(dir,'data.json'),events=[],prior=process.exitCode;try{
 await runDmpSnapshot({itemId:'123',days:'7',out,json:true},{session:async(o,cb)=>{events.push('authenticated');return cb({context:{}});},clientFactory:async()=>client(events)});
 assert.equal(events[0],'authenticated');const d=JSON.parse(await readFile(out));assert.equal(d.snapshotVersion,2);assert.equal(d.subject.itemId,'123');assert.equal(d.executionContext.itemId,'456');assert.equal('anchorId' in d,false);assert.equal(d.status,'complete');
 await assert.rejects(runDmpSnapshot({itemId:'123',days:7,out}),{code:'OUTPUT_EXISTS'});await assert.rejects(runDmpSnapshot({itemId:'123',anchorId:'456',days:7,out:path.join(dir,'bad.json')}),{code:'DMP_INVALID_INPUT'});
 }finally{process.exitCode=prior;await rm(dir,{recursive:true,force:true});}
});
