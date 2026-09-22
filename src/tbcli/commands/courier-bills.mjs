import { connectDatabase,loadDatabaseConfig,assertMaintainerAccess } from '../database.mjs';
import { validateCourierBill,billSummary,importCourierBill,queryCourierBills } from '../courier-bills.mjs';
const print=v=>console.log(JSON.stringify(v,null,2));
export async function runCourierValidate(args){const v=await validateCourierBill(args.input,args);print(billSummary(v));if(!v.ok)throw new Error('BILL_VALIDATION_FAILED');}
export async function runCourierImport(args){const cfg=await loadDatabaseConfig(args.config);assertMaintainerAccess(cfg);const v=await validateCourierBill(args.input,args);if(!v.ok){print(billSummary(v));throw new Error('BILL_VALIDATION_FAILED');}const c=await connectDatabase(cfg,'ingest');try{print({validation:billSummary(v),imported:await importCourierBill(c,v)});}finally{await c.end();}}
export async function runCourierQuery(args){const c=await connectDatabase(await loadDatabaseConfig(args.config),'reader');try{print(await queryCourierBills(c,args));}finally{await c.end();}}
