import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { parseArgs } from '../src/tbcli/args.mjs';
import { prepareSearch, normalizeSearchCard, appendSearchBatch, guardedSearchAction, watchSearchVerification, collectSearchProducts, extractSearchCards, loadSearchCardImages } from '../src/tbcli/search-products.mjs';
import { runSearchProducts } from '../src/tbcli/commands/search-products.mjs';

test('repeatable search flags preserve the legacy keyword option', () => {
  const args = parseArgs(['search','products','--image','a.jpg','--image','b.png','--keyword','a','--keyword','b']);
  assert.deepEqual(args.searchImages, ['a.jpg','b.png']);
  assert.deepEqual(args.searchKeywords, ['a','b']); assert.equal(args.keyword, 'b');
});
test('input requires both modalities, bounded pages and real image bytes', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tbcli-search-'));
  try {
    const file = path.join(dir,'image.jpg'); await writeFile(file, Buffer.from([255,216,255,0]));
    const plan = await prepareSearch({ searchImages:[file,file], searchKeywords:['词','词'], maxPages:2 });
    assert.equal(plan.images.length,2); assert.equal(plan.images[0].sha256.length,64); assert.deepEqual(plan.keywords,['词','词']);
    assert.deepEqual(plan.delayRange,{minDelayMs:1000,maxDelayMs:2000});
    for (const opts of [{}, {searchImages:[file]}, {searchImages:[file],keyword:'词',maxPages:11}, {searchImages:[file],keyword:'词',maxPages:1.5}]) await assert.rejects(prepareSearch(opts));
    const bad = path.join(dir,'bad.jpg'); await writeFile(bad,'not an image');
    await assert.rejects(prepareSearch({searchImages:[bad],keyword:'词'}),{code:'INVALID_SEARCH_IMAGE'});
  } finally { await rm(dir,{recursive:true,force:true}); }
});
const row = { href:'https://item.taobao.com/item.htm?id=1234567890123456789&tracking=private',title:'寿司模具',imageUrl:'//g-search1.alicdn.com/p.jpg',priceText:'10.3',rank:1 };
test('IDs stay strings, tracking removed, unrelated links rejected, raw prices retained', () => {
  const item = normalizeSearchCard(row);
  assert.equal(item.itemId,'1234567890123456789'); assert.equal(item.url,'https://item.taobao.com/item.htm?id=1234567890123456789');
  assert.equal(item.imageUrl,'https://g-search1.alicdn.com/p.jpg'); assert.equal(item.priceText,'10.3'); assert.equal(item.reviewStatus,undefined);
  assert.equal(normalizeSearchCard({...row,href:'https://evil.example/?id=1'}),null);
  const ad=normalizeSearchCard({...row,href:'https://mclick.simba.taobao.com/cc_im?id=ad',domItemId:'99'});
  assert.equal(ad.itemId,'99');assert.equal(ad.promoted,true);assert.equal(ad.url,'https://item.taobao.com/item.htm?id=99');
});
test('raw records preserve duplicate IDs across sources and different observed prices', () => {
  const products=[];
  appendSearchBatch(products,[row],{type:'image',imageSha256:'abc',page:1});
  appendSearchBatch(products,[{...row,priceText:'12'}],{type:'keyword',keyword:'寿司',page:2});
  assert.equal(products.length,2); assert.equal(products[0].observations.length,1); assert.equal(products[1].observations[0].priceText,'12'); assert.equal(products[0].itemId,products[1].itemId);
  assert.throws(()=>appendSearchBatch(products,[{title:'bad'}],{}),{code:'SEARCH_SCHEMA_CHANGED'});
  assert.throws(()=>appendSearchBatch(products,[{...row,href:'https://item.taobao.com/item.htm?id=77'},{title:'bad'}],{}));
  assert.equal(products.length,2);
});
test('each page action is guarded and uses the shared delay before its request', async () => {
  const events=[]; const page={evaluate:async()=>{events.push('guard');return {url:'https://s.taobao.com',title:'',text:''};}};
  const guard={check:async()=>{events.push('check');}};
  await guardedSearchAction(page,guard,{minDelayMs:0,maxDelayMs:0},async()=>events.push('click'));
  assert.deepEqual(events,['check','guard','guard','check','click','check']);
});
test('verification before action stops without click or retry; after action throws', async () => {
  let calls=0;
  const page={evaluate:async()=>({url:'https://s.taobao.com',title:'安全验证',text:''})};
  await assert.rejects(guardedSearchAction(page,{check:async()=>{}},{minDelayMs:0,maxDelayMs:0},async()=>calls++),{code:'TAOBAO_VERIFICATION_REQUIRED'});
  assert.equal(calls,0);
  let checks=0;
  await assert.rejects(guardedSearchAction({}, {check:async()=>{if(++checks===3)throw new Error('blocked');}}, {}, async()=>calls++,async()=>{}), /blocked/);
  assert.equal(calls,1);
});
test('page response verification immediately blocks the next action', async () => {
  const page=new EventEmitter(); page.evaluate=async()=>({url:'https://s.taobao.com',title:'',text:''});
  const guard=watchSearchVerification(page);
  page.emit('response',{url:()=> 'https://h5api.m.taobao.com/h5/mtop.search/',request:()=>({resourceType:()=> 'xhr'}),status:()=>200,headers:()=>({'content-type':'application/json'}),text:async()=>'{"ret":["FAIL_SYS_USER_VALIDATE"]}'});
  await assert.rejects(guard.check(),{code:'TAOBAO_VERIFICATION_REQUIRED'}); guard.dispose(); assert.equal(page.listenerCount('response'),0);
});
test('existing output and dangling symlink are refused before browser access', async () => {
  const dir=await mkdtemp(path.join(os.tmpdir(),'tbcli-search-output-'));
  try {
    const out=path.join(dir,'existing.json');await writeFile(out,'owned');
    await assert.rejects(runSearchProducts({out}),{code:'OUTPUT_EXISTS'});assert.equal(await readFile(out,'utf8'),'owned');
    const link=path.join(dir,'link.json');await symlink(path.join(dir,'missing.json'),link);
    await assert.rejects(runSearchProducts({out:link}),{code:'OUTPUT_EXISTS'});
  } finally {await rm(dir,{recursive:true,force:true});}
});

