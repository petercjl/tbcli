import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp, readFile, writeFile, rm, stat} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {parseArgs} from '../src/tbcli/args.mjs';
import {createDmpClient, COST_FIELDS, normalizeDmpCosts, dmpComputed, DMP_CATALOG} from '../src/tbcli/dmp.mjs';
import {prepareDmpDiscovery, normalizeDmpDiscovery} from '../src/tbcli/dmp-discovery.mjs';
import {runDmpDiscovery} from '../src/tbcli/commands/dmp-discovery.mjs';

const now = new Date('2026-05-01T05:00:00Z');
const ok = data => ({httpStatus: 200, body: {info: {ok: true}, data}});
test('discovery argv preserves explicit filters and competitor ID as text', () => {
  const opts = parseArgs(['dmp','competitors','--anchor-id','123','--keyword','456','--cate-id','789','--page','2','--page-size','10']);
  const p = prepareDmpDiscovery('competitors',opts,now);
  assert.deepEqual(p.body,{keyword:'456',itemId:'123',cateId:789,page:2,pageSize:10,competitionSceneType:1});
  const a = prepareDmpDiscovery('analysis-items',parseArgs(['dmp','analysis-items','--keyword','盒子','--life-stage-codes','1,2','--order-indicator','gmv30d','--order-type','desc']),now);
  assert.equal(a.kind,'analysisItems');assert.equal(a.query.lifeStageCodes,'1,2');assert.equal(a.query.orderIndicator,'gmv30d');assert.equal(a.query.orderType,'desc');
  assert.deepEqual(a.delayRange,{minDelayMs:1000,maxDelayMs:2000});
});
test('ranking payload is a selected date/type/category snapshot', () => {
  const p=prepareDmpDiscovery('market-rank',{cateId:'789',date:'2026-04-30',rankType:'SEARCH_HOT'},now);
  assert.deepEqual(p.body,{cateId:'789',periodType:'1',date:'2026-04-30',subjectType:'ITEM',rankType:'SEARCH_HOT',properties:[],options:[]});
  for(const opts of [{cateId:'1'},{cateId:'1',date:'2026-05-01'},{cateId:'1',date:'2026-02-30'},{cateId:'1',date:'2026-04-30',rankType:'other'},{cateId:'1',date:'2026-04-30',page:2}]) assert.throws(()=>prepareDmpDiscovery('market-rank',opts,now),{code:'DMP_INVALID_INPUT'});
  for(const opts of [{keyword:'456'},{anchorId:'123'},{anchorId:'-1',keyword:'456'},{anchorId:'123',keyword:'456',pageSize:101}])assert.throws(()=>prepareDmpDiscovery('competitors',opts,now),{code:'DMP_INVALID_INPUT'});
});
test('discovery preserves missing fields, raw extras and current-page coverage', () => {
  const p=prepareDmpDiscovery('competitors',{anchorId:'123',keyword:'456',page:2,pageSize:10},now);
  const r=normalizeDmpDiscovery(ok({list:[{id:456,name:'example',pictUrl:null,gmv30d:0,customMetric:8}],pager:{currentPage:2,pageSize:10,total:25}}),p);
  assert.equal(r.status,'returned');assert.equal(r.items[0].itemId,'456');assert.equal(r.items[0].mainImageUrl,null);assert.equal(r.source.raw.data.list[0].customMetric,8);assert.equal(r.source.raw.data.list[0].gmv30d,0);
  assert.equal(r.coverage.scope,'one-page-only');assert.equal(r.coverage.pager.total,25);assert.equal(r.source.request.method,'POST');
  assert.equal(normalizeDmpDiscovery(ok({list:[]}),p).status,'empty');
  assert.equal(normalizeDmpDiscovery({httpStatus:200,body:{info:{ok:false,message:'系统繁忙'},data:null}},p).status,'unavailable');
  assert.equal(normalizeDmpDiscovery(ok({list:[null]}),p).error,'DMP_SCHEMA_CHANGED');
  assert.throws(()=>normalizeDmpDiscovery(ok({list:[{id:456}],pager:{currentPage:1,pageSize:10}}),p),{code:'DMP_PAGE_MISMATCH'});
});
test('ranking retains source type and does not claim echoed date or complete market coverage', () => {
  const p=prepareDmpDiscovery('market-rank',{cateId:'789',date:'2026-04-30'},now);
  const r=normalizeDmpDiscovery(ok({rankList:[{itemId:'456',itemName:'example',shopId:'9',shopName:'shop',rank:1,startsDays:30}]}),p);
  assert.equal(r.items[0].rank,1);assert.equal(r.items[0].startsDays,30);assert.equal(r.coverage.dateVerified,false);assert.equal(r.coverage.rankType,'SALES_STAR');assert.equal(r.coverage.scope,'provider-ranking-snapshot');
});
test('five provider labels represent CNY spend and trend remains separate from sums', () => {
  const row={date:'20260430',gmv:0.75,...Object.fromEntries(Object.values(COST_FIELDS).map(k=>[k,0])),'货品全站推消耗占比':263.62};
  const c=normalizeDmpCosts(ok({lineInfo:[row],stages:[]}),{startDate:'2026-04-30',endDate:'2026-04-30',days:1});
  assert.equal(c.unit,'CNY');assert.equal(c.totals.total,263.62);assert.equal(c.daily[0].gmvTrend,0.75);assert.equal(c.daily[0].normalizedGmv,0.75);
  const calc=dmpComputed({costs:c,metrics:{status:'complete',values:{transactionCount:10,avgOrderValue:50,paidClicks:2,freeClicks:0,ipv:20}}});
  assert.equal(calc.estimatedGmv,500);assert.equal(calc.costsCny.blendedCpc,131.81);assert.deepEqual(calc.costsCny,calc.assumingCostsAreCny);assert.equal(DMP_CATALOG.endpoints.costs.unit,'CNY');
});
test('all three wire paths execute through the existing authenticated guarded client', async () => {
  const previous={fetch:globalThis.fetch,document:globalThis.document};const calls=[],checks=[];
  globalThis.document={cookie:'_tb_token_=fake-test-only'};
  globalThis.fetch=async(url,init)=>{calls.push({url:new URL(url),init});return{status:200,url:String(url),text:async()=>JSON.stringify(String(url).includes('loginuserinfo')?{info:{ok:true},data:{csrfId:'test-csrf',loginUser:{nickname:'test'}}}:{info:{ok:true},data:{list:[],rankList:[]}})};};
  const page={url:()=> 'https://dmp.taobao.com/index_new.html',evaluate:async()=>{checks.push('guard');return{url:'https://dmp.taobao.com',title:'DMP',text:'',frames:''};},evaluateHandle:async()=>{const state={csrf:''};return{evaluate:(fn,spec)=>fn(state,spec),dispose:async()=>{}};}};
  try{
    const client=await createDmpClient({pages:()=>[page]},{delayRange:{minDelayMs:0,maxDelayMs:0},timeoutMs:1000});
    for(const [cmd,opts] of [['analysis-items',{}],['competitors',{anchorId:'123',keyword:'456'}],['market-rank',{cateId:'789',date:'2026-04-30'}]]){
      const p=prepareDmpDiscovery(cmd,opts,now);await client.request(p.kind,p.query,p.body);
    }
    await client.dispose();assert.deepEqual(calls.map(x=>x.url.pathname),['/api_2/login/loginuserinfo','/api/goods/analysis/item/list','/api/goods/benchmark/item/list','/api/subdivide/market/ranking/list']);
    assert.ok(checks.length>=12);assert.equal(calls[2].init.method,'POST');assert.equal(JSON.parse(calls[2].init.body).itemId,'123');assert.equal(calls[1].init.credentials,'include');
  }finally{globalThis.fetch=previous.fetch;if(previous.document===undefined)delete globalThis.document;else globalThis.document=previous.document;}
});
test('command preflights output and arguments before authentication; access stop never retries', async () => {
  const dir=await mkdtemp(path.join(os.tmpdir(),'tbcli-discovery-'));const oldLog=console.log,oldExit=process.exitCode;console.log=()=>{};
  try{
    const out=path.join(dir,'result.json');await writeFile(out,'owned',{flag:'wx'});let authenticated=false;
    const opts={anchorId:'123',keyword:'456',out,json:true};
    await assert.rejects(runDmpDiscovery('competitors',opts,{session:async()=>{authenticated=true;}}),{code:'OUTPUT_EXISTS'});assert.equal(authenticated,false);assert.equal(await readFile(out,'utf8'),'owned');
    await assert.rejects(runDmpDiscovery('competitors',{...opts,searchKeywords:['one','two']}),{code:'DMP_INVALID_INPUT'});
    const events=[];const fresh=path.join(dir,'fresh.json');
    const result=await runDmpDiscovery('competitors',{...opts,out:fresh},{session:async(_opts,cb)=>{events.push('auth');return cb({context:{}});},clientFactory:async()=>({account:'test',request:async()=>{events.push('request');throw Object.assign(Error('stop'),{code:'TAOBAO_VERIFICATION_REQUIRED'});},dispose:async()=>events.push('dispose')})});
    assert.deepEqual(events,['auth','request','dispose']);assert.equal(result.status,'stopped');assert.equal(JSON.parse(await readFile(fresh)).error.code,'TAOBAO_VERIFICATION_REQUIRED');if(process.platform!=='win32')assert.equal((await stat(fresh)).mode&0o777,0o600);
    const success=await runDmpDiscovery('analysis-items',{json:true},{session:async(_opts,cb)=>cb({context:{}}),clientFactory:async()=>({account:'test',request:async()=>ok({list:[{id:'456',name:'example'}]}),dispose:async()=>{}})});
    assert.equal(success.account,'test');assert.equal(success.items[0].itemId,'456');
  }finally{console.log=oldLog;process.exitCode=oldExit;await rm(dir,{recursive:true,force:true});}
});


test('machine discovery distinguishes optional discovery exports from required report outputs', async () => {
 const manifest=JSON.parse(await readFile(new URL('../capabilities.json',import.meta.url),'utf8'));
 for(const command of ['analysis-items','competitors','market-rank','items','catalog']) assert.notEqual(manifest.commandContracts['dmp '+command].options['--out'].required,true);
 for(const command of ['report','item-info']) assert.equal(manifest.commandContracts['dmp '+command].options['--out'].required,true);
});
