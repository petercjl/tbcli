---
name: tbcli
description: Operate the stable tbcli CLI for Taobao, Tmall, Qianniu, 生意参谋自主分析/取数报表, 无界基础报表, 旺店通订单与退款事实, ecommerce profit estimates, and the company ecommerce warehouse. Use when the user says tbcli, 获取/导出取数报表, 补全取数报表近期缺失数据, 日常更新, 每日补数, 检查缺失日期, 断点续跑, 增量入库, 全量重拉, 旺店通订单/订单明细/运单/退款, 预估利润, 最近7天利润, 最近30天利润, 7月份利润, 三位运营利润, 某负责人过去N天利润, 利润Excel, 检查数据库读写权限, 店铺-整体, 商品-整体, 商品-流量来源, 商品-流量来源详情, 商品-整体退款分布, 商品-退款原因分布, 商品-流失竞店分布, 商品-退款SKU分布, 无界-账户/计划/人群/商品主体/创意/单元/关键词, 转化周期, SKU, 所有历史数据, 公司数据库, 数据仓库, 数据集, 商品排行, 关键词排行, or asks a natural-language business question over imported ecommerce data. Translate business language into stable CLI commands and verified files or semantic query results; employees never need to write SQL. Do not load for browser-only launch or status requests; use the independent browser launcher.
---

# tbcli

Use `tbcli` as the deterministic execution surface for supported ecommerce-browser work. Translate business language into commands, preflight the whole request, run the smallest stable command, and verify the delivered artifact.

Browser-only launch/status requests belong to the independently configured browser
launcher, not this business Skill. The legacy `tbcli browser open` command remains
available for explicit compatibility use; it is not a dependency of other CLIs.

## Source Of Truth

This Skill is distributed with the `tbcli` CLI. Treat the path returned by `tbcli skill source --json` as the only editable source. Agent Skill directories contain CLI-managed links or copies; never maintain an independent fork.

Discover or install it with:

```bash
tbcli skill source --json
tbcli skill status --agent codex
tbcli skill install --agent codex
```

Use `--agent agents`, `openclaw`, or `sealseek`, or `--target-dir <agent-skill-root>`. Linked installs update immediately; use `tbcli skill update` only for a managed copy. Refresh the host Skill catalog if it snapshots metadata.

When the host is Windows SealSeek, read
[references/windows-sealseek.md](references/windows-sealseek.md) completely
before installation, command discovery, diagnosis, or updating. Its managed
runtime and `.cmd` rules replace the generic PATH probes below; after the adapter
passes, return to this Skill's main flow.

### Unified update contract

When the user explicitly asks to update or upgrade tbcli, run exactly one
unified command for the current Agent:

```bash
tbcli update --agent '<codex|agents|openclaw|sealseek>' --json
```

This command upgrades the npm CLI first, then uses the newly installed CLI to
install an absent companion Skill or refresh a stale managed copy, and finally
verifies both. Do not replace it with separate routine `npm install` and `skill
update` commands. Require `updated: true`, a nonempty `cli.afterVersion`, and
`skill.state: current` with `skill.current: true`. If the Skill target is
unmanaged, a foreign link, or a broken link, stop at the CLI's protection error
and ask the administrator to inspect it; never overwrite it.

Normal tbcli commands may print a throttled update notice on stderr. During an
unrelated business request, finish or safely stop that request and report the
notice; do not mutate a global installation without an explicit update request.
If a legacy CLI does not recognize `tbcli update`, bootstrap it once with `npm
install -g @petercjl/tbcli@latest`, then return to the unified command. On
Windows SealSeek, use the adapter's runtime-info bootstrap instead of relying on
bare `npm`, `node`, or `tbcli`. A source checkout follows its repository update
workflow instead of global npm update.

## Runtime Contract

