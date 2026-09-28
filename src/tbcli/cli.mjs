import { parseArgs } from './args.mjs';
import { runCourierValidate,runCourierImport,runCourierQuery } from './commands/courier-bills.mjs';
import {
  DEFAULT_CDP,
  DEFAULT_CHROME_PATH,
  DEFAULT_DEBUGGING_PORT,
  DEFAULT_PROFILE_DIR,
  DEFAULT_SESSION_MODE,
} from './config.mjs';
import { runBrowserOpen } from './commands/browser.mjs';
import { runAuthLogin, runAuthStatus } from './commands/auth.mjs';
import { runLogisticsGet } from './commands/logistics.mjs';
import { runShopProducts } from './commands/shop-products.mjs';
import { runCapabilities, runDoctor } from './commands/system.mjs';
import { runUnifiedUpdate } from './commands/update.mjs';
import { runSealseekSetup } from './commands/setup.mjs';
import { runMaintenanceStart, runMaintenanceRecord, runMaintenanceFinish, runMaintenanceStatus } from './commands/maintenance.mjs';
import { runDevCapture, runDevInspect, runDevPages } from './commands/dev.mjs';
import { runDocumentGet } from './commands/document.mjs';
import { runDocumentTree } from './commands/document-tree.mjs';
import { runAiDianjingExport } from './commands/ai-dianjing.mjs';
import { runSycmCatalog, runSycmExport, runSycmFetch, runSycmReports } from './commands/sycm-reports.mjs';
import { runSkillInstall, runSkillSource, runSkillStatus, runSkillUpdate } from './commands/skill.mjs';
import {
  runDatabaseConfigure,
  runDatabaseConfigureReader,
  runDatabaseCredentialPath,
  runDatabaseCredentialSet,
  runDatabaseCredentialBundleCreate,
  runDatabaseNetwork,
  runDatabaseSetupReader,
  runDatabaseAccessCheck,
  runDatabaseWriteCheck,
  runDatabaseCoverage,
  runDatabaseDatasets,
  runDatabaseFields,
  runDatabaseImport,
  runDatabaseInit,
  runDatabaseQuery,
  runDatabaseTables,
  runDatabaseDescribe,
  runDatabaseSql,
  runDatabaseStatus,
  runDatabaseEmployeeProvision,
  runDatabaseEmployeeGrant,
  runDatabaseEmployeeRevoke,
  runDatabaseEmployeeList,
  runDatabaseEmployeeAudit,
} from './commands/database.mjs';
import { findCommandDefinition } from './command-registry.mjs';
import { runSycmMarketRank } from './commands/sycm-market-rank.mjs';
import {
  runProfitOrdersCoverage,
  runProfitOrdersImport,
  runProfitOrdersIdentity,
  runProfitOrdersInit,
  runProfitOrdersValidate,
} from './commands/profit-orders.mjs';
import { runProfitRefundsCoverage,runProfitRefundsImport,runProfitRefundsInit,runProfitRefundsValidate } from './commands/profit-refunds.mjs';
import { runProfitEstimateExport,runProfitEstimateQuery } from './commands/profit-estimate.mjs';
import { runProfitOwnersImport, runProfitOwnersReconcile, runProfitOwnersSync } from './commands/profit-owners.mjs';
import { runProfitCostsFetch, runProfitCostsReconcile, runProfitCostsSync } from './commands/profit-costs.mjs';
import { runProfitComponentsFetch, runProfitComponentsReconcile, runProfitComponentsSync } from './commands/profit-components.mjs';
import {runProfitWeightsInfer,runProfitWeightsStage} from './commands/profit-weights.mjs';
import { runSkuGrossInit, runSkuGrossUpdate, runSkuGrossManualImport } from './commands/platform-sku-gross-weights.mjs';
import { runProfitActualAuditComboCost,runProfitActualAuditCost,runProfitActualAuditFreightFallback,runProfitActualAuditOrderCost,runProfitActualAuditReferenceCost,runProfitActualCoverage,runProfitActualQuery } from './commands/profit-actual.mjs';
import { runProductImagesImport, runProductImagesValidate } from './commands/product-images.mjs';
import { runYuceCategoriesImport, runYuceCategoriesValidate } from './commands/yuce-categories.mjs';
import { runYuceCategoryValidate, runYuceCategoryInit, runYuceCategoryImport, runYuceCategoryStatus,
  runYuceCategoryCoverage, runYuceCategoryExport } from './commands/yuce-market.mjs';
