# tbcli

Local CLI for Taobao/Qianniu seller backend workflows. It shares the same
“ecommerce browser”（电商浏览器）with the other ecommerce CLIs.

## Install

Supports macOS and Windows. Requires Node.js 20 or newer and Google Chrome:

```bash
npm install -g @petercjl/tbcli
tbcli --help
```

List stable commands and development tools:

```bash
tbcli capabilities
tbcli doctor
```

The companion Agent Skill is bundled with the CLI and is the natural-language
usage contract for all stable commands. Discover or install the canonical Skill:

```bash
tbcli skill source --json
tbcli skill status --agent codex
tbcli skill install --agent codex
tbcli skill install --agent agents
```

Use `--target-dir <agent-skill-root>` for another host. On platforms that
support directory links, linked installations read the bundled source directly;
managed copies can be refreshed with `tbcli skill update`.

Reuse an existing SYCM (生意参谋) data-fetch report instead of rebuilding the
same report in the web UI each time:

```bash
tbcli sycm reports --keyword '店铺-整体' --json
tbcli sycm export \
  --report-name '店铺-整体-全周期' \
  --out ./店铺-整体-全周期.xlsx
tbcli sycm fetch \
  --report-name '店铺-整体-全周期' \
  --start-date 2025-10-10 \
  --end-date 2026-07-10 \
  --out ./店铺-整体-指定日期.xlsx

# Discover live dimensions and fields, then fetch without a saved mother report.
tbcli sycm catalog --data-platform '生意参谋' --data-type '商品'
tbcli sycm catalog \
  --data-platform '无界' --data-type '基础报表' --data-dimension '账户'
tbcli sycm fetch \
  --data-platform '生意参谋' --data-type '店铺' --data-dimension '整体' \
  --fields '访客数,支付金额' \
  --start-date 2026-08-01 --end-date 2026-08-18 \
  --out ./店铺-整体-指定字段.xlsx
```

`sycm reports` locates saved reports and returns their IDs, dimensions, date
ranges, and indicator counts. `sycm export` accepts either `--report-name` or
`--report-id`, asks SYCM to generate the complete workbook, waits for completion,
and downloads the official Excel result. The output path must be new; tbcli
refuses to overwrite an existing file. The command reuses the report definition
already stored in Analysis Space and does not create, edit, or delete reports.
`sycm fetch` additionally accepts a new date range. It copies the selected
mother report's dimensions, indicators, filters, and shop scope into a uniquely
named temporary report through the official page workflow, downloads the full
workbook, verifies the file, and deletes only that verified `tbcli-temp-*`
report. It validates the requested dates against SYCM's current allowed range
before creating anything and never changes the mother report. `sycm catalog`
reads the live platform/type/dimension/field metadata available to the logged-in
account. In direct mode, `sycm fetch` does not require a saved mother report:
it accepts `--data-platform`, `--data-type`, and `--data-dimension`, resolves
`--fields` by exact Chinese name or field code (`all` by default), and supports
repeatable `--filter '筛选项=值1,值2'` arguments. Fields remain scoped to their own
dimension and cannot be mixed across report types. When selecting metrics,
tbcli automatically keeps the dimension identity columns (for example item/SKU,
scene, or conversion-cycle fields) so repeated rows remain interpretable.
The full-dimension `sycm catalog --json` result also includes the selected time
granularity and live `validPeriod`, allowing multi-report tasks to validate every
requested period before any workbook is created.

Read a DingTalk online document through the authorized ecommerce-browser
session and export its structured content without turning Wiki compilation into
a CLI concern:

```bash
tbcli document get \
  --url 'https://alidocs.dingtalk.com/i/nodes/...' \
  --out ./dingtalk-document \
  --close-tab
```

List every document and subdirectory below a DingTalk knowledge-base node:

```bash
tbcli document tree \
  --url 'https://alidocs.dingtalk.com/i/nodes/...' \
  --out ./dingtalk-document-tree.json
```

The command writes `content.md`, `content.txt`, `tables.json`,
`document-package.json`, `metadata.json`, `images.json`, `manifest.json`, and an
`images/` directory. It refuses to overwrite an existing output directory. Use
`--close-tab` in batch jobs to close the source page after each terminal result,
including unsupported-document or access errors. It
does not save cookies, access tokens, authorization headers, or browser-profile
data. Dynamic-page access belongs to tbcli; deciding how the exported material
is compiled into a knowledge base belongs to the knowledge-base workflow.

`tbcli capabilities` is the business-facing catalogue. It tells ecommerce
operators what they can ask an Agent to do, what information to provide, and
what result will be delivered. Agents should use the structured form:

```bash
tbcli capabilities --json
```

For example, a user can say: `帮我获取【店铺首页链接】的商品列表`.
Use `tbcli capabilities --all` only when internal browser and development tools
also need to be shown.

## Authentication and browser session

On first use, start the interactive login flow:

```bash
tbcli auth login
```

`tbcli` opens Chrome with its fixed persistent profile and waits until the user
has completed Taobao/Tmall login. Check it at any time with:

```bash
tbcli auth status --json
```

Default browser settings:

