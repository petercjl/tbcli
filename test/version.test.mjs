import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { parseArgs } from '../src/tbcli/args.mjs';
import { TBCLI_VERSION } from '../src/tbcli/version.mjs';

test('reads the published package version', () => {
  const packageVersion = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  assert.equal(TBCLI_VERSION, packageVersion);
});

test('accepts standard version flags', () => {
  assert.equal(parseArgs(['--version']).version, true);
  assert.equal(parseArgs(['-v']).version, true);
});
