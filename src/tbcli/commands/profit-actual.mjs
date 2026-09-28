import {connectDatabase,loadDatabaseConfig} from '../database.mjs';
import {getActualComboCostAudit,getActualCostAudit,getActualOrderCostAudit,getActualProfitCoverage,getActualProfitQuery,getActualReferenceCostAudit,validateActualComboCostAuditRequest,validateActualCostAuditRequest,validateActualOrderCostAuditRequest,validateActualCoverageRequest,validateActualProfitQueryRequest,validateActualReferenceCostAuditRequest} from '../profit-actual.mjs';
import {withProfitReadTransaction} from './profit-estimate.mjs';
import {getActualFreightFallbackAudit,validateActualFreightFallbackAuditRequest} from '../freight-fallback-audit.mjs';

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

export async function runProfitActualAuditOrderCost(args) {
  validateActualOrderCostAuditRequest(args);
  const client = await connectDatabase(await loadDatabaseConfig(args.config), 'reader');
  try {
    const result = await withProfitReadTransaction(client, () => getActualOrderCostAudit(client, args));
    console.log(JSON.stringify(result, null, 2));
    return result;
  } finally { await client.end(); }
}

export async function runProfitActualAuditComboCost(args) {
  validateActualComboCostAuditRequest(args);
  const client = await connectDatabase(await loadDatabaseConfig(args.config), 'reader');
  try {
    const result = await withProfitReadTransaction(client, () => getActualComboCostAudit(client, args));
    console.log(JSON.stringify(result, null, 2));
    return result;
  } finally { await client.end(); }
}

export async function runProfitActualAuditReferenceCost(args) {
  validateActualReferenceCostAuditRequest(args);
  const client = await connectDatabase(await loadDatabaseConfig(args.config), 'reader');
  try {
    const result = await withProfitReadTransaction(client, () => getActualReferenceCostAudit(client, args));
    console.log(JSON.stringify(result, null, 2));
    return result;
  } finally { await client.end(); }
}

export async function runProfitActualAuditFreightFallback(args) {
  validateActualFreightFallbackAuditRequest(args);
  const client = await connectDatabase(await loadDatabaseConfig(args.config), 'reader');
  try {
    const result = await withProfitReadTransaction(client, () => getActualFreightFallbackAudit(client, args));
    console.log(JSON.stringify(result, null, 2));
    return result;
  } finally { await client.end(); }
}
