export function parseArgs(argv) {
  const out = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') out.json = true;
    else if (arg === '--out') out.out = argv[++index];
    else if (arg === '--cdp-url') out.cdpUrl = argv[++index];
    else if (arg === '--profile-dir') out.profileDir = argv[++index];
    else if (arg === '--chrome-path') out.chromePath = argv[++index];
    else if (arg === '--port') out.port = argv[++index];
    else if (arg === '--url') out.url = argv[++index];
    else if (arg === '--trade-id') out.tradeId = argv[++index];
    else if (arg === '--tid') out.tid = argv[++index];
    else if (arg === '--seller-id') out.sellerId = argv[++index];
    else if (arg === '--shop-id') out.shopId = argv[++index];
    else if (arg === '--max-pages') out.maxPages = argv[++index];
    else if (arg === '--page-size') out.pageSize = argv[++index];
    else if (arg === '--delay-ms') out.delayMs = argv[++index];
    else if (arg === '--keep-page') out.keepPage = true;
    else if (arg === '-h' || arg === '--help') out.help = true;
    else out._.push(arg);
  }
  return out;
}
