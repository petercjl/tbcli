import { assertMaintainerAccess, connectDatabase, loadDatabaseConfig } from '../database.mjs';
import { importYuceCategories, validateYuceCategoryJson } from '../yuce-categories.mjs';

function summary(validation) {
  return {
    ok: true,
    sourceFile: validation.sourceFile,
    sourceSha256: validation.sourceSha256,
    category: validation.category,
    secondCategory: validation.secondCategory,
    categoryLevel: validation.level,
    firstMonth: validation.months[0],
    lastMonth: validation.months.at(-1),
    monthCount: validation.months.length,
    categoryCount: validation.categoryCount,
    rowCount: validation.rowCount,
  };
}

export async function runYuceCategoriesValidate(args) {
  const validation = await validateYuceCategoryJson(args.input);
  const result = summary(validation);
  console.log(JSON.stringify(result, null, 2));
  return result;
}

export async function runYuceCategoriesImport(args) {
  const validation = await validateYuceCategoryJson(args.input);
  const config = await loadDatabaseConfig(args.config);
  assertMaintainerAccess(config);
  const client = await connectDatabase(config, 'ingest');
  try {
    const imported = await importYuceCategories(client, validation);
    const result = { validation: summary(validation), imported };
    console.log(JSON.stringify(result, null, 2));
    return result;
  } finally {
    await client.end();
  }
}
