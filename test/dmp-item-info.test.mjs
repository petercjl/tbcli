import test from 'node:test';import assert from 'node:assert/strict';import {normalizeDmpItemInfo} from '../src/tbcli/dmp.mjs';
import {runDmpItemInfo} from '../src/tbcli/commands/dmp.mjs';
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
test('DMP product identity preserves actual fields, safe links, empty/denied and exact-ID boundaries',()=>{
 const response={httpStatus:200,body:{info:{ok:true},data:{itemId:123,itemTitle:'测试商品',itemPictUrl:'https://img.alicdn.com/a.jpg',shopId:456}}};
 const r=normalizeDmpItemInfo(response,'123');assert.equal(r.product.title,'测试商品');assert.equal(r.product.shop.url,'https://shop456.taobao.com');assert.equal(r.status,'available');
 assert.throws(()=>normalizeDmpItemInfo(response,'999'),{code:'DMP_ITEM_ID_MISMATCH'});
 const denied=normalizeDmpItemInfo({httpStatus:200,body:{info:{ok:false,message:'无权访问'}}},'123');assert.equal(denied.product,null);assert.equal(denied.error,'DMP_PERMISSION_DENIED');
 const missing=normalizeDmpItemInfo({httpStatus:200,body:{info:{ok:true},data:null}},'123');assert.equal(missing.status,'unavailable');
 response.body.data.itemPictUrl='javascript:alert(1)';assert.equal(normalizeDmpItemInfo(response,'123').product.mainImageUrl,null);
});
test('competitor identity uses the selected DMP anchor and exact keyword, retains original evidence and protects output',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dmp-identity-')),out=path.join(dir,'identity.json'),calls=[];let disposed=false;
 const response=data=>({httpStatus:200,body:{info:{ok:true},data}});
 const deps={session:async(o,fn)=>fn({context:{}}),clientFactory:async()=>({account:'fixture',dispose:async()=>{disposed=true;},request:async(kind,query)=>{calls.push({kind,query});if(kind==='itemInfo')return response({id:456,cateId:789});if(kind==='latestDay')return response('20261025');if(kind==='successItems')return response({list:[{itemId:123,itemTitle:'测试商品',itemPictUrl:'https://img.alicdn.com/example.jpg'}],pager:{total:1}});throw Error('Unexpected operation');}})};
 try{
  const r=await runDmpItemInfo({itemId:'123',anchorId:'456',out,json:true},deps);
  assert.equal(r.status,'available');assert.equal(r.product.itemId,'123');assert.equal(r.source.raw.data.list.length,1);assert.equal(disposed,true);
  assert.deepEqual(calls.map(c=>c.kind),['itemInfo','latestDay','successItems']);assert.equal(calls[2].query.keyword,'123');assert.equal(calls[2].query.itemId,'456');assert.equal(Object.hasOwn(calls[2].query,'cateId'),false);
  const saved=fs.readFileSync(out,'utf8');await assert.rejects(runDmpItemInfo({itemId:'123',anchorId:'456',out},deps),{code:'OUTPUT_EXISTS'});assert.equal(fs.readFileSync(out,'utf8'),saved);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
