import fs from 'node:fs';

const packageJson = JSON.parse(fs.readFileSync(
  new URL('../../package.json', import.meta.url),
  'utf8',
));

export const TBCLI_VERSION = String(packageJson.version || 'unknown');

export function runVersion() {
  console.log(TBCLI_VERSION);
}
