import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {normalizeVideos} from '../src/tbcli/item-media.mjs';
import {guardedDetailAction} from '../src/tbcli/item-detail.mjs';
import {runItemMedia} from '../src/tbcli/commands/item-media.mjs';
test('explicit empty videos differ from missing or unknown records; signatures are retained',()=>{assert.equal(normalizeVideos({videos:[]}).status,'absent');assert.equal(normalizeVideos({}).status,'unavailable');assert.equal(normalizeVideos({videos:[{unknown:1}]}).status,'partial');const r=normalizeVideos({videos:[{url:'https://cloud.video.taobao.com/a.mp4?signature=x',coverUrl:'//img.alicdn.com/a.jpg'}]});assert.equal(r.status,'captured');assert(r.records[0].url.endsWith('?signature=x'));});
test('media auth precedes collection and shared guard stops navigation before request',async()=>{const dir=await fs.mkdtemp(path.join(os.tmpdir(),'item-media-'));try{let called=false;await assert.rejects(runItemMedia({itemId:'1',out:path.join(dir,'out.json')},{session:async()=>{throw Error('auth');},collect:()=>called=true}));assert.equal(called,false);const events=[];await guardedDetailAction({evaluate:async()=>({url:'https://item.taobao.com',title:'',text:''})},{check:async()=>events.push('guard')},{minDelayMs:0,maxDelayMs:0},()=>events.push('request'));assert.deepEqual(events,['guard','guard','request','guard']);let requests=0;await assert.rejects(guardedDetailAction({}, {check:async()=>{throw Object.assign(Error('blocked'),{code:'TAOBAO_VERIFICATION_REQUIRED'});}}, {},()=>requests++));assert.equal(requests,0);}finally{await fs.rm(dir,{recursive:true});}});

test('official HTTP playback URLs normalize to HTTPS and retain query, order and real thumbnail field',()=>{
 const head={videos:[{url:'http://cloud.video.taobao.com/play/u/123/p/2/e/6/t/1/456.mp4?appKey=38829&signature=a%2Bb',videoThumbnailURL:'//img.alicdn.com/cover.jpg'},{url:'https://cloud.video.taobao.com/play/u/234/p/2/e/6/t/1/567.mp4?appKey=38829',videoThumbnailURL:'https://img.alicdn.com/second.jpg'}]};
 const r=normalizeVideos(head);assert.equal(r.status,'captured');assert.equal(r.records.length,2);assert.equal(r.records[0].url,'https://cloud.video.taobao.com/play/u/123/p/2/e/6/t/1/456.mp4?appKey=38829&signature=a%2Bb');assert.equal(r.records[0].posterUrl,'https://img.alicdn.com/cover.jpg');assert.deepEqual(r.records.map(x=>x.sourceIndex),[0,1]);
});
test('video URL validation stays strict and malformed covers do not discard valid video',()=>{
 const r=normalizeVideos({videos:[{url:'http://other.taobao.com/play/a.mp4'},{url:'http://cloud.video.taobao.com.evil.test/play/a.mp4'},{url:'https://user:pass@cloud.video.taobao.com/play/a.mp4'},{url:'https://cloud.video.taobao.com/play/a.mp4',videoThumbnailURL:'https://['}]});
 assert.equal(r.status,'partial');assert.equal(r.records.length,1);assert.equal(r.records[0].posterUrl,undefined);
});
