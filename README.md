# tbcli

Local CLI for Taobao/Qianniu seller backend workflows. It shares the same
“ecommerce browser”（电商浏览器）with the other ecommerce CLIs.

## Install

### 日常取数维护（插件内置 Skill 模块）

Agent 可接收“帮我补全取数报表近期缺失数据”“只增补商品-整体”或
“只检查缺失日期，暂不下载入库”。安装/更新同一个 tbcli 伴生 Skill 即可使用，
不是某个 Agent 私有安装的另一份 Skill。

唯一清单为 `skill/tbcli/references/report-maintenance.md`，其中“日常启用”列控制
默认范围；19 张已确认报表沿用原口径，商品-连带仍按完整周维护。
执行手册在 `skill/tbcli/references/daily-update.md`，只补缺，不自动回刷、全量重建或升级。

`maintenance run-start/run-record/run-finish/run-status` 是本地运行记录和互斥元命令，
不下载、不入库、不决定表或日期。计划/事件格式见伴生 Skill 的
`references/maintenance-run-contract.md`。状态默认位于用户稳定状态目录，
与 npm、Skill、Git 分离，实际路径由 `tbcli maintenance run-status --json` 返回。
手动/定时任务必须共用同一目录，只支持单维护机器；首次上线需要真实数据验收。
每日调度和通知需用户另外授权配置，插件安装本身不创建定时任务。

### CLI installation

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

Windows SealSeek already includes a managed Node.js. It does not need a separate
Node installation, manual PATH editing, or a PowerShell ExecutionPolicy change.
After the initial npm bootstrap, run `tbcli setup sealseek --json`; this reads
SealSeek's own runtime metadata, backs up and merges its execution-path config,
installs the companion Skill, and provides a restart instruction. The complete
PATH-independent bootstrap is documented in the bundled Skill reference
`references/windows-sealseek.md`.

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

For later upgrades, use the unified updater instead of running npm and Skill
updates separately:

```bash
tbcli update --agent sealseek --json
```

Replace `sealseek` with `codex`, `agents`, or `openclaw` for the current host.
The command upgrades the global npm package, installs or refreshes the bundled
Skill for that Agent, and verifies the final CLI version and Skill state. Normal
tbcli commands check npm at most once every six hours and print a throttled
notice when a newer version exists; the reminder never blocks business work.
On Windows SealSeek, use `tbcli.cmd update --agent sealseek --json`; it installs
into the canonical directory reported by SealSeek and verifies that exact entry.

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

# Fetch the complete current Wujie account history with the maintained 15-day conversion window.
tbcli sycm fetch \
  --data-platform '无界' --data-type '基础报表' --data-dimension '账户' \
  --date-type day --fields all --filter '转化周期=15天转化' --all-history \
  --out ./无界-账户-分日-15天转化.xlsx --json

# The same maintained contract applies to Wujie plan, audience, product subject,
# creative, unit, and keyword dimensions. Large keyword history is date-chunked.
tbcli sycm fetch \
  --data-platform '无界' --data-type '基础报表' --data-dimension '计划' \
  --date-type day --fields all --filter '转化周期=15天转化' --all-history \
  --out ./无界-计划-分日-15天转化.xlsx --json

# Fetch selected products over the complete currently available daily history.
tbcli sycm fetch \
  --data-platform '生意参谋' --data-type '商品' --data-dimension '整体' \
  --date-type day --fields all --device all \
  --item-ids '631249289145,635607974988,650978994929' --all-history \
  --out ./商品-整体-指定商品-全部历史.xlsx --json
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
repeatable `--filter '筛选项=值1,值2'` arguments. Direct 商品 mode also accepts up
to 100 numeric IDs through `--item-ids`; `--device` selects all, overall,
wireless, or PC field groups. `--all-history` resolves and uses the live complete
valid period instead of requiring explicit dates. Fields remain scoped to their own
dimension and cannot be mixed across report types. When selecting metrics,
tbcli automatically keeps the dimension identity columns (for example item/SKU,
scene, or conversion-cycle fields) so repeated rows remain interpretable.
The full-dimension `sycm catalog --json` result also includes the selected time
granularity and live `validPeriod`, allowing multi-report tasks to validate every
requested period before any workbook is created.

## Company ecommerce warehouse

`tbcli` can import its canonical full-history Excel exports into PostgreSQL and
answer parameterized business questions without exposing SQL to employees. The
warehouse connection is configured by an administrator; day-to-day Agents use a
read-only role.

```bash
# Discover available tables and exact fields.
tbcli db status --json
tbcli db datasets --json
tbcli db fields --dataset '商品-整体' --json
tbcli db coverage --dataset '商品-整体' \
  --start-date 2026-01-01 --end-date 2026-08-24 --json

# Example: top five products by payment amount in an explicit period.
tbcli db query \
  --dataset '商品-整体' \
  --metrics '支付金额,商品访客数,支付件数' \
  --start-date 2026-07-21 --end-date 2026-08-19 \
  --group-by item --order-by '支付金额' --limit 5 --json

# Example: compare Wujie account spend by advertising scene.
tbcli db query \
  --dataset '无界-账户' --metrics '展现量,点击量,花费,总成交金额' \
  --group-by scene --order-by '花费' --limit 20 --json

# Example: compare Wujie plan spend by plan identity.
tbcli db query \
  --dataset '无界-计划' --metrics '展现量,点击量,花费,总成交金额' \
  --group-by plan --order-by '花费' --limit 50 --json
```

