import {assertMaintainerAccess,connectDatabase,loadDatabaseConfig} from '../database.mjs';
import {inferComponentWeights,loadWeightObservations,readWeightReport,stageWeightReport,
  validateWeightRequest,writeNewWeightReport} from '../profit-weights.mjs';

export async function runProfitWeightsInfer(args) {
  const months=validateWeightRequest(args);
  const client=await connectDatabase(await loadDatabaseConfig(args.config),'reader');
  try {
    const {observations,sourceStats}=await loadWeightObservations(client,args.shopKey,months);
    const report=inferComponentWeights(observations,{shopKey:args.shopKey,months,
      auditSku:args.auditSku});
    report.sourceStats=sourceStats;
    const file=await writeNewWeightReport(args.out,report);
    const result={file,shopKey:report.shopKey,months:report.months,method:report.method,
      observations:report.observations,sourceStats,summary:report.summary,
      auditSku:report.audit?.erpSpecNo??null,
      auditComparisons:report.audit?.comparisons.length??0,
      auditRawRows:report.audit?.rawRows.length??0,staged:false};
    console.log(JSON.stringify(result,null,2));
    return result;
  } finally { await client.end(); }
}

export async function runProfitWeightsStage(args) {
  const validated=await readWeightReport(args.input,args);
  const config=await loadDatabaseConfig(args.config);
  assertMaintainerAccess(config);
  const client=await connectDatabase(config,'ingest');
  try {
    const result=await stageWeightReport(client,validated);
    console.log(JSON.stringify(result,null,2));
    return result;
  } finally { await client.end(); }
}
