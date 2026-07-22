import os from 'node:os';
import path from 'node:path';

export const DEFAULT_DEBUGGING_PORT = Number(process.env.TBCLI_REMOTE_DEBUGGING_PORT || 9223);
export const DEFAULT_PROFILE_DIR = process.env.TBCLI_CHROME_PROFILE
  || path.join(os.homedir(), '.dianshang-chrome-profile');
export const DEFAULT_CHROME_PATH = process.env.TBCLI_CHROME_PATH
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export const DEFAULT_START_URL = 'about:blank';
export const DEFAULT_CDP = process.env.TBCLI_CDP_URL
  || `http://127.0.0.1:${DEFAULT_DEBUGGING_PORT}`;
