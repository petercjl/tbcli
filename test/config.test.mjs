import assert from 'node:assert/strict';
import test from 'node:test';

import { chromePathCandidates, resolveDefaultChromePath } from '../src/tbcli/config.mjs';

test('uses TBCLI_CHROME_PATH before platform defaults', () => {
  assert.equal(resolveDefaultChromePath({
    platform: 'win32',
    env: { TBCLI_CHROME_PATH: 'D:\\Chrome\\chrome.exe' },
    existsSync: () => false,
  }), 'D:\\Chrome\\chrome.exe');
});

test('detects Chrome in common Windows install locations', () => {
  const env = {
    LOCALAPPDATA: 'C:\\Users\\Peter\\AppData\\Local',
    PROGRAMFILES: 'C:\\Program Files',
    'PROGRAMFILES(X86)': 'C:\\Program Files (x86)',
  };
  const candidates = chromePathCandidates('win32', env);

  assert.deepEqual(candidates, [
    'C:\\Users\\Peter\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ]);
  assert.equal(resolveDefaultChromePath({
    platform: 'win32',
    env,
    existsSync: (candidate) => candidate === candidates[1],
  }), candidates[1]);
});

test('keeps the standard macOS Chrome location', () => {
  assert.equal(resolveDefaultChromePath({
    platform: 'darwin',
    env: {},
    existsSync: () => true,
  }), '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
});
