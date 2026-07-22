export const VERIFICATION_ERROR_CODE = 'TAOBAO_VERIFICATION_REQUIRED';

export function verificationMessage(detail = '') {
  const suffix = detail ? `（${detail}）` : '';
  return `淘宝疑似触发登录验证或风控${suffix}。tbcli 已立即停止所有请求；请在电商浏览器中手动完成验证后，再重新执行命令。`;
}

export function isVerificationSignal(value) {
  const text = String(value || '');
  return /login\.taobao\.com|login\.tmall\.com|sec\.taobao\.com|captcha|punish|_____tmd_____|滑块|验证码|安全验证|请完成验证|访问受限|账号登录|重新登录|FAIL_SYS_USER_VALIDATE|RGV587|SESSION_EXPIRED|ILLEGAL_ACCESS/i.test(text);
}

export function createVerificationError(detail = '') {
  const error = new Error(verificationMessage(detail));
  error.code = VERIFICATION_ERROR_CODE;
  return error;
}

export async function assertPageNotVerifying(page) {
  let state;
  try {
    state = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      text: (document.body?.innerText || '').slice(0, 2000),
    }));
  } catch (error) {
    throw createVerificationError(`页面状态无法读取：${error?.message || error}`);
  }
  if (isVerificationSignal(`${state.url}\n${state.title}\n${state.text}`)) {
    throw createVerificationError(`${state.title || state.url}`);
  }
}
