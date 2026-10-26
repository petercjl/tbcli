import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import {normalizeSummary,displayedCount,extractSummaryState} from '../src/tbcli/item-summary.mjs';
import {runItemSummary} from '../src/tbcli/commands/item-summary.mjs';
import {guardedDetailAction} from '../src/tbcli/item-detail.mjs';
const fixture=()=>({item:{itemId:'123',title:'Test item',images:Array.from({length:7},(_,i)=>`https://img.alicdn.com/${i}.jpg`)},seller:{shopName:'Test shop',shopId:'456',pcShopUrl:'//shop456.taobao.com'},salesDesc:'已售 300+',reviewTotal:'24',prices:{extra:{priceText:'13.8',priceMoney:'1380',priceTitle:'秒杀价',priceDesc:'起'},base:{priceText:'18.8'}}});
test('buyer summary retains five ordered main images and displayed count/price scopes, with safe canonical links',()=>{
 const r=normalizeSummary(fixture(),'123','https://detail.tmall.com/item.htm?id=123&tracking=private');
 assert.equal(r.status,'complete');assert.equal(r.product.mainImages.length,5);assert.equal(r.product.mainImages[4],'https://img.alicdn.com/4.jpg');assert.equal(r.product.itemUrl,'https://detail.tmall.com/item.htm?id=123');
 assert.equal(r.product.soldCount.kind,'lower-bound');assert.equal(r.product.soldCount.value,300);assert.equal(r.product.soldCount.text,'已售 300+');assert.equal(r.product.entryPrice.text,'13.8');assert.equal(r.product.entryPrice.qualifier,'起');assert.equal(r.product.entryPrice.priceMoney,'1380');assert.equal(r.product.reviewCount.value,24);assert.equal(r.product.shop.url,'https://shop456.taobao.com/');
 assert.throws(()=>normalizeSummary(fixture(),'456','https://detail.tmall.com/item.htm?id=123'),{code:'ITEM_ID_MISMATCH'});assert.throws(()=>normalizeSummary(fixture(),'123','https://example.com/item.htm?id=123'),{code:'ITEM_ID_MISMATCH'});
 const partial=fixture();partial.item.images=partial.item.images.slice(0,2);partial.reviewTotal=null;partial.prices={};assert.equal(normalizeSummary(partial,'123','https://item.taobao.com/item.htm?id=123').status,'partial');
 assert.equal(displayedCount('0').value,0);assert.equal(displayedCount('1.2万').kind,'rounded');assert.equal(displayedCount('1.2万+').value,12000);assert.equal(displayedCount(null).value,null);assert.equal(displayedCount('未显示').kind,'unknown');
});
test('first-screen projection excludes identities, trade context and request tokens',()=>{
 const old=globalThis.window;
 const res={item:{itemId:'123',title:'Test',images:[],private:'secret'},seller:{shopId:'456',shopName:'Shop',userId:'secret',sellerNick:'secret'},pcTrade:{address:'secret'},componentsVO:{titleVO:{salesDesc:'已售 0'},rateVO:{totalCount:'0',group:[{userNick:'secret'}]},priceVO:{extraPrice:{priceText:'1',token:'secret'}}}};
 globalThis.window={__ICE_APP_CONTEXT__:{loaderData:{home:{data:{res}}}}};
 try{const raw=extractSummaryState();assert.ok(!JSON.stringify(raw).includes('secret'));assert.equal(raw.reviewTotal,'0');assert.equal(raw.salesDesc,'已售 0');}finally{globalThis.window=old;}
});
test('summary authenticates before collection, refuses existing outputs and preserves verification-stop evidence',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tbcli-summary-'));
 try{
  const events=[],out=path.join(dir,'summary.json');
  const report=await runItemSummary({itemId:'123',out},{session:async(opts,cb)=>{assert.equal(opts.browserRole,'buyer');events.push('auth');return cb({context:{}});},collect:async(ctx,opts,report,save)=>{events.push('read');Object.assign(report,normalizeSummary(fixture(),'123','https://item.taobao.com/item.htm?id=123'));await save();}});
  assert.deepEqual(events,['auth','read']);assert.equal(report.summaryVersion,1);await assert.rejects(runItemSummary({itemId:'123',out}),{code:'OUTPUT_EXISTS'});
  const stopped=path.join(dir,'stopped.json');let collected=false;await assert.rejects(runItemSummary({itemId:'123',out:stopped},{session:async()=>{throw Object.assign(Error('login'),{code:'TAOBAO_VERIFICATION_REQUIRED'});},collect:()=>{collected=true;}}),{code:'TAOBAO_VERIFICATION_REQUIRED'});assert.equal(collected,false);assert.equal(JSON.parse(fs.readFileSync(stopped)).status,'stopped');
  await assert.rejects(runItemSummary({itemId:'123',browserRole:'merchant',out:path.join(dir,'wrong.json')}),{code:'BROWSER_ROLE_CONFLICT'});assert.equal(fs.existsSync(path.join(dir,'wrong.json')),false);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('summary uses the shared page-action protection and stops on verification without executing navigation',async()=>{
 const events=[],page={evaluate:async()=>({url:'https://item.taobao.com/',title:'安全验证',text:'请完成滑块验证'})};
 await assert.rejects(guardedDetailAction(page,{check:async()=>events.push('check')},{minDelayMs:0,maxDelayMs:0},async()=>events.push('navigate')),{code:'TAOBAO_VERIFICATION_REQUIRED'});assert.equal(events.includes('navigate'),false);
});
