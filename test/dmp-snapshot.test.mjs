import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {DMP_CATALOG} from '../src/tbcli/dmp.mjs';
import {prepareDmpSnapshot,snapshotRequests,collectSnapshot,snapshotStatus,runDmpSnapshot} from '../src/tbcli/commands/dmp-snapshot.mjs';
const plan=()=>prepareDmpSnapshot({itemId:'123',startDate:'2026-03-01',endDate:'2026-03-07'},new Date('2026-04-01T00:00:00Z'));
test('v2 target-only input and five required modules are discoverable; no hidden comparison subject',()=>{
 assert.equal(DMP_CATALOG.snapshot.version,2);assert.equal(DMP_CATALOG.snapshot.subjectMode,'target-only');
 const p=plan();assert.equal(Object.hasOwn(p,'anchorId'),false);const specs=snapshotRequests(p);assert.equal(specs.length,5);
 assert.deepEqual(JSON.parse(specs[0].body.conf).indexList.map(x=>x.fieldId),[6986,6895,6813,8291,8290,6896,6897]);
 for(const spec of specs.filter(s=>!s.unsupported)){const filters=JSON.parse(spec.body.filterCondition);assert.deepEqual(filters.find(f=>[6797,7460].includes(f.fieldId)).values,['123']);assert.equal('succItemIds' in spec.query,false);}
 assert.deepEqual(specs.filter(s=>s.unsupported).map(s=>s.name),['scenes','keywords','crowdRanges']);
 assert.throws(()=>prepareDmpSnapshot({itemId:'123',anchorId:'456'}),{code:'DMP_INVALID_INPUT'});
 assert.throws(()=>prepareDmpSnapshot({itemIds:'123,456'}),{code:'DMP_INVALID_INPUT'});
});
test('all modules retained; unresolved routes neither call the platform nor masquerade as empty',async()=>{
 let n=0;const checkpoints=[],out={modules:{}};
 await collectSnapshot({account:'test',request:async()=>{n++;return {httpStatus:200,body:{info:{ok:true},data:n===1?{INDEX_CARD:{}}:{TABLE:{columns:[],rows:[],values:[]}}}};}},plan(),out,async d=>checkpoints.push(Object.keys(d.modules).length));
 assert.equal(n,2);assert.deepEqual(checkpoints,[1,2,3,4,5]);assert.equal(out.status,'partial');assert.equal(out.capabilityGaps.length,3);assert.equal(out.modules.crowdTable.status,'empty');
 for(const name of ['scenes','keywords','crowdRanges']){assert.equal(out.modules[name].reason,'capability-unverified');assert.equal(out.modules[name].request,null);assert.equal(out.modules[name].response,null);}
});
test('verification stops all later requests and retains completed checkpoints',async()=>{
 let n=0;const out={modules:{}};
 await assert.rejects(collectSnapshot({request:async()=>{if(++n===2)throw Object.assign(Error(),{code:'TAOBAO_VERIFICATION_REQUIRED'});return{httpStatus:200,body:{info:{ok:true},data:[]}};}},plan(),out),{code:'TAOBAO_VERIFICATION_REQUIRED'});
 assert.equal(n,2);assert.equal(out.modules.metrics7.status,'empty');assert.equal('crowdTable' in out.modules,false);
});
test('business errors and real zero/empty responses remain distinct',async()=>{
 assert.equal(snapshotStatus({httpStatus:200,body:{info:{ok:true},data:[]}}),'empty');
 assert.equal(snapshotStatus({httpStatus:200,body:{info:{ok:false,message:'no permission'},data:null}}),'unavailable');
 const out={modules:{}};await collectSnapshot({request:async()=>({httpStatus:200,body:{info:{ok:false,message:'no permission'},data:null}})},plan(),out);
 assert.equal(out.modules.metrics7.status,'unavailable');assert.equal(out.modules.metrics7.response.body.info.message,'no permission');
});
test('actual command authenticates before guarded requests, persists partial v2, rejects old params and existing files',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'dmp-snapshot-')),out=path.join(dir,'data.json'),events=[],prior=process.exitCode;
 try{
  await runDmpSnapshot({itemId:'123',days:'7',out,json:true},{session:async(o,cb)=>{events.push('authenticated');return cb({context:{}});},clientFactory:async()=>({account:'test',request:async()=>{events.push('guarded-request');return{httpStatus:200,body:{info:{ok:true},data:{}}};},dispose:async()=>{}})});
  assert.equal(events[0],'authenticated');assert.equal(events.length,3);assert.equal(process.exitCode,2);const d=JSON.parse(await readFile(out));assert.equal(d.snapshotVersion,2);assert.equal(d.subject.mode,'target-only');assert.equal('anchorId' in d,false);assert.equal(d.capabilityGaps.length,3);
  await assert.rejects(runDmpSnapshot({itemId:'123',anchorId:'456',days:7,out:path.join(dir,'bad.json')}),{code:'DMP_INVALID_INPUT'});
  await assert.rejects(runDmpSnapshot({itemId:'123',days:7,out}),{code:'OUTPUT_EXISTS'});
 }finally{process.exitCode=prior;await rm(dir,{recursive:true,force:true});}
});