import { runVersion } from './version.mjs';
import { maybeAutoUpdate, relaunchWithUpdatedCli } from './update.mjs';

const COMMAND_HANDLERS = Object.freeze({
  version: runVersion,
  'profit freight validate': runCourierValidate,
  'profit freight import': runCourierImport,
  'profit freight query': runCourierQuery,
  update: runUnifiedUpdate,
  'setup sealseek': runSealseekSetup,
  'maintenance run-start': runMaintenanceStart,
  'maintenance run-record': runMaintenanceRecord,
  'maintenance run-finish': runMaintenanceFinish,
  'maintenance run-status': runMaintenanceStatus,
  'auth login': runAuthLogin,
  'auth status': runAuthStatus,
  'browser open': runBrowserOpen,
  'logistics get': runLogisticsGet,
  'shop products': runShopProducts,
  'document get': runDocumentGet,
  'document tree': runDocumentTree,
  'ai-dianjing export': runAiDianjingExport,
  'sycm reports': runSycmReports,
  'sycm catalog': runSycmCatalog,
  'sycm export': runSycmExport,
  'sycm fetch': runSycmFetch,
  'skill source': runSkillSource,
  'skill status': runSkillStatus,
  'skill install': runSkillInstall,
  'skill update': runSkillUpdate,
  'db configure': runDatabaseConfigure,
  'db configure-reader': runDatabaseConfigureReader,
  'db credential-path': runDatabaseCredentialPath,
  'db credential-set': runDatabaseCredentialSet,
  'db credential-bundle-create': runDatabaseCredentialBundleCreate,
  'db setup-reader': runDatabaseSetupReader,
  'db network': runDatabaseNetwork,
  'db access-check': runDatabaseAccessCheck,
  'db write-check': runDatabaseWriteCheck,
  'db status': runDatabaseStatus,
  'db init': runDatabaseInit,
  'db coverage': runDatabaseCoverage,
  'db import': runDatabaseImport,
  'db datasets': runDatabaseDatasets,
  'db fields': runDatabaseFields,
  'db query': runDatabaseQuery,
  'db tables': runDatabaseTables,
  'db describe': runDatabaseDescribe,
  'db sql': runDatabaseSql,
  'db employee-provision': runDatabaseEmployeeProvision,
  'db employee-grant': runDatabaseEmployeeGrant,
  'db employee-revoke': runDatabaseEmployeeRevoke,
  'db employee-list': runDatabaseEmployeeList,
  'db employee-audit': runDatabaseEmployeeAudit,
  'profit orders init': runProfitOrdersInit,
  'profit orders validate': runProfitOrdersValidate,
  'profit orders import': runProfitOrdersImport,
  'profit orders identity': runProfitOrdersIdentity,
  'profit orders coverage': runProfitOrdersCoverage,
  'profit refunds init': runProfitRefundsInit,
  'profit refunds validate': runProfitRefundsValidate,
  'profit refunds import': runProfitRefundsImport,
  'profit refunds coverage': runProfitRefundsCoverage,
  'profit estimate query': runProfitEstimateQuery,
  'profit estimate export': runProfitEstimateExport,
  'profit owners reconcile': runProfitOwnersReconcile,
  'profit owners import': runProfitOwnersImport,
  'profit owners sync': runProfitOwnersSync,
  'profit costs fetch': runProfitCostsFetch,
  'profit costs reconcile': runProfitCostsReconcile,
  'profit costs sync': runProfitCostsSync,
  'profit components fetch': runProfitComponentsFetch,
  'profit components reconcile': runProfitComponentsReconcile,
  'profit components sync': runProfitComponentsSync,
  'profit weights infer': runProfitWeightsInfer,
  'profit weights stage': runProfitWeightsStage,
  'profit sku-gross-weight init': runSkuGrossInit,
  'profit sku-gross-weight update': runSkuGrossUpdate,
  'profit sku-gross-weight manual-import': runSkuGrossManualImport,
  'profit actual coverage': runProfitActualCoverage,
  'profit actual query': runProfitActualQuery,
  'profit actual audit-cost': runProfitActualAuditCost,
  'profit actual audit-order-cost': runProfitActualAuditOrderCost,
  'profit actual audit-combo-cost': runProfitActualAuditComboCost,
  'profit actual audit-reference-cost': runProfitActualAuditReferenceCost,
  'profit actual audit-freight-fallback': runProfitActualAuditFreightFallback,
  'product images validate': runProductImagesValidate,
  'product images import': runProductImagesImport,
  'yuce categories validate': runYuceCategoriesValidate,
  'yuce categories import': runYuceCategoriesImport,
  'db yuce validate': runYuceCategoryValidate,
  'db yuce init': runYuceCategoryInit,
  'db yuce import': runYuceCategoryImport,
  'db yuce status': runYuceCategoryStatus,
  'db yuce coverage': runYuceCategoryCoverage,
  'db yuce export': runYuceCategoryExport,
  'sycm market-rank': runSycmMarketRank,
  capabilities: runCapabilities,
  doctor: runDoctor,
  'dev pages': runDevPages,
  'dev inspect': runDevInspect,
  'dev capture': runDevCapture,
});