- **Input:** a supported business task plus identifiers, URLs, report paths, dates, fields, filters, and output preference when applicable.
- **Strategy:** discover the live CLI, normalize the intent, preflight dependencies and all targets, execute stable commands, then verify outputs.
- **Output:** requested business data or a new file, with paths, covered period, command outcome, and limitations.
- **Dependencies:** a discoverable `tbcli` entry (or the Windows SealSeek adapter's managed-runtime entry); a supported Chrome; the fixed tbcli browser Profile logged into the required account; terminal execution and filesystem access. Normal commands do not require an exposed debugging port.
- **Permissions:** use only the current user's authorized account and visible data. Never extract or persist cookies, tokens, or session headers.
- **Success:** every requested target completes, every output is new and readable, its scope matches the request, and temporary SYCM reports are cleaned.

If generic command discovery fails, return `CLI_UNAVAILABLE`. On Windows
SealSeek, follow its adapter before declaring failure. Do not recreate a stable
tbcli workflow with raw HTTP, browser scripting, or an ad-hoc script.

## Main Flow

1. Discover the live CLI, then run `tbcli --help` and `tbcli capabilities --json`. On POSIX use `command -v tbcli`; on Windows SealSeek use its adapter and invoke `tbcli.cmd`. Use live syntax rather than recalled syntax.
2. Parse the user's intent into one or more targets. Identify required URLs/IDs, platform, data type, dimension, date granularity, period, fields, filters, and delivery directory.
3. Resolve relative dates using the user's local date. For completed daily data fetched from the platform, interpret “最近 N 天” as the N completed calendar days ending yesterday, inclusive. Thus start = end minus `N-1` days. Warehouse questions instead use the selected dataset's latest available date as defined in **Company Warehouse Flow**. State the resolved dates.
4. Preflight every target before creating any output. Check authentication with `tbcli auth status --json` when browser/login state is uncertain. If it reports logged out, run `tbcli auth login`, let the user complete the visible login/verification, confirm success, and return to this step. When a custom `--profile-dir` or `--session-mode` is used, preserve the same values across `auth status` → `auth login` → `auth status` and the later business command. For取数报表, follow **SYCM Report Flow**. For市场-商品排行的连续四周价格带数据, follow **SYCM Market Ranking Flow**. For questions over already imported company data, follow **Company Warehouse Flow**; that path does not need a browser login.
5. Choose a new output path. Read-only check every explicit path first. Never overwrite an existing file; use a clear new filename or ask when naming materially matters.
6. Execute targets sequentially so request pacing and partial failures remain understandable. Use `--json` when structured verification is useful.
7. Verify each output: existence, nonzero size, expected file type, requested date coverage, key headers, and target identity. For Excel, inspect the workbook rather than trusting only the exit code.
8. Treat any all-history Excel with exactly 100,000 data rows, or whose actual data period does not cover the requested/catalog period, as `TRUNCATED_EXPORT`. It is not a valid delivery or import source even when the CLI exited successfully. Preserve it only as a failed artifact, choose explicit contiguous date chunks, and rerun; when the target is in the maintained report list, read `references/report-maintenance.md` and use that table's fixed chunk contract. Never import or describe a truncated file as complete.
9. Deliver all output paths and a compact reconciliation: requested targets, resolved dates, fields/filter choices, successes, partial results, and platform limitations.

Return to Step 5 after resolving a preflight branch. Stop at an explicit failure terminal when authorization, verification, or a material user choice is missing.

## SYCM Report Flow

Use this flow for 生意参谋自主分析“取数报表” and 无界基础报表.

### 1. Normalize report names

Map `<数据粒度>-<数据维度>` as follows:

- `店铺-整体` → `--data-platform 生意参谋 --data-type 店铺 --data-dimension 整体`
- `商品-整体` → `--data-platform 生意参谋 --data-type 商品 --data-dimension 整体`
- `商品-SKU` → `生意参谋 / 商品 / SKU`
- `店铺-关键词` → `生意参谋 / 店铺 / 关键词`
- `商品-流量来源` → `生意参谋 / 商品 / 流量来源`（精确指旧版；不得选近似维度 `流量来源(新版)`）
- `商品-流量来源详情` → `生意参谋 / 商品 / 流量来源详情`（精确指旧版；不得选近似维度 `流量来源详情(新版)`）
- `商品-整体退款分布` → `生意参谋 / 商品 / 整体退款分布`
- `商品-退款原因分布` → `生意参谋 / 商品 / 退款原因分布`
- `商品-流失竞店分布` → `生意参谋 / 商品 / 流失竞店分布`
- `商品-退款SKU分布` → `生意参谋 / 商品 / 退款SKU分布`
- `无界-账户` or `无界-基础报表-账户` → `无界 / 基础报表 / 账户`；维护默认使用 `15天转化`
- `无界-计划/人群/商品主体/创意/单元/关键词` → `无界 / 基础报表 / <精确维度>`；维护默认同样使用 `15天转化`
- Apply the same grammar to other live dimensions. Do not guess an unknown dimension; discover it with `tbcli sycm catalog`.

When the user names multiple tables, create one Excel per table unless they explicitly ask for a merged workbook. Keep the same resolved period across all compatible targets.

### 2. Discover and preflight

For every target, run:

```bash
tbcli sycm catalog \
  --data-platform '<平台>' \
  --data-type '<数据粒度>' \
  --data-dimension '<数据维度>' \
  --date-type '<day|week|month|customDaySum>' \
  --json
```

Use the returned `dateTypes`, selected `dateType`, `validPeriod`, `filters`, and `fields` as authoritative. Omit `--date-type` to prefer `day`, otherwise the dimension's first legal type.

Preflight all targets against their `validPeriod` before downloading any. If the requested range is unavailable, report the common usable range and ask before changing dates. Never silently shorten or shift it.

“分日” means `--date-type day`; “分周” means `week`; “分月” means `month`; “汇总” means `customDaySum`. If unsupported, stop with the available values. Example: 商品-连带 currently uses weekly data rather than daily data.

### 3. Select fields and filters

- No field request, “全部字段”, “完整报表”, or simply “获取数据” → `--fields all`.
- Explicit fields → one comma-separated `--fields '字段1,字段2'`. Exact Chinese names and field codes are accepted.
- If a Chinese name is ambiguous, use the exact code returned by `sycm catalog`.
- Do not mix fields from different dimensions.
- tbcli automatically retains identity columns such as item/SKU, scene, and conversion cycle when metrics are selected.
- For each returned filter with multiple values, use the user's choice. If the choice materially changes meaning—especially 无界“转化周期”—ask rather than guessing. Pass repeatable `--filter '筛选项=值1,值2'` arguments.
- For 商品 dimensions, pass requested numeric IDs with `--item-ids 'ID1,ID2,...'`; accept comma, Chinese comma, or whitespace in user input, deduplicate it, and preserve 最多 100 IDs. Do not download every product and filter afterward.
- Map “所有终端/全部终端” to `--device all`, “总体/整体” to `overall`, “无线端” to `wireless`, and “PC端” to `pc`. `all` retains every returned field group and is valid even when the dimension does not require terminal filtering; identity fields remain present. Stop only when a non-`all` terminal choice is requested but the live dimension does not support it.

### 4. Fetch without a saved mother report

Prefer direct dimension mode for recurring work:

```bash
tbcli sycm fetch \
  --data-platform '<平台>' \
  --data-type '<数据粒度>' \
  --data-dimension '<数据维度>' \
  --date-type '<时间粒度>' \
  --fields '<all|字段1,字段2>' \
  [--device '<all|overall|wireless|pc>'] \
  [--item-ids '<ID1,ID2,...>'] \
  (--all-history | --start-date '<YYYY-MM-DD>' --end-date '<YYYY-MM-DD>') \
  --out '<new-output.xlsx>' \
  --json
```

Use `--all-history` when the user asks for “所有有数据的历史时间区间”, “全部可取历史”, or equivalent wording. The CLI resolves the live `validPeriod` and uses both boundaries; do not invent an earlier date. Do not combine it with explicit start/end dates.

For the natural request:

> 获取商品-整体中商品 ID 631249289145、635607974988、650978994929 的所有历史分日数据，所有字段，终端类型选择所有终端。

Preflight 商品-整体 with `day`, then run direct `sycm fetch` with `--fields all --device all --item-ids '631249289145,635607974988,650978994929' --all-history`. Report the resolved live date range from the JSON result and deliver one verified Excel.

Add filters as needed. The CLI creates a uniquely named `tbcli-temp-*` report, downloads the official Excel, and deletes only that verified temporary report.

For the natural request:

> 帮我用tbcli获取取数报表中的数据，数据表格是：店铺-整体和商品-整体，时间范围是最近30天的分日数据。

Resolve the last 30 completed days, preflight both catalogs with `day`, then run two direct `sycm fetch` commands with `--fields all`. Deliver two Excel files named by platform/type/dimension and resolved dates.

### 5. Saved-report branches

- Find a saved report: `tbcli sycm reports [--keyword '<名称>'] --json`.
- Export it unchanged: `tbcli sycm export --report-name '<精确名称>' --out '<new.xlsx>'`.
- Reuse its definition with new dates: `tbcli sycm fetch --report-name '<精确名称>' --start-date ... --end-date ... --out ... --json`.
- If exact names are duplicated, use `--report-id`.

Use these branches only when the user explicitly wants a saved report/template or its stored field/filter definition. Otherwise use direct mode.

### 6. Report QA

Require all of the following:

- JSON reports the requested period and target dimension.
- JSON reports the requested item IDs and terminal choice when supplied, plus `workbook.returnedItemIds`, `itemIdsWithoutRows`, and the actual `dataPeriod`. Treat missing rows as “no rows returned in the selected scope”, not as proof that an item does not exist.
- `temporaryReportDeleted` is `true` for `sycm fetch`.
- The `.xlsx` exists, is nonempty, and opens.
- Headers include date, shop, required identity dimensions, and requested metrics.
- The time granularity matches the request. For sparse filtered results, `workbook.dataPeriod` may be narrower than `requestedPeriod`; require it to stay inside the requested range rather than falsely requiring rows on both boundaries.
- Multi-target delivery includes one verified result per target.

If cleanup fails, preserve the downloaded file, report the exact temporary report ID/name, and do not claim full success. After an interrupted run, inspect `tbcli sycm reports --keyword 'tbcli-temp-' --json`; delete nothing manually without verifying tbcli ownership.

## SYCM Market Ranking Flow

Use this flow only for 生意参谋“市场 > 市场排行 > 商品”中按价格带获取连续四周排行数据。It is separate from 自主分析取数报表.

Require exactly two business inputs: the complete category ranking URL and one calendar date in the final requested week. Run:

```bash
tbcli sycm market-rank \
  --category-url '<生意参谋商品排行类目链接>' \
  --last-week '<YYYY-MM-DD>' \
  [--out-dir '<new-or-existing-directory-with-new-target-names>'] \
  --json
```

The CLI resolves the containing Monday–Sunday week and the three immediately preceding natural weeks. It creates four independent Excel files from oldest to newest. Each workbook contains exactly these six sheets: `0-50`, `50-135`, `135-255`, `255-455`, `455-660`, and `660以上`. Never add an `不限` sheet or analysis-only comparison columns.

Keep the page's actual account/shop request context and let tbcli vary only dates, page, page size, price band, and cache-busting values. A category page's `cateFlag` may differ from the ranking request's actual `cateFlag`; the request observed from the page is authoritative. The service may return only 20 rows even when a larger page size is requested, so pagination continues to `recordCount`. Rankings come from each row's returned rank value and must be strictly increasing. Preserve any stable gap returned by the platform; never fill gaps or derive rank from requested page size.

Every ranking request and request-triggering page action uses the shared random 1,000–2,000 ms guarded delay. If the page or response shows 挤爆了, a slider, CAPTCHA, login, security validation, access restriction, or platform validation signal, stop immediately without refresh, retry, or bypass. Ask the user to complete visible verification before a new run.

QA requires four new readable `.xlsx` files, exact natural-week periods, exactly six sheets per file, the 13 raw columns documented in the command reference, returned row counts, text-preserved item IDs, and strictly increasing platform values preserved identically in both ranking columns. If a later week fails, preserve and report earlier completed files; do not rerun those successful weeks unless requested.

## Report Maintenance Orchestration

For 日常更新、每日补数、日常维护清单、检查缺失日期不入库、断点续跑 or a scheduled
maintenance invocation, use the bundled **Daily Update** module. Read
[knowledge schema](references/SCHEMA.md), [index](references/index.md), recent
[log](references/log.md), then the [daily-update query route](references/queries/daily-update.md)
and its required pages completely. The module is part of this same `tbcli` Skill,
not a separately installed Skill and not a dependency on another Agent or private Wiki.
The one maintained-source registry remains `references/report-maintenance.md`;
only its `日常启用` rows participate in unqualified daily updates.
That registry may route one row through another stable collector such as `wdtcli`,
but validation, warehouse mutation, lock and coverage evidence remain governed here.
Counts copied into an old scheduler prompt are historical setup notes; never use them
to narrow the live enabled rows in the canonical registry.

When the user asks to 补全近期缺失数据, 补全某张取数表, maintain the warehouse from取数报表, 全量重拉并入库, 下载历史数据并上传数据库, or asks to continue processing known maintained tables as part of the warehouse-building workflow, read [references/report-maintenance.md](references/report-maintenance.md) completely before deciding any dates or commands. That reference is the Skill-owned report list and business methodology.

All recent incremental maintenance (including an ordinary “增补商品-整体”) uses the
Daily Update module's lock, journal, resume and no-refresh safety gates. Historical
rebuilds retain the existing explicit-authorization flow; they must not run alongside
a daily writer. During scheduled execution, stop with `AUTH_REQUIRED` instead of
opening an interactive login wait. Never create or modify a schedule merely because
this module was invoked; scheduling is a separately authorized host operation.

Keep the boundary explicit: the Agent and this Skill decide **what** to maintain; `tbcli` executes atomic commands with explicit targets and dates. Never replace this composition with an all-in-one sync command, and never let a CLI default decide what “近期” means.

## Company Warehouse Flow

Use this flow when the user asks what data has been imported or asks a business question over the company ecommerce warehouse. The employee supplies business intent; the Agent discovers fields and calls semantic commands. Never ask the employee to write SQL, never expose a raw-SQL escape hatch, and never bypass `tbcli` with `psql` or an ad-hoc database script.

For “预估利润”、按负责人查看利润或利润 Excel，do not assemble generic warehouse queries. Read [references/queries/profit-estimate.md](references/queries/profit-estimate.md) and every page it requires, execute its live read-only query/export flow, then return here for delivery QA.

### 1. Check the warehouse and discover its live scope

For an employee who needs first-time company-warehouse access, ask for the local
path of the encrypted company reader credential file downloaded from the
approved internal document. The file may be in Downloads; do not ask the user
to paste a database password or inspect/decrypt it manually. Then run:

```bash
tbcli db setup-reader --credential-file '<downloaded .tbcred path>' --json
tbcli db access-check --json
```

`setup-reader` checks the existing local configuration first. If it is already a
working reader, require `action: unchanged` and continue without importing or
moving the downloaded file. Otherwise it decrypts the approved file, installs
the local pgpass in the stable current-user config directory, writes only an
`accessMode: read-only` connection, backs up broken reader files, and verifies
actual privileges. It must never replace a maintainer configuration. Require
`connected: true` and `readOnly: true` before continuing. A read-only
configuration supports warehouse discovery/query and authorized profit
`orders identity`, order/refund `coverage`, `estimate query/export`.
Source-data `db init/import` remains maintainer-only. Profit queries and exports use current facts without database writes.

The downloaded `.tbcred` is an encrypted transport file, not the runtime pgpass.
Its encryption avoids casual plaintext display; company-LAN reachability and the
database reader role remain the actual access boundaries. Never copy its secret
payload into this Skill, the npm package, Git, logs, or chat. Never distribute a
maintainer credential. If setup fails, report `DATABASE_UNAVAILABLE` and ask the
administrator for a fresh approved reader file; do not invent connection values.

Legacy repair remains available only when an administrator has separately
provisioned a protected pgpass file:

```bash
tbcli db credential-path --json
tbcli db credential-set --pgpass-file '<stable protected pgpass path>' --json
tbcli db access-check --json
```

Require `credential-set` to return `updated: true` and a `backupPath`; preserve
that metadata backup until access verification succeeds. Then return to the
warehouse discovery main line below.

Run:

```bash
tbcli db network --json
tbcli db status --json
tbcli db datasets --json
```

If the protected database configuration declares the optional `zxvpn` network
adapter, every database command first calls `zxvpn ensure --json`. On the company
LAN this keeps the tunnel down; outside the company it establishes the approved
WireGuard route before PostgreSQL is contacted. The Agent should not manually
retry PostgreSQL while the adapter reports `DATABASE_NETWORK_UNAVAILABLE`.

An authorized administrator configures or disables the adapter once with:

```bash
tbcli db network --provider zxvpn --ensure --json
tbcli db network --provider none --json
```

The command backs up the existing protected database configuration before
changing only its network-adapter field. `zxvpn` must already be installed and
authorized on that machine. Do not copy VPN endpoints, keys, company addresses,
or credentials into the npm package or Skill. Machines without this requirement
keep provider `none` and connect exactly as before.

Treat `db datasets` as authoritative for dataset names, grain, available dates, row counts, and field counts. A warehouse query uses imported data and therefore does not require Taobao browser authentication. If connection configuration is absent or invalid, stop with `DATABASE_UNAVAILABLE`; do not invent a host, user, password, or database name.

This warehouse rule takes precedence over Main Flow's platform-fetch date rule. Resolve relative periods against the selected dataset's latest available date, not blindly against today's date. For example, “最近30天” means the calendar interval from `max_date - 29 days` through `max_date`, inclusive. State the resolved dates and flag stale coverage when the dataset does not reach the expected recent period.

If the user explicitly asks for “最近 N 个有数据日期” rather than a calendar interval, first run a day-grouped query ordered by `统计日期` descending with `--limit N`. “有数据日期” means at least one imported source row exists on that date; it does not mean a chosen metric is nonzero. Use the earliest and latest returned dates for the subsequent business query and disclose any gaps. If the user instead means N dates where a particular metric is nonzero, report that the current semantic query contract cannot express that filter rather than silently changing the definition.

### 2. Translate business language into a semantic query

Choose exactly one dataset, then discover its current fields. If several datasets contain the requested metrics, prefer the narrowest dataset whose name and grain directly match the business subject and whose fields are sufficient; for ordinary product performance, prefer `商品-整体` over a wider specialized dataset such as `商品-经营投产比`. Use the specialized dataset when the question explicitly concerns its subject. Do not combine datasets implicitly.

```bash
tbcli db fields --dataset '<业务表>' --json
```

Map the request only to returned field names and one supported grouping:

- overall company/store trend → `day`
- one grand total → `total`
- 商品排行/商品对比 → `item`
- SKU排行/对比 → `sku`
- 关键词排行/搜索词分析 → `keyword`
- 连带商品分析 → `related-item`
- 商品流量来源分析 → `traffic-source`
- 商品搜索词/流量来源详情分析 → `search-term`
- 店铺对比 → `shop`

`item`, `sku`, `keyword`, `related-item`, `traffic-source`, and `search-term` groupings aggregate across every shop present in the selected dataset unless the result also groups by shop; the current CLI supports one grouping at a time. State this when a multi-shop warehouse is configured.

Then run:

```bash
tbcli db query \
  --dataset '<业务表>' \
  --metrics '<指标1,指标2>' \
  [--start-date '<YYYY-MM-DD>' --end-date '<YYYY-MM-DD>'] \
  [--group-by '<total|day|shop|item|sku|keyword|related-item|traffic-source|search-term|scene|conversion-cycle|plan|unit|audience|subject|creative>'] \
  [--item-ids '<ID1,ID2,...>'] \
  [--keyword '<包含文本>'] \
  [--order-by '<返回字段>'] [--asc] [--limit '<1-1000>'] \
  --json
```

Use the dataset's default metrics only when the user did not name a metric. The CLI parameterizes filters and permits at most 12 metrics and 1,000 returned groups. Preserve the CLI's returned `dataset`, `period`, `groupBy`, `metrics[].aggregation`, `rowCount`, and rows when explaining the result.

### 3. Respect metric semantics

- Additive fields such as金额、人数、件数、访客数 default to `sum`.
- A sum of daily visitor counts is a sum of daily visitors, not a distinct visitor/UV count across the whole period. Use that exact wording when the distinction matters.
- Rate, ratio, ROI, CTR, CPC, CPM, average, unit-price, and cost-like fields default to `avg` in the current warehouse catalog.
- An `avg` over imported daily rows is a descriptive average, not necessarily the platform's exact recomputed cross-period ratio. Never present it as an exact official period total.
- For a decision that depends on a derived metric, prefer querying its additive numerator and denominator and recomputing from totals only when the business formula is known. If the formula is not registered, disclose the limitation and ask for the desired business definition instead of guessing.
- Do not sum percentage, rate, ROI, average, cost-per-unit, or unit-price fields.

### 4. Import and coverage primitives (administrator branch)

Use only for an authorized maintainer who asks to initialize, inspect coverage, or load tbcli-downloaded workbooks:

```bash
tbcli db init --json
tbcli db write-check --json
tbcli db coverage --dataset '<业务表>' --start-date '<YYYY-MM-DD>' --end-date '<YYYY-MM-DD>' --json
tbcli db import --input '<Excel文件>' --dataset '<业务表>' \
  --mode '<append|replace-range|replace-all>' \
  [--start-date '<YYYY-MM-DD>' --end-date '<YYYY-MM-DD>'] --json
```

`db init` only initializes or upgrades tbcli's technical warehouse schema. A maintainer configuration uses its single `ingestUser` identity for both reads and writes; it does not depend on the employee reader role. Run `db access-check --json` to verify that identity can read all warehouse tables, then run `db write-check`; require `ok: true`, `probe.rolledBack: true`, and `probe.residueCount: 0` before treating the maintainer configuration as valid. An employee `accessMode: read-only` configuration remains separate and must return `readOnly: true`. The write check performs representative insert/update/delete operations inside one transaction, rolls it back, and refuses a read-only configuration. Do not replace either check with raw SQL or an ad-hoc script. `db coverage` reports coverage inside the caller-supplied interval and does not choose a business maintenance window. For imports, `append` rejects overlapping dates; `replace-range` atomically replaces one declared range; `replace-all` atomically rebuilds one dataset. An explicit `--dataset` allows a single incremental file whose name is not a full-history canonical name, but the importer still validates required headers and date bounds. Keep `--reimport` exceptional and limited to an exact source correction. After import, rerun `db coverage` and `db datasets`, then reconcile file identity, mode, rows, declared coverage, actual data range, and fields.

Database write configuration remains an administrator-only task. `tbcli db configure --host '<host>' --database '<database>' --ingest-user '<maintainer role>'` stores connection metadata only; `--reader-user` is neither required nor used by a maintainer configuration. The maintainer credential stays in a separately protected pgpass file and must never enter an employee `.tbcred`. To create the employee transport artifact, an administrator uses `tbcli db credential-bundle-create` with the exact reader host, database, role, and protected source pgpass; the command requires exactly one matching reader record and writes a new file without overwrite. The default runtime credential location is `~/.config/tbcli/pgpass`; an explicit `--pgpass-file` is allowed only for another stable user-owned path outside npm, `node_modules`, managed Skill directories, and Git. Never print, copy into the Skill, or return database passwords. The default config may be overridden with `TBCLI_DB_CONFIG` for another machine. Do not give employees a maintenance configuration or its pgpass credential.

For individually audited access, read the individual employee section in [references/command-reference.md](references/command-reference.md). Treat the administrator workbook and generated credential directory as private. Provision only rows explicitly marked for database access. New employee accounts start with zero business datasets and physical tables; grant the minimum required dataset or table separately. Never reuse or read the NAS password column as a database password, and never print generated database passwords.

### 5. Warehouse QA and handoff

Require all of the following:

- connection succeeds with the read-only role for employee queries;
- the chosen dataset and every metric exist in live catalogs;
- resolved dates fall inside the imported range;
- returned grouping matches the business question;
- the result states row count, sort direction, date scope, and aggregation semantics;
- zero rows is reported as “当前筛选范围无数据”, not as proof that a product or keyword never existed;
- analysis distinguishes source facts from interpretation and calls out stale coverage or derived-metric limitations.

## Other Stable Tasks

Read [references/command-reference.md](references/command-reference.md) when the request concerns shop products, logistics, AI点睛, DingTalk documents, browser startup, or the full command catalog. Do not load it for an ordinary SYCM report request.

## Failure Branches

- **Browser unavailable:** verify Chrome installation and the fixed Profile configuration with `tbcli doctor`; normal commands launch a managed persistent browser without requiring port 9223. Return to Main Flow Step 4 after resolving the dependency.
- **Profile already open:** an ordinary Chrome without an attachable session cannot be taken over safely. Ask the user to close the Chrome using the fixed Profile, then return to Main Flow Step 4. Never copy the Profile or extract Cookie databases.
- **Unsupported `--no-sandbox` banner:** treat this as an unsafe or outdated tbcli browser launch. Stop the login attempt. For an npm installation, run `tbcli update --agent <当前Agent> --json`, require the unified CLI-and-Skill verification contract above, close that browser, and rerun `tbcli auth login`. If the legacy CLI lacks the unified command, bootstrap `@latest` once and immediately return to it. For a source checkout, use its repository update workflow instead of replacing it with npm. Never advise repeated slider attempts or disabling the Chrome sandbox.
- **Sandbox unavailable:** stop with the CLI error and ask the user to repair Chrome/operating-system sandbox support. Never add or recommend `--no-sandbox` as a fallback.
- **Login or verification required:** run `tbcli auth login`, ask the user to complete login/captcha in the visible Chrome, wait for the CLI to confirm authentication, and return to Main Flow Step 4. Do not bypass verification or expose cookies.
- **Date unavailable:** report requested and valid periods; require approval before changing the period.
- **Unknown report/field/filter:** use `sycm catalog`; never invent names or codes.
- **Existing output:** select a new path; never bypass overwrite protection.
- **Partial multi-target result:** preserve completed new files, identify failed targets, and do not rerun successful targets unless requested.
- **Unsupported capability:** report `CONTRACT_UNSUPPORTED` and the closest discoverable stable command; do not fall back to raw private APIs.
- **Warehouse unavailable:** report `DATABASE_UNAVAILABLE`, preserve the business question, and ask an administrator to configure or restore the approved warehouse connection. Do not request credentials from an employee or substitute a public/Tailscale endpoint.
- **Database network adapter unavailable:** when a configured `zxvpn` command is missing, cannot ensure the route, or returns invalid JSON, stop with `DATABASE_NETWORK_UNAVAILABLE`. Do not repeatedly retry PostgreSQL, silently bypass the adapter, expose the database directly, or invent another VPN route. After the administrator restores `zxvpn`, return to Company Warehouse Flow discovery.
- **Reader access check fails:** stop before any warehouse query. Report only the failed privilege category; ask the administrator to correct the reader role or local configuration. Never compensate by using a maintenance credential.

## Evolution Rule

When a realistic run exposes a recurring routing, CLI, field, date, filter, cleanup, or QA gap, extend the stable tbcli command and update this canonical Skill. Classify the failure, patch the correct main-flow or branch contract, validate files on disk, and rerun a clean-context regression when the host permits it.
