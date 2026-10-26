import fs from 'node:fs';

const packageJson = JSON.parse(fs.readFileSync(
  new URL('../../package.json', import.meta.url),
  'utf8',
));

export const TBCLI_VERSION = String(packageJson.version || 'unknown');

export function runVersion(opts={}) {
  const result={ok:true,package:packageJson.name,version:TBCLI_VERSION,tool:'tbcli'};
  console.log(opts.json?JSON.stringify(result):TBCLI_VERSION);return result;
}
