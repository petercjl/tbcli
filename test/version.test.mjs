import assert from 'node:assert/strict';
import test from 'node:test';

import { parseArgs } from '../src/tbcli/args.mjs';
import { TBCLI_VERSION } from '../src/tbcli/version.mjs';

test('reads the published package version', () => {
  assert.equal(TBCLI_VERSION, '0.5.2');
});

test('accepts standard version flags', () => {
  assert.equal(parseArgs(['--version']).version, true);
  assert.equal(parseArgs(['-v']).version, true);
});
