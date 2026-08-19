import { assertPageNotVerifying } from './taobao-guard.mjs';

export const DEFAULT_MIN_API_DELAY_MS = 1000;
export const DEFAULT_MAX_API_DELAY_MS = 2000;
export const DEFAULT_MIN_PAGE_ACTION_DELAY_MS = 3000;
export const DEFAULT_MAX_PAGE_ACTION_DELAY_MS = 5000;

export function randomDelayMs(min, max, random = Math.random) {
  if (max <= min) return min;
  return min + Math.floor(random() * (max - min + 1));
}

export function resolveApiDelayRange(opts = {}, {
  defaultMinDelayMs = DEFAULT_MIN_API_DELAY_MS,
  defaultMaxDelayMs = DEFAULT_MAX_API_DELAY_MS,
} = {}) {
  const fixedDelay = opts.delayMs == null
    ? null
    : boundedInteger(opts.delayMs, 0, 0, 60000, '--delay-ms');
  const minDelayMs = fixedDelay
    ?? boundedInteger(opts.minDelayMs, defaultMinDelayMs, 0, 60000, '--min-delay-ms');
  const maxDelayMs = fixedDelay
    ?? boundedInteger(opts.maxDelayMs, defaultMaxDelayMs, 0, 60000, '--max-delay-ms');
  if (maxDelayMs < minDelayMs) throw new Error('--max-delay-ms 不能小于 --min-delay-ms');
  return { minDelayMs, maxDelayMs };
}

export function resolvePageActionDelayRange(opts = {}) {
  return resolveApiDelayRange(opts, {
    defaultMinDelayMs: DEFAULT_MIN_PAGE_ACTION_DELAY_MS,
    defaultMaxDelayMs: DEFAULT_MAX_PAGE_ACTION_DELAY_MS,
  });
}

export async function waitBeforeTaobaoApiRequest(page, delayRange, {
  random = Math.random,
  sleepImpl = sleep,
} = {}) {
  return waitWithTaobaoGuards(page, delayRange, { random, sleepImpl });
}

export async function waitAfterTaobaoPageActionBeforeApiRequest(page, delayRange, {
  random = Math.random,
  sleepImpl = sleep,
} = {}) {
  return waitWithTaobaoGuards(page, delayRange, { random, sleepImpl });
}

async function waitWithTaobaoGuards(page, delayRange, { random, sleepImpl }) {
  await assertPageNotVerifying(page);
  const delayMs = randomDelayMs(delayRange.minDelayMs, delayRange.maxDelayMs, random);
  await sleepImpl(delayMs);
  await assertPageNotVerifying(page);
  return delayMs;
}

function boundedInteger(value, fallback, min, max, option) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${option} 必须是 ${min}-${max} 的整数`);
  }
  return parsed;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