Agents must resolve natural-language dates against `db datasets` coverage and
must discover exact metric names with `db fields`. Query filters and grouping are
limited to the stable semantic options shown by `tbcli --help`; there is no raw
SQL command. Additive metrics use `sum`. Rate, ROI, CTR, CPC, average, unit-price,
and cost-like fields currently use a descriptive `avg`, which must not be
presented as an exact recomputed cross-period ratio.

For an authorized data maintainer, configure connection metadata and then import
a file or directory. Passwords are not stored in the JSON config; they remain in
a protected PostgreSQL password file (mode `600` on macOS/Linux). The default
credential path is `~/.config/tbcli/pgpass` (under the Windows user profile as
well). This stable user configuration path is outside npm and Skill installation
directories, so package upgrades do not replace it.

```bash
tbcli db configure \
  --host '<LAN database host>' --database '<database>' \
  --ingest-user '<maintainer role>'
tbcli db init --json
tbcli db write-check --json
tbcli db import --input '<tbcli workbook.xlsx>' --dataset '商品-整体' \
  --mode replace-range --start-date 2026-08-20 --end-date 2026-08-24 --json
```

For an employee who only queries the warehouse, the administrator creates one
encrypted reader credential bundle and distributes that file through the
company's approved internal document. The bundle contains only the read-only
role; it never contains the maintainer credential and is never bundled into npm,
Git, or the companion Skill.

```bash
tbcli db setup-reader --credential-file '<downloaded company reader credential.tbcred>' --json
tbcli db access-check --json
```

`setup-reader` first validates an existing local read-only configuration. If it
works, the command returns `action: unchanged` and does not replace anything. If
it is absent or broken, the command decrypts the approved bundle, stores a local
pgpass file in the stable current-user configuration directory, writes a
read-only configuration, and verifies the database privileges. Existing broken
read-only files are backed up; a maintainer configuration is never replaced.

The `.tbcred` file prevents casual plaintext disclosure, but it is not a second
access-control boundary: the LAN restriction and database reader permissions
remain authoritative.

An administrator creates the distributable file from an existing protected
pgpass file with an exact read-only tuple:

```bash
tbcli db credential-bundle-create \
  --host '<LAN database host>' --database '<database>' \
  --reader-user '<read-only role>' --pgpass-file '<protected pgpass path>' \
  --out '<new reader credential.tbcred>' --json
```

The creator requires exactly one matching reader record, refuses to overwrite
an existing output, and never includes another pgpass record.

To inspect the recommended location or repair an older configuration that used
an unsafe package path, first have the administrator privately provision a new
protected pgpass file at the recommended path (or another stable user-owned
path), then update only the reference:

```bash
tbcli db credential-path --json
tbcli db credential-set --pgpass-file '<stable protected pgpass path>' --json
tbcli db access-check --json
```

`credential-set` validates the new file, rejects package-managed paths, backs up
the existing metadata configuration, and never reads or prints the password.

The resulting employee configuration is read-only. `db init` and
`db import` reject that configuration before attempting a write. `access-check`
confirms that the configured query account can connect but has no database,
schema, or table write privileges.

For an authorized maintainer, `tbcli db write-check --json` verifies the
configured `ingestUser` against the tables and sequence used by imports. It
performs representative insert, update, and delete operations inside one
transaction, always rolls that transaction back, and then confirms that no
probe rows remain. It refuses a read-only configuration and never prints the
database password.

A maintainer configuration uses this single `ingestUser` identity for queries,
coverage checks, status checks, and imports. It does not depend on the employee
read-only role. Older maintainer configs that still contain `readerUser` remain
compatible, but that value is ignored for maintainer database connections.

`db coverage` mechanically reports covered and missing dates inside the explicit
caller-supplied interval. The companion Skill, not the CLI, decides which tables
and periods to maintain. Imports are source-hash idempotent. `append` refuses
date overlap, `replace-range` atomically replaces one declared period, and
`replace-all` atomically rebuilds one dataset. A single incremental workbook can
be identified with `--dataset`; required headers and declared date bounds are
still validated. `TBCLI_DB_CONFIG` can select a non-default metadata config on
another machine.

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

For npm installations that already provide the unified updater, upgrade and
verify both the CLI and Skill with:

```bash
tbcli update --agent sealseek --json
```

The result must show the new CLI version and `skill.current: true` before
starting `tbcli auth login`. If an old release does not yet recognize `tbcli
update`, bootstrap once with `npm install -g @petercjl/tbcli@latest`, then use
the unified command for all later updates. Source-checkout developers should
update through their repository workflow instead of replacing that checkout
with a global npm package.

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
