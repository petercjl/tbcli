import { parseArgs } from './args.mjs';
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
import { runDevCapture, runDevInspect, runDevPages } from './commands/dev.mjs';
import { runDocumentGet } from './commands/document.mjs';
import { runDocumentTree } from './commands/document-tree.mjs';
import { runAiDianjingExport } from './commands/ai-dianjing.mjs';
import { runSycmCatalog, runSycmExport, runSycmFetch, runSycmReports } from './commands/sycm-reports.mjs';
import { runSkillInstall, runSkillSource, runSkillStatus, runSkillUpdate } from './commands/skill.mjs';
import { findCommandDefinition } from './command-registry.mjs';
import { runVersion } from './version.mjs';

const COMMAND_HANDLERS = Object.freeze({
  version: runVersion,
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
  tbcli skill source [--json]
  tbcli skill status (--agent codex|agents|openclaw|sealseek | --target-dir DIR)
  tbcli skill install (--agent codex|agents|openclaw|sealseek | --target-dir DIR) [--mode auto|link|copy]
  tbcli skill update (--agent codex|agents|openclaw|sealseek | --target-dir DIR)
  tbcli capabilities [--json] [--all]
  tbcli doctor [--json]
  tbcli dev pages [--json]
  tbcli dev inspect [--url SHOP_URL]
  tbcli dev capture [--url SHOP_URL] [--duration-ms 15000]

Environment:
  TBCLI_SESSION_MODE   Browser session mode, default ${DEFAULT_SESSION_MODE} (auto reuses an existing CDP browser, otherwise managed)
  TBCLI_CDP_URL   Chrome DevTools URL, default ${DEFAULT_CDP}
  TBCLI_CHROME_PROFILE   Chrome profile dir, default ${DEFAULT_PROFILE_DIR}
  TBCLI_REMOTE_DEBUGGING_PORT   Chrome remote debugging port, default ${DEFAULT_DEBUGGING_PORT}
  TBCLI_CHROME_PATH   Chrome binary path, default ${DEFAULT_CHROME_PATH}

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
  if (args.version) {
    runVersion();
    return;
  }
  if (args.help || args._.length === 0) {
    usage();
    return;
  }

  const [group, command] = args._;
  const definition = findCommandDefinition(group, command);
  const handler = definition && COMMAND_HANDLERS[definition.key];
  if (handler) {
    await handler(args);
    return;
  }

  console.error(`未找到命令：${args._.join(' ')}。可先运行 tbcli capabilities；需要发现新接口时使用 tbcli dev inspect/capture。`);
  usage();
  process.exitCode = 2;
}
