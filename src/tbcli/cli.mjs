import { parseArgs } from './args.mjs';
import { DEFAULT_CDP, DEFAULT_CHROME_PATH, DEFAULT_DEBUGGING_PORT, DEFAULT_PROFILE_DIR } from './config.mjs';
import { runBrowserOpen } from './commands/browser.mjs';
import { runLogisticsGet } from './commands/logistics.mjs';
import { runShopProducts } from './commands/shop-products.mjs';
import { runCapabilities, runDoctor } from './commands/system.mjs';
import { runDevCapture, runDevInspect, runDevPages } from './commands/dev.mjs';

export function usage() {
  console.log(`Usage:
  tbcli browser open [--url URL] [--profile-dir DIR] [--port PORT]
  tbcli logistics get --trade-id ID [--seller-id ID] [--json] [--out file.json]
  tbcli shop products --url SHOP_URL [--max-pages N] [--min-delay-ms 1000] [--max-delay-ms 2000] [--out products.xlsx|products.json|products.csv] [--json]
  tbcli capabilities [--json]
  tbcli doctor [--json]
  tbcli dev pages [--json]
  tbcli dev inspect [--url SHOP_URL]
  tbcli dev capture [--url SHOP_URL] [--duration-ms 15000]

Environment:
  TBCLI_CDP_URL   Chrome DevTools URL, default ${DEFAULT_CDP}
  TBCLI_CHROME_PROFILE   Chrome profile dir, default ${DEFAULT_PROFILE_DIR}
  TBCLI_REMOTE_DEBUGGING_PORT   Chrome remote debugging port, default ${DEFAULT_DEBUGGING_PORT}
  TBCLI_CHROME_PATH   Chrome binary path, default ${DEFAULT_CHROME_PATH}

Notes:
  - tbcli browser open starts the shared ecommerce browser (电商浏览器).
  - The ecommerce browser always defaults to CDP :9223 and ~/.dianshang-chrome-profile.
  - Requires that the ecommerce browser is already logged in to Taobao/Qianniu seller backend.
  - Does not read or store cookies; requests run inside the logged-in browser page context.
`);
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help || args._.length === 0) {
    usage();
    return;
  }

  const [group, command] = args._;
  if (group === 'browser' && command === 'open') {
    await runBrowserOpen(args);
    return;
  }

  if (group === 'logistics' && command === 'get') {
    await runLogisticsGet(args);
    return;
  }

  if (group === 'shop' && command === 'products') {
    await runShopProducts(args);
    return;
  }

  if (group === 'capabilities') {
    runCapabilities(args);
    return;
  }

  if (group === 'doctor') {
    await runDoctor(args);
    return;
  }

  if (group === 'dev' && command === 'pages') {
    await runDevPages(args);
    return;
  }

  if (group === 'dev' && command === 'inspect') {
    await runDevInspect(args);
    return;
  }

  if (group === 'dev' && command === 'capture') {
    await runDevCapture(args);
    return;
  }

  console.error(`未找到命令：${args._.join(' ')}。可先运行 tbcli capabilities；需要发现新接口时使用 tbcli dev inspect/capture。`);
  usage();
  process.exitCode = 2;
}
