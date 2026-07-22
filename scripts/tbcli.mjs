#!/usr/bin/env node
import { main } from '../src/tbcli/cli.mjs';

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
