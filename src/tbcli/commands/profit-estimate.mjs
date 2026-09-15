import { assertMaintainerAccess,connectDatabase,loadDatabaseConfig } from '../database.mjs';
import { ensureProfitEstimateSchema,exportProfitEstimate,getProfitEstimate,runProfitEstimate,listProfitEstimates } from '../profit-estimate.mjs';
const print=v=>console.log(JSON.stringify(v,null,2));
export async function runProfitEstimateList(args){const c=await connectDatabase(await loadDatabaseConfig(args.config),'reader');try{print(await listProfitEstimates(c,args));}finally{await c.end();}}
export async function runProfitEstimateInit(args){const cfg=await loadDatabaseConfig(args.config);assertMaintainerAccess(cfg);const c=await connectDatabase(cfg,'ingest');try{await ensureProfitEstimateSchema(c);print({initialized:true,objects:['mart.profit_estimate_runs','mart.product_profit_daily']});}finally{await c.end();}}
export async function runProfitEstimateRun(args){const cfg=await loadDatabaseConfig(args.config);assertMaintainerAccess(cfg);const c=await connectDatabase(cfg,'ingest');try{await ensureProfitEstimateSchema(c);print(await runProfitEstimate(c,args));}finally{await c.end();}}
export async function runProfitEstimateQuery(args){const c=await connectDatabase(await loadDatabaseConfig(args.config),'reader');try{print(await getProfitEstimate(c,args));}finally{await c.end();}}
export async function runProfitEstimateExport(args){const c=await connectDatabase(await loadDatabaseConfig(args.config),'reader');try{print(await exportProfitEstimate(c,args));}finally{await c.end();}}
