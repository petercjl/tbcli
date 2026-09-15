import {connectDatabase,loadDatabaseConfig} from '../database.mjs';
import {exportProfitEstimate,getProfitEstimate,validateProfitRequest} from '../profit-estimate.mjs';

export async function withProfitReadTransaction(c,operation) {
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await c.query("SET LOCAL statement_timeout = '120s'");
    const result=await operation();
    await c.query('COMMIT');
    return result;
  } catch(error) {await c.query('ROLLBACK').catch(()=>{});throw error;}
}
async function execute(args,operation) {
  validateProfitRequest(args);
  const c=await connectDatabase(await loadDatabaseConfig(args.config),'reader');
  try {console.log(JSON.stringify(await withProfitReadTransaction(c,()=>operation(c,args)),null,2));}
  finally {await c.end();}
}
export async function runProfitEstimateQuery(args){return execute(args,getProfitEstimate);}
export async function runProfitEstimateExport(args){return execute(args,exportProfitEstimate);}
