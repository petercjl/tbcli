import {withAuthenticatedTaobaoSession} from '../browser-session.mjs';
import {createDmpClient, dmpError} from '../dmp.mjs';
import {prepareDmpDiscovery, normalizeDmpDiscovery} from '../dmp-discovery.mjs';
import {outputFile, save, emitError} from './dmp.mjs';

const ownOptions = {
  'analysis-items': ['page', 'pageSize', 'keyword', 'searchKeywords', 'lifeStageCodes', 'orderIndicator', 'orderType'],
  competitors: ['page', 'pageSize', 'keyword', 'searchKeywords', 'anchorId', 'cateId'],
  'market-rank': ['cateId', 'date', 'rankType'],
};

export async function runDmpDiscovery(command, opts = {}, {session = withAuthenticatedTaobaoSession, clientFactory = createDmpClient} = {}) {
  const allowed = new Set(['_', 'json', 'out', 'browserRole', 'cdpUrl', 'profileDir', 'chromePath', 'sessionMode', 'timeoutMs', 'delayMs', 'minDelayMs', 'maxDelayMs', ...ownOptions[command]]);
  if ((opts._ && opts._.join(' ') !== `dmp ${command}`) || Object.keys(opts).some(k => !allowed.has(k)) || (opts.searchKeywords?.length ?? 0) > 1) throw dmpError('DMP_INVALID_INPUT', '包含重复、未知或不适用的参数。');
  const plan = prepareDmpDiscovery(command, opts), file = await outputFile(opts.out);
  try {
    const result = await session(opts, async ({context}) => {
      const client = await clientFactory(context, plan);
      try { return {...normalizeDmpDiscovery(await client.request(plan.kind, plan.query, plan.body), plan), account: client.account}; }
      finally { await client.dispose(); }
    });
    await save(file, result);
    console.log(JSON.stringify(result, null, 2));
    if (result.status === 'unavailable') process.exitCode = 2;
    return result;
  } catch (error) {
    const result = {schemaVersion: 1, command: `dmp ${command}`, status: 'stopped', error: {code: error.code ?? 'DMP_COLLECTION_FAILED'}};
    await save(file, result); emitError(error, opts, opts.out); return result;
  } finally { await file?.close(); }
}

export const runDmpAnalysisItems = (opts, deps) => runDmpDiscovery('analysis-items', opts, deps);
export const runDmpCompetitors = (opts, deps) => runDmpDiscovery('competitors', opts, deps);
export const runDmpMarketRank = (opts, deps) => runDmpDiscovery('market-rank', opts, deps);