export const ROUTED_COMMAND_KEYS = Object.freeze(Object.keys(COMMAND_HANDLERS));

export function usage() {
  console.log(`Usage:
  tbcli --version
  tbcli version
  tbcli update (--agent codex|agents|openclaw|sealseek | --target-dir DIR) [--json]
  tbcli setup sealseek [--json]
  tbcli maintenance run-start --input PLAN.json [--state-dir DIR] [--json]
  tbcli maintenance run-record --run-id ID --input EVENT.json [--state-dir DIR] [--json]
  tbcli maintenance run-finish --run-id ID --status success|partial|blocked|cancelled [--state-dir DIR] [--json]
  tbcli maintenance run-status [--run-id ID] [--state-dir DIR] [--json]
  tbcli auth login [--timeout-ms 300000] [--profile-dir DIR] [--session-mode auto|managed|cdp] [--json]
  tbcli auth status [--profile-dir DIR] [--session-mode auto|managed|cdp] [--json]
  tbcli browser open [--url URL] [--profile-dir DIR] [--port PORT]
  tbcli logistics get --trade-id ID [--seller-id ID] [--min-delay-ms 1000] [--max-delay-ms 2000] [--json] [--out file.json]
  tbcli shop products --url SHOP_URL [--page N | --max-pages N] [--min-delay-ms 3000] [--max-delay-ms 5000] [--cache-path checkpoint.json] [--out products.xlsx|products.json|products.csv] [--json]
  tbcli document get --url DINGTALK_DOC_URL [--out DIR] [--no-images] [--close-tab] [--timeout-ms 30000] [--json]
  tbcli document tree --url DINGTALK_NODE_URL [--out tree.json] [--max-depth 20] [--min-delay-ms 1000] [--max-delay-ms 2000] [--json]
  tbcli ai-dianjing export --url ALIMAMA_PLAN_URL [--days 7] [--min-delay-ms 1000] [--max-delay-ms 2000] [--out file.json] [--json]
  tbcli ai-dianjing export --campaign-id ID [--days 7] [--out file.json] [--json]
  tbcli sycm reports [--keyword NAME] [--page N] [--page-size 100] [--json]
  tbcli sycm catalog [--data-platform NAME [--data-type NAME [--data-dimension NAME]]] [--date-type TYPE] [--json]
  tbcli sycm export (--report-id ID | --report-name NAME) --out report.xlsx [--timeout-ms 120000] [--min-delay-ms 1000] [--max-delay-ms 2000] [--json]
  tbcli sycm fetch (--report-id ID | --report-name NAME) --start-date YYYY-MM-DD --end-date YYYY-MM-DD --out report.xlsx [--timeout-ms 120000] [--json]
  tbcli sycm fetch --data-platform NAME --data-type NAME --data-dimension NAME [--date-type day|week|month|customDaySum] [--fields all|FIELD,...] [--device all|overall|wireless|pc] [--item-ids ID,...] [--filter NAME=VALUE,...] (--all-history | --start-date YYYY-MM-DD --end-date YYYY-MM-DD) --out report.xlsx [--json]
  tbcli db configure --host HOST --database NAME --ingest-user USER [--pgpass-file FILE] [--port 5432] [--config FILE] [--json]
  tbcli db configure-reader --host HOST --database NAME --reader-user USER [--pgpass-file FILE] [--port 5432] [--config FILE] [--json]
  tbcli db credential-path [--config FILE] [--json]
  tbcli db credential-set --pgpass-file FILE [--config FILE] [--json]
  tbcli db credential-bundle-create --host HOST --database NAME --reader-user USER (--pgpass-file FILE | --password-stdin) --out FILE [--port 5432] [--json]
  tbcli db setup-reader --credential-file FILE [--config FILE] [--json]
  tbcli db network [--provider none|zxvpn] [--ensure] [--config FILE] [--json]
  tbcli db access-check [--config FILE] [--json]
  tbcli db write-check [--config FILE] [--json]
  tbcli db status [--config FILE] [--json]
  tbcli db init [--config FILE] [--json]
  tbcli db coverage --dataset NAME [--start-date YYYY-MM-DD] [--end-date YYYY-MM-DD] [--config FILE] [--json]
  tbcli db import --input FILE_OR_DIR [--dataset NAME] [--mode append|replace-range|replace-all] [--start-date YYYY-MM-DD --end-date YYYY-MM-DD] [--reimport] [--config FILE] [--json]
  tbcli db yuce validate --input CATEGORY.xlsx [--json]
  tbcli db yuce init [--config FILE] [--json]
  tbcli db yuce import --input CATEGORY.xlsx [--mode append|upsert] [--config FILE] [--json]
  tbcli db yuce status [--config FILE] [--json]
  tbcli db yuce coverage --category NAME --start-month YYYY-MM --end-month YYYY-MM [--config FILE] [--json]
  tbcli db yuce export --category NAME --start-month YYYY-MM --end-month YYYY-MM --out NEW.json [--config FILE] [--json]
  tbcli db datasets [--config FILE] [--json]
  tbcli db fields --dataset NAME [--config FILE] [--json]
  tbcli db query --dataset NAME [--metrics FIELD,...] [--start-date YYYY-MM-DD] [--end-date YYYY-MM-DD] [--group-by total|day|shop|item|sku|keyword|related-item|traffic-source|search-term|scene|conversion-cycle|plan|unit|audience|subject|creative] [--item-ids ID,...] [--keyword TEXT] [--order-by FIELD] [--asc] [--limit 100] [--config FILE] [--json]
  tbcli db tables [--schema NAME] [--keyword TEXT] [--config FILE] [--json]
  tbcli db describe --relation schema.table [--config FILE] [--json]
  tbcli db sql (--sql QUERY | --sql-file FILE) [--params-json JSON_ARRAY] [--limit 200] [--timeout-ms 30000] [--config FILE] [--json]
  tbcli db employee-provision --input ADMIN.xlsx --credential-dir DIR [--global-reader-role tb_agent] [--config FILE] [--json]
  tbcli db employee-grant (--account NAME | --department NAME) (--dataset NAME | --table schema.table) [--config FILE] [--json]
  tbcli db employee-revoke (--account NAME | --department NAME) (--dataset NAME | --table schema.table) [--config FILE] [--json]
  tbcli db employee-list [--config FILE] [--json]
  tbcli db employee-audit [--account NAME] [--days 90] [--config FILE] [--json]
  tbcli profit orders init [--config FILE] [--json]
  tbcli profit freight validate --input FILE --carrier sto|yunda|jt|sf --bill-month YYYY-MM [--json]
  tbcli profit freight import --input FILE --carrier sto|yunda|jt|sf --bill-month YYYY-MM [--config FILE] [--json]
  tbcli profit freight query [--tracking-no NUMBER] [--config FILE] [--json]
  tbcli profit orders validate --input FILE --shop-key KEY --shop-name NAME [--json]
  tbcli profit orders import --input FILE --shop-key KEY --shop-name NAME [--config FILE] [--json]
  tbcli profit orders identity [--config FILE] [--json]
  tbcli profit orders coverage --shop-key KEY --start-date YYYY-MM-DD --end-date YYYY-MM-DD [--config FILE] [--json]
  tbcli profit refunds init [--config FILE] [--json]
  tbcli profit refunds validate --input FILE --shop-key KEY --shop-name NAME [--json]
  tbcli profit refunds import --input FILE --shop-key KEY --shop-name NAME [--config FILE] [--json]
  tbcli profit refunds coverage --shop-key KEY --start-date YYYY-MM-DD --end-date YYYY-MM-DD [--config FILE] [--json]
  tbcli profit estimate query --shop-key KEY --start-date YYYY-MM-DD --end-date YYYY-MM-DD [--owner NAME | --owners NAME,...] [--group-by shop|owner|product|day|month|owner-month] [--json]
  tbcli profit estimate export --shop-key KEY --start-date YYYY-MM-DD --end-date YYYY-MM-DD [--owner NAME | --owners NAME,...] --out FILE [--json]
  tbcli profit owners reconcile --input FILE.json --shop-key KEY --effective-from YYYY-MM-DD --source-revision TEXT [--config FILE] [--json]
  tbcli profit owners import --input FILE.json --shop-key KEY --effective-from YYYY-MM-DD --source-revision TEXT [--config FILE] [--json]
  tbcli profit owners sync --input FILE.json --shop-key KEY --effective-from YYYY-MM-DD --source-revision TEXT [--config FILE] [--json]
  tbcli profit costs fetch --out NEW_WDT_COSTS.json [--json]
  tbcli profit costs reconcile --input WDT_COSTS.json --shop-key KEY --effective-from YYYY-MM-DD [--config FILE] [--json]
  tbcli profit costs sync --input WDT_COSTS.json --shop-key KEY --effective-from YYYY-MM-DD [--config FILE] [--json]
  tbcli profit components fetch --shop-key KEY --shop-id ID --replace-batch-id UUID --out NEW_SNAPSHOT.json [--json]
  tbcli profit components reconcile --input SNAPSHOT.json --shop-key KEY --effective-from YYYY-MM-DD --replace-batch-id UUID [--out NEW_REPORT.json] [--json]
  tbcli profit components sync --input SNAPSHOT.json --shop-key KEY --effective-from YYYY-MM-DD --replace-batch-id UUID --expected-old-count N --backup-out NEW_BACKUP.json --yes [--json]
  tbcli profit weights infer --shop-key KEY --months YYYY-MM,YYYY-MM --out NEW_REPORT.json [--audit-sku ERP_SPEC_NO] [--config FILE] [--json]
  tbcli profit weights stage --input REPORT.json --shop-key KEY --effective-from YYYY-MM-DD [--config FILE] [--json]
  tbcli profit sku-gross-weight init --input BILL.xlsx|DIR --shop-key KEY [--year YYYY] [--carrier sto|yunda|jt|sf --bill-month YYYY-MM] [--config FILE] [--json]
  tbcli profit sku-gross-weight update --input BILL.xlsx|DIR --shop-key KEY [--year YYYY] [--carrier sto|yunda|jt|sf --bill-month YYYY-MM] [--config FILE] [--json]
  tbcli profit sku-gross-weight manual-import --input WEIGHTS.json --shop-key KEY [--config FILE] [--json]
  tbcli profit actual coverage --shop-key KEY --month YYYY-MM [--policy-version VERSION] [--config FILE] [--json]
  tbcli profit actual query --shop-key KEY --month YYYY-MM [--policy-version VERSION] [--return-resale-rate 0..1] [--group-by shop|owner|product|day|report] [--owner NAME | --owners NAME,...] [--config FILE] [--json]
  tbcli profit actual audit-cost --shop-key KEY --month YYYY-MM --product-id ID [--config FILE] [--json]
  tbcli profit actual audit-order-cost --shop-key KEY --month YYYY-MM [--order-nos NO,... | --sample-size N] [--config FILE] [--json]
  tbcli profit actual audit-combo-cost --shop-key KEY --month YYYY-MM [--product-id ID] [--platform-sku-id ID] [--config FILE] [--json]
  tbcli profit actual audit-reference-cost --shop-key KEY --month YYYY-MM [--config FILE] [--json]
  tbcli profit actual audit-freight-fallback --shop-key KEY --month YYYY-MM [--order-nos NO,...] [--limit 30] [--config FILE] [--json]
  tbcli product images validate --input FILE --shop-key KEY --shop-name NAME [--json]
  tbcli product images import --input FILE --shop-key KEY --shop-name NAME [--config FILE] [--json]
  tbcli yuce categories validate --input YC_EXPORT.json [--json]
  tbcli yuce categories import --input YC_EXPORT.json [--config FILE] [--json]
  tbcli sycm market-rank --category-url URL --last-week YYYY-MM-DD [--out-dir DIR] [--json]
  tbcli skill source [--skill tbcli|ecommerce-monthly-profit-report] [--json]
  tbcli skill status [--skill tbcli|ecommerce-monthly-profit-report] (--agent codex|agents|openclaw|sealseek | --target-dir DIR)
  tbcli skill install [--skill tbcli|ecommerce-monthly-profit-report] (--agent codex|agents|openclaw|sealseek | --target-dir DIR) [--mode auto|link|copy]
  tbcli skill update [--skill tbcli|ecommerce-monthly-profit-report] (--agent codex|agents|openclaw|sealseek | --target-dir DIR)
  tbcli capabilities [--json] [--all]
  tbcli doctor [--agent sealseek] [--fix] [--json]
  tbcli dev pages [--json]
  tbcli dev inspect [--url SHOP_URL]
  tbcli dev capture [--url SHOP_URL] [--duration-ms 15000]

Environment:
  TBCLI_SESSION_MODE   Browser session mode, default ${DEFAULT_SESSION_MODE} (auto reuses an existing CDP browser, otherwise managed)
  TBCLI_CDP_URL   Chrome DevTools URL, default ${DEFAULT_CDP}
  TBCLI_CHROME_PROFILE   Chrome profile dir, default ${DEFAULT_PROFILE_DIR}
  TBCLI_REMOTE_DEBUGGING_PORT   Chrome remote debugging port, default ${DEFAULT_DEBUGGING_PORT}
  TBCLI_CHROME_PATH   Chrome binary path, default ${DEFAULT_CHROME_PATH}
  TBCLI_DB_CONFIG   Ecommerce warehouse connection config; passwords stay in its pgpass file
  TBCLI_DB_NETWORK_PROVIDER   Optional database network adapter override: none or zxvpn
  TBCLI_ZXVPN_BIN   Optional zxvpn executable override; default resolves zxvpn from PATH
  TBCLI_UPDATE_CHECK   Set to 0 to disable automatic npm update checks

Notes:
  - 不知道 tbcli 能做什么？可直接问 Agent：“这个 tbcli 有哪些能力？”
  - Agent 应先运行 tbcli capabilities --json，按能力清单调用稳定命令。
  - First use: run tbcli auth login and complete login in the opened Chrome.
  - Normal commands use the persistent profile at ~/.dianshang-chrome-profile without requiring port 9223.
  - Auto mode can reuse an already running legacy CDP browser; browser open remains a compatibility/debugging command.
  - tbcli never exports cookies or tokens; authentication stays in the dedicated Chrome profile.
`);
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const automaticUpdate = await maybeAutoUpdate(args);
  if (automaticUpdate.warning) console.error(`warning: tbcli 自动更新失败，继续使用当前版本：${automaticUpdate.warning}`);
  if (automaticUpdate.updated) {
    for (const skill of automaticUpdate.update.skills || []) {
      if (skill.warning) console.error(`warning: ${skill.agent}/${skill.skill} Skill 自动刷新失败：${skill.warning}`);
    }
    console.error(`tbcli 已自动更新到 ${automaticUpdate.update.cli.afterVersion}，正在重新执行当前命令。`);
    try {
      const relaunched = await relaunchWithUpdatedCli(argv);
      process.exitCode = relaunched.code;
      return;
    } catch (error) {
      console.error(`warning: 无法用新版本重新执行，当前进程继续运行原命令：${error.message}`);
    }
  }
  if (args.version) {
    runVersion();
    return;
  }
  if (args.help || args._.length === 0) {
    usage();
    return;
  }

  const candidateKeys = [3, 2, 1]
    .filter((length) => args._.length >= length)
    .map((length) => args._.slice(0, length).join(' '));
  const commandKey = candidateKeys.find((key) => COMMAND_HANDLERS[key]);
  const definition = commandKey && findCommandDefinition(...commandKey.split(' '));
  const handler = definition && COMMAND_HANDLERS[definition.key];
  if (handler) {
    await handler(args);
    return;
  }

  console.error(`未找到命令：${args._.join(' ')}。可先运行 tbcli capabilities；需要发现新接口时使用 tbcli dev inspect/capture。`);
  usage();
  process.exitCode = 2;
}