function fakeSearchPage(events, { failSecond = false } = {}) {
  const p = new EventEmitter(); let number = 1; let currentUrl = 'about:blank';
  p.url = () => currentUrl;
  p.evaluate = async fn => {
    if (fn === extractSearchCards) return [{...row,href:`https://item.taobao.com/item.htm?id=${number}`}];
    if (failSecond && number === 2) return {url:currentUrl,title:'安全验证',text:''};
    return {url:currentUrl,title:'',text:''};
  };
  p.goto = async url => {events.push('goto');currentUrl=url;};
  p.waitForURL = async () => {events.push('wait-url');currentUrl=`https://s.taobao.com/search?q=word&page=${number}`;};
  p.waitForTimeout = async()=>{};
  p.close = async()=>events.push('close');
  p.locator = selector => selector === 'button.next-medium.next-pagination-item.next-next'
    ? {waitFor:async()=>{},count:async()=>1,isEnabled:async()=>true,click:async()=>{events.push('next');number++;}}
    : {fill:async()=>events.push('fill'),click:async()=>{events.push('search');currentUrl='https://s.taobao.com/search?q=word&page=1';}};
  p.getByText = () => ({count:async()=>0});
  p.getByRole = (role,opts) => {assert.equal(role,'button');assert.ok(opts.name.test('下一页，当前第1页'));return {waitFor:async()=>{},count:async()=>1,isEnabled:async()=>true,click:async()=>{events.push('next');number++;}};};
  return p;
}
test('keyword pagination uses a real click, waits for navigation, saves each batch', async () => {
  const events=[]; const p=fakeSearchPage(events); const report={products:[],batches:[]};
  await collectSearchProducts({pages:()=>[p],newPage:async()=>{throw new Error('must reuse tab');}},{images:[],keywords:['word'],maxPages:2,delayRange:{minDelayMs:0,maxDelayMs:0}},report,async r=>events.push(`save-${r.batches.length}`));
  assert.equal(report.products.length,2);
  assert.ok(events.indexOf('save-1')<events.indexOf('next'));
  assert.deepEqual(events.slice(events.indexOf('next')),['next','wait-url','save-2']);
});
test('verification on page two preserves page one and stops remaining keywords', async () => {
  const events=[]; let opened=0; const p=fakeSearchPage(events,{failSecond:true});const report={products:[],batches:[]};
  await assert.rejects(collectSearchProducts({pages:()=>[],newPage:async()=>{opened++;return p;}},{images:[],keywords:['word','later'],maxPages:3,delayRange:{minDelayMs:0,maxDelayMs:0}},report,async()=>events.push('save')),{code:'TAOBAO_VERIFICATION_REQUIRED'});
  assert.equal(opened,1);assert.equal(report.batches.length,1);assert.equal(report.products.length,1);assert.equal(events.filter(e=>e==='next').length,1);assert.ok(!events.includes('close'));
});

test('lazy image loading freezes initial IDs and excludes scroll-added products', async () => {
  const initial=[{...row,domItemId:'1234567890123456789',imageUrl:null}];let scrolled=0;
  const page={evaluate:async fn=>fn===extractSearchCards?[{...initial[0],imageUrl:row.imageUrl},{...row,domItemId:'88',href:'https://item.taobao.com/item.htm?id=88'}]:{url:'https://s.taobao.com',title:'',text:''},locator:()=>({scrollIntoViewIfNeeded:async()=>scrolled++}),waitForTimeout:async()=>{}};
  const result=await loadSearchCardImages(page,{check:async()=>{}},{minDelayMs:0,maxDelayMs:0},initial);
  assert.equal(scrolled,1);assert.equal(result.length,1);assert.equal(result[0].imageUrl,row.imageUrl);
});