- Chrome profile: `~/.dianshang-chrome-profile` on macOS, `%USERPROFILE%\.dianshang-chrome-profile` on Windows
- macOS Chrome: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`
- Windows Chrome: automatically detected under `%LOCALAPPDATA%`, `%PROGRAMFILES%`, or `%PROGRAMFILES(X86)%`
- Session mode: `auto`; reuse an existing legacy CDP browser when available,
  otherwise launch a managed persistent browser without opening TCP port `9223`
- Chrome security sandbox: explicitly enabled; tbcli never falls back to
  `--no-sandbox`

These can be overridden with `TBCLI_SESSION_MODE`, `TBCLI_CDP_URL`,
`TBCLI_CHROME_PROFILE`, `TBCLI_REMOTE_DEBUGGING_PORT`, or `TBCLI_CHROME_PATH`.

Normal data commands start and close their own managed browser session while
reusing the same profile. Port `9223` is no longer a requirement. The legacy
`tbcli browser open` command remains available for compatibility and debugging.
If another ordinary Chrome already owns the fixed profile without a debuggable
connection, close that Chrome first so tbcli can safely open the profile.

The CLI checks only whether the required login-cookie names exist. It never
prints, exports, or maintains a separate cookie/token file; authentication stays
inside the dedicated Chrome profile. npm installs `playwright-core`
automatically; Chrome and Node.js remain system prerequisites.

If Chrome displays an unsupported `--no-sandbox` command-line warning, upgrade
tbcli to the latest version, close the Chrome using the fixed Profile, and run
`tbcli auth login` again. Do not continue entering credentials or repeatedly
attempt the slider in that unsafe browser session.

## Verification safety rule

If Taobao shows or is suspected to show a login redirect, slider, CAPTCHA,
security verification, access restriction, or MTOP validation signal, `tbcli`
must stop immediately. It must not retry, refresh, or continue requesting more
pages. Run `tbcli auth login`, complete the verification manually, then run the
data command again. This rule applies to every Taobao data command.

## Commands

Query logistics detail by Taobao trade ID:

```bash
tbcli logistics get --trade-id 5120566455115013148 --seller-id 2208971708239
```

JSON output:

```bash
tbcli logistics get --trade-id 5120566455115013148 --seller-id 2208971708239 --json
```

Save normalized JSON:

```bash
tbcli logistics get --trade-id 5120566455115013148 --seller-id 2208971708239 --out outputs/logistics.json
```

If a current Chrome page URL already contains `seller_id`, `--seller-id` may be omitted.

Export a Tmall/Taobao shop product list through the shop page's own product-list
request:

```bash
tbcli shop products --url 'https://kemi.tmall.com/category.htm?visible=true&show=true' --out products.json
tbcli shop products --url 'https://kemi.tmall.com/category.htm?visible=true&show=true' --out products.csv
tbcli shop products --url 'https://kemi.tmall.com/category.htm?visible=true&show=true' --out products.xlsx
tbcli shop products --url 'https://kemi.tmall.com/category.htm?visible=true&show=true' --page 2 --out page-2.xlsx
```

The product command loads page 1 through the supplied shop URL and reaches every
later page by clicking the shop's real pagination control. Before each navigation
or click it starts observing the page's own `asynSearch.htm` request, then
performs a random 3000-5000ms guarded page-action wait while the page renders
that response. Each shop page contributes every main-list product before the
pagination boundary; the observed page capacity may vary with the shop layout
(for example 60 or 70), and recommendation products after that boundary are
excluded. It does not
directly call a substitute product API, jump to later page URLs, or automatically
retry a failed page. Override the range with `--min-delay-ms` and
`--max-delay-ms`, or use the legacy `--delay-ms` option for a fixed delay.
Other Taobao data commands keep the shared 1000-2000ms request delay.

After every successful product page, tbcli atomically writes a checkpoint next
to the requested output, for example `products.xlsx.checkpoint.json`. If login,
verification, access restriction, or another error stops the command, the
checkpoint retains all successfully fetched pages and its path is printed.
Use `--cache-path checkpoint.json` to choose another location.
For Excel delivery, tbcli first uses the plaintext list price embedded in the
requested shop response. When a page exposes only encoded display text, it falls
back to the pinned official secfont runtime. Both official static resources are
restricted to fixed HTTPS URLs and verified against pinned SHA-256 fingerprints
before execution. This does not send another shop-product request. Older
unsupported price formats may fall back only to the same shop-list pages already
requested.
tbcli never opens individual item detail pages to fill prices; if a complete,
high-confidence result is impossible, it stops with partial data preserved in
the checkpoint.

Use `--max-pages N` for a small test run. When the output filename ends in
`.xlsx`, tbcli automatically restores the shop-list display price and creates
an Excel workbook with `概览`, `商品列表`, and `SKU明细` sheets. The command exports product IDs,
titles, links, images, 365-day vague sales, benefits, rankings, and the SKU
thumbnail data exposed by the shop list. JSON, CSV, and Excel use the restored
list price when available. The ecommerce browser page opened by this command is
intentionally left open after success or a guarded stop for user inspection.
Use `--page N` when only one specified page should be delivered; tbcli first
loads page 1 normally, then reaches the requested page through the real
pagination control.

## Development tools

Development tools reuse the same Chrome process, profile, login state, and CDP
connection as stable commands:

```bash
tbcli dev pages
tbcli dev inspect --url 'https://example.tmall.com/category.htm'
tbcli dev capture --url 'https://example.tmall.com/category.htm' --duration-ms 15000
```

Capture output is restricted to Taobao/Tmall request metadata. Sensitive query
parameters are redacted, response bodies and cookies are not exported, and any
verification signal stops capture immediately.
