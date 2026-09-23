import {connectDatabase,loadDatabaseConfig} from '../database.mjs';
import {getActualCostAudit,getActualProfitCoverage,getActualProfitQuery,validateActualCostAuditRequest,validateActualCoverageRequest,validateActualProfitQueryRequest} from '../profit-actual.mjs';
import {withProfitReadTransaction} from './profit-estimate.mjs';

export async function runProfitActualCoverage(args) {
  validateActualCoverageRequest(args);
  const client = await connectDatabase(await loadDatabaseConfig(args.config), 'reader');
  try {
    const result = await withProfitReadTransaction(client, () => getActualProfitCoverage(client, args));
    console.log(JSON.stringify(result, null, 2));
    return result;
  } finally { await client.end(); }
}

export async function runProfitActualQuery(args) {
  validateActualProfitQueryRequest(args);
  const client = await connectDatabase(await loadDatabaseConfig(args.config), 'reader');
  try {
    const result = await withProfitReadTransaction(client, () => getActualProfitQuery(client, args));
    console.log(JSON.stringify(result, null, 2));
    return result;
  } finally { await client.end(); }
}

export async function runProfitActualAuditCost(args) {
  validateActualCostAuditRequest(args);
  const client = await connectDatabase(await loadDatabaseConfig(args.config), 'reader');
  try {
    const result = await withProfitReadTransaction(client, () => getActualCostAudit(client, args));
    console.log(JSON.stringify(result, null, 2));
    return result;
  } finally { await client.end(); }
}
