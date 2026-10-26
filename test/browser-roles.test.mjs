import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {BUYER_COMMANDS, resolveBrowserTarget, forBrowserRole} from '../src/tbcli/browser-target.mjs';
import {resolveSessionMode, withBrowserSession} from '../src/tbcli/browser-session.mjs';
import {matchesBrowserCommand} from '../src/tbcli/commands/browser.mjs';
import {parseArgs} from '../src/tbcli/args.mjs';
import {runItemDetail} from '../src/tbcli/commands/item-detail.mjs';
import {runItemMedia} from '../src/tbcli/commands/item-media.mjs';
import {runSearchProducts} from '../src/tbcli/commands/search-products.mjs';
import {runShopProducts} from '../src/tbcli/commands/shop-products.mjs';
const resolve = (opts={},env={}) => resolveBrowserTarget(opts,{env,home:'/test-home'});

test('all front-page operations route to a separate buyer endpoint/profile without selecting an account implicitly', () => {
  for (const command of BUYER_COMMANDS) {
    const target = resolve({_:command.split(' ')});
    assert.equal(target.browserRole,'buyer'); assert.equal(target.port,9224);
    assert.equal(target.cdpUrl,'http://127.0.0.1:9224');
    assert.equal(target.profileDir,path.resolve('/test-home/.taobao-user-chrome-profile'));
    assert.equal(target.theme,'orange');
  }
  for (const command of ['dmp snapshot','dmp item-info','sycm market-rank','orders list','logistics query','finance export','ai-dianjing report','document get']) {
    const target=resolve({_:command.split(' ')});
    assert.equal(target.browserRole,'merchant');assert.equal(target.port,9223);assert.equal(target.theme,'blue');
    assert.throws(()=>resolve({_:command.split(' '),browserRole:'buyer'}),{code:'BROWSER_ROLE_CONFLICT'});
  }
});
test('merchant environment configuration never supplies buyer defaults and buyer overrides remain separate', () => {
  const env={TBCLI_CDP_URL:'http://127.0.0.1:9555',TBCLI_CHROME_PROFILE:'/merchant',TBCLI_REMOTE_DEBUGGING_PORT:'9555'};
  assert.equal(resolve({browserRole:'buyer'},env).port,9224);
  assert.equal(resolve({},env).port,9555);
  const both={...env,TBCLI_BUYER_CDP_URL:'http://127.0.0.1:9666',TBCLI_BUYER_CHROME_PROFILE:'/buyer'};
  assert.equal(resolve({browserRole:'buyer'},both).port,9666);
  assert.equal(resolve({browserRole:'buyer'},both).profileDir,path.resolve('/buyer'));
  assert.throws(()=>resolve({browserRole:'buyer',cdpUrl:'http://localhost:9555'},env),{code:'BROWSER_TARGET_CONFLICT'});
  assert.throws(()=>resolve({cdpUrl:'http://localhost:9666'},both),{code:'BROWSER_TARGET_CONFLICT'});
});
test('opposite role endpoints, Profiles, symlink aliases, role conflicts and invalid arguments stop before connection', async t => {
  for (const opts of [{browserRole:'buyer',cdpUrl:'http://localhost:9223'},{browserRole:'merchant',cdpUrl:'http://127.0.0.1:9224'},{browserRole:'buyer',profileDir:'/test-home/.dianshang-chrome-profile'},{browserRole:'merchant',profileDir:'/test-home/.taobao-user-chrome-profile'}]) assert.throws(()=>resolve(opts),{code:'BROWSER_TARGET_CONFLICT'});
  assert.throws(()=>resolve({_:['item','detail'],browserRole:'merchant'}),{code:'BROWSER_ROLE_CONFLICT'});
  assert.throws(()=>resolve({browserRole:'bad'}),{code:'INVALID_BROWSER_ROLE'});
  assert.throws(()=>resolve({port:9555,cdpUrl:'http://127.0.0.1:9556'}),{code:'INVALID_BROWSER_PORT'});
  assert.throws(()=>parseArgs(['auth','status','--browser-role']),{code:'INVALID_BROWSER_ROLE'});
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tbcli-role-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const home=path.join(dir,'home');fs.mkdirSync(home);fs.mkdirSync(path.join(home,'.dianshang-chrome-profile'));fs.symlinkSync(path.join(home,'.dianshang-chrome-profile'),path.join(home,'alias'),process.platform==='win32'?'junction':'dir');
  assert.throws(()=>resolveBrowserTarget({browserRole:'buyer',profileDir:path.join(home,'alias')},{env:{},home}),{code:'BROWSER_TARGET_CONFLICT'});
  let invoked=false;
  await assert.rejects(withBrowserSession({browserRole:'buyer',cdpUrl:'http://127.0.0.1:9223'},()=>{invoked=true;}),{code:'BROWSER_TARGET_CONFLICT'});
  assert.equal(invoked,false);
});
test('buyer auto does not probe or fall back to merchant; explicit managed retains the buyer role', async () => {
  let probes=0;
  assert.equal(await resolveSessionMode({browserRole:'buyer'},{cdpReachable:async()=>{probes++;return false;}}),'cdp');
  assert.equal(probes,0);
  assert.equal(await resolveSessionMode({browserRole:'buyer',sessionMode:'managed'},{cdpReachable:async()=>{throw Error('must not probe');}}),'managed');
  assert.equal(resolve(parseArgs(['auth','status','--browser-role','buyer'])).port,9224);
  assert.equal(resolve(parseArgs(['doctor','--browser-role','buyer'])).browserRole,'buyer');
  assert.equal(resolve(parseArgs(['dev','pages','--browser-role','buyer'])).browserRole,'buyer');
  assert.equal(forBrowserRole({},'buyer').browserRole,'buyer');
});
test('front-page entry points reject merchant role before creating output or making data requests', async () => {
  for(const run of [runItemDetail,runItemMedia,runSearchProducts,runShopProducts]) await assert.rejects(run({browserRole:'merchant'}),{code:'BROWSER_ROLE_CONFLICT'});
});
test('local Chrome process verification binds the exact port/Profile and keeps the sandbox', () => {
  const target={port:9224,profileDir:'/tmp/buyer profile'};
  const cmd='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=9224 --user-data-dir=/tmp/buyer profile --no-first-run';
  assert.equal(matchesBrowserCommand(cmd,target),true);
  assert.equal(matchesBrowserCommand(cmd.replace('9224','9223'),target),false);
  assert.equal(matchesBrowserCommand(cmd.replace('buyer profile','merchant profile'),target),false);
  assert.equal(matchesBrowserCommand(cmd+' --no-sandbox',target),false);
  assert.equal(matchesBrowserCommand(cmd.replace('9224','92240'),target),false);
});
