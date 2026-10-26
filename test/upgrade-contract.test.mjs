// Actual published old CLI/updater and real npm, not a rewritten parent.
// Matrix: historical-mode link/copy, same-version, Skill sync failure, recovery,
// unknown outcome, local-edits, true backups and unrelated-target protection.
import test from 'node:test';import assert from 'node:assert/strict';import {spawn} from 'node:child_process';import {fileURLToPath} from 'node:url';
for(const file of ['verify-upgrade.mjs','verify-update-recovery.mjs'])test('actual published old CLI and real npm: '+file,{skip:process.env.TBCLI_UPGRADE_QA!=='1',timeout:900000},async()=>{const result=await new Promise((resolve,reject)=>{const p=spawn(process.execPath,[fileURLToPath(new URL('../scripts/'+file,import.meta.url))],{env:process.env});let out='',err='';p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>{err+=b;process.stderr.write(b);});p.on('error',reject);p.on('close',code=>resolve({code,out,err}));});assert.equal(result.code,0,result.err);console.log(result.out);});
