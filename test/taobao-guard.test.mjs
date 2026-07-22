import assert from 'node:assert/strict';
import test from 'node:test';
import { createVerificationError, isVerificationSignal, VERIFICATION_ERROR_CODE } from '../src/tbcli/taobao-guard.mjs';

test('detects login, captcha, and MTOP validation signals', () => {
  assert.equal(isVerificationSignal('https://login.taobao.com/'), true);
  assert.equal(isVerificationSignal('请完成滑块验证'), true);
  assert.equal(isVerificationSignal('FAIL_SYS_USER_VALIDATE'), true);
  assert.equal(isVerificationSignal('https://kemi.tmall.com/category.htm'), false);
});

test('verification errors carry a stable stop code and user instruction', () => {
  const error = createVerificationError('验证码');
  assert.equal(error.code, VERIFICATION_ERROR_CODE);
  assert.match(error.message, /立即停止所有请求/);
  assert.match(error.message, /手动完成验证/);
});
