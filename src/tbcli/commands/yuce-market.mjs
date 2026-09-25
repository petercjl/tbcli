import { assertMaintainerAccess, connectDatabase, loadDatabaseConfig } from '../database.mjs';
import { ensureYuceMarketSchema, getYuceMarketStatus, importYuceCategoryWorkbook,
  validateYuceCategoryWorkbook, yuceValidationSummary } from '../yuce-market.mjs';

function print(value) { console.log(JSON.stringify(value, null, 2)); }

export async function runYuceCategoryValidate(args) {
  const validation = await validateYuceCategoryWorkbook(args.input);
  print(yuceValidationSummary(validation));
  return validation;
}

export async function runYuceCategoryInit(args) {
  const config = await loadDatabaseConfig(args.config);
  assertMaintainerAccess(config);
  const client = await connectDatabase(config, 'ingest');
  try {
    await client.query('BEGIN');
    try {
      await ensureYuceMarketSchema(client);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
    print(await getYuceMarketStatus(client));
  } finally { await client.end(); }
}

export async function runYuceCategoryImport(args) {
  const validation = await validateYuceCategoryWorkbook(args.input);
  const config = await loadDatabaseConfig(args.config);
  assertMaintainerAccess(config);
  const client = await connectDatabase(config, 'ingest');
  try {
    const result = await importYuceCategoryWorkbook(client, validation, { mode: args.mode || 'append' });
    print(result);
    return result;
  } finally { await client.end(); }
}

export async function runYuceCategoryStatus(args) {
  const config = await loadDatabaseConfig(args.config);
  const client = await connectDatabase(config, 'read');
  try { print(await getYuceMarketStatus(client)); }
  finally { await client.end(); }
}
