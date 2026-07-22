import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function chromePathCandidates(platform = process.platform, env = process.env) {
  if (platform === 'darwin') {
    return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  }

  if (platform === 'win32') {
    return [
      env.LOCALAPPDATA,
      env.PROGRAMFILES,
      env['PROGRAMFILES(X86)'],
    ]
      .filter(Boolean)
      .map((root) => path.win32.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  }

  return [];
}

export function resolveDefaultChromePath({
  platform = process.platform,
  env = process.env,
  existsSync = fs.existsSync,
} = {}) {
  if (env.TBCLI_CHROME_PATH) return env.TBCLI_CHROME_PATH;
  const candidates = chromePathCandidates(platform, env);
  return candidates.find((candidate) => existsSync(candidate)) || candidates[0] || '';
}

export const DEFAULT_DEBUGGING_PORT = Number(process.env.TBCLI_REMOTE_DEBUGGING_PORT || 9223);
export const DEFAULT_PROFILE_DIR = process.env.TBCLI_CHROME_PROFILE
  || path.join(os.homedir(), '.dianshang-chrome-profile');
export const DEFAULT_CHROME_PATH = resolveDefaultChromePath();
export const DEFAULT_START_URL = 'about:blank';
export const DEFAULT_CDP = process.env.TBCLI_CDP_URL
  || `http://127.0.0.1:${DEFAULT_DEBUGGING_PORT}`;
