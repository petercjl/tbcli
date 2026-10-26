import assert from 'node:assert/strict';
import test from 'node:test';
import { createVerificationError, isVerificationSignal, VERIFICATION_ERROR_CODE } from '../src/tbcli/taobao-guard.mjs';

test('detects login, captcha, and MTOP validation signals', () => {
  assert.equal(isVerificationSignal('https://login.taobao.com/'), true);
  assert.equal(isVerificationSignal('请完成滑块验证'), true);
  assert.equal(isVerificationSignal('FAIL_SYS_USER_VALIDATE'), true);
  assert.equal(isVerificationSignal('服务器挤爆了，请稍后再试'), true);
  assert.equal(isVerificationSignal('https://kemi.tmall.com/category.htm'), false);
});

test('verification errors carry a stable stop code and user instruction', () => {
  const error = createVerificationError('验证码');
  assert.equal(error.code, VERIFICATION_ERROR_CODE);
  assert.match(error.message, /立即停止所有请求/);
  assert.match(error.message, /手动完成验证/);
});


test('verification iframe is detected even when main page text looks normal',async()=>{const {assertPageNotVerifying}=await import('../src/tbcli/taobao-guard.mjs');await assert.rejects(()=>assertPageNotVerifying({evaluate:async()=>({url:'https://myseller.taobao.com/',title:'已卖出宝贝',text:'正常订单列表',frames:'https://trade.taobao.com/_____tmd_____/punish'})}),{code:'TAOBAO_VERIFICATION_REQUIRED'});});
