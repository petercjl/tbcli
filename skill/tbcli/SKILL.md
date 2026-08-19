---
name: tbcli
description: Operate the stable tbcli CLI for Taobao, Tmall, Qianniu, 生意参谋自主分析/取数报表, 无界基础报表, shop-product exports, order logistics, AI点睛 reports, and supported DingTalk document tasks. Use when the user says tbcli, 电商浏览器, 获取/导出取数报表, 店铺-整体, 商品-整体, SKU, 关键词, 流量来源, 无界账户/计划/人群/商品主体, 最近N天分日数据, or asks what tbcli can do. Translate natural-language report names, periods, fields, and filters into stable CLI commands and deliver verified files.
---

# tbcli

Use `tbcli` as the deterministic execution surface for supported ecommerce-browser work. Translate business language into commands, preflight the whole request, run the smallest stable command, and verify the delivered artifact.

## Source Of Truth

This Skill is distributed with the `tbcli` CLI. Treat the path returned by `tbcli skill source --json` as the only editable source. Agent Skill directories contain CLI-managed links or copies; never maintain an independent fork.

Discover or install it with:

```bash
tbcli skill source --json
tbcli skill status --agent codex
tbcli skill install --agent codex
```

Use `--agent agents`, `openclaw`, or `sealseek`, or `--target-dir <agent-skill-root>`. Linked installs update immediately; use `tbcli skill update` only for a managed copy. Refresh the host Skill catalog if it snapshots metadata.

## Runtime Contract

- **Input:** a supported business task plus identifiers, URLs, report paths, dates, fields, filters, and output preference when applicable.
- **Strategy:** discover the live CLI, normalize the intent, preflight dependencies and all targets, execute stable commands, then verify outputs.
- **Output:** requested business data or a new file, with paths, covered period, command outcome, and limitations.
- **Dependencies:** `tbcli` on `PATH`; a supported Chrome; the fixed tbcli browser Profile logged into the required account; terminal execution and filesystem access. Normal commands do not require an exposed debugging port.
- **Permissions:** use only the current user's authorized account and visible data. Never extract or persist cookies, tokens, or session headers.
- **Success:** every requested target completes, every output is new and readable, its scope matches the request, and temporary SYCM reports are cleaned.

If `command -v tbcli` fails, return `CLI_UNAVAILABLE`. Do not recreate a stable tbcli workflow with raw HTTP, browser scripting, or an ad-hoc script.

## Main Flow

1. Run `command -v tbcli`, `tbcli --help`, and `tbcli capabilities --json`. Use the live CLI rather than recalled syntax.
2. Parse the user's intent into one or more targets. Identify required URLs/IDs, platform, data type, dimension, date granularity, period, fields, filters, and delivery directory.
3. Resolve relative dates using the user's local date. For completed daily data, interpret “最近 N 天” as the N completed calendar days ending yesterday, inclusive. Thus start = end minus `N-1` days. State the resolved dates.
4. Preflight every target before creating any output. Check authentication with `tbcli auth status --json` when browser/login state is uncertain. If it reports logged out, run `tbcli auth login`, let the user complete the visible login/verification, confirm success, and return to this step. When a custom `--profile-dir` or `--session-mode` is used, preserve the same values across `auth status` → `auth login` → `auth status` and the later business command. For取数报表, follow **SYCM Report Flow**.
5. Choose a new output path. Read-only check every explicit path first. Never overwrite an existing file; use a clear new filename or ask when naming materially matters.
6. Execute targets sequentially so request pacing and partial failures remain understandable. Use `--json` when structured verification is useful.
7. Verify each output: existence, nonzero size, expected file type, requested date coverage, key headers, and target identity. For Excel, inspect the workbook rather than trusting only the exit code.
8. Deliver all output paths and a compact reconciliation: requested targets, resolved dates, fields/filter choices, successes, partial results, and platform limitations.

Return to Step 5 after resolving a preflight branch. Stop at an explicit failure terminal when authorization, verification, or a material user choice is missing.

## SYCM Report Flow

Use this flow for 生意参谋自主分析“取数报表” and 无界基础报表.

### 1. Normalize report names

Map `<数据粒度>-<数据维度>` as follows:

- `店铺-整体` → `--data-platform 生意参谋 --data-type 店铺 --data-dimension 整体`
- `商品-整体` → `--data-platform 生意参谋 --data-type 商品 --data-dimension 整体`
- `商品-SKU` → `生意参谋 / 商品 / SKU`
- `店铺-关键词` → `生意参谋 / 店铺 / 关键词`
- `无界-账户` or `无界-基础报表-账户` → `无界 / 基础报表 / 账户`
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

### 4. Fetch without a saved mother report

Prefer direct dimension mode for recurring work:

```bash
tbcli sycm fetch \
  --data-platform '<平台>' \
  --data-type '<数据粒度>' \
  --data-dimension '<数据维度>' \
  --date-type '<时间粒度>' \
  --fields '<all|字段1,字段2>' \
  --start-date '<YYYY-MM-DD>' \
  --end-date '<YYYY-MM-DD>' \
  --out '<new-output.xlsx>' \
  --json
```

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
- `temporaryReportDeleted` is `true` for `sycm fetch`.
- The `.xlsx` exists, is nonempty, and opens.
- Headers include date, shop, required identity dimensions, and requested metrics.
- The first/last dates and time granularity match the request.
- Multi-target delivery includes one verified result per target.

If cleanup fails, preserve the downloaded file, report the exact temporary report ID/name, and do not claim full success. After an interrupted run, inspect `tbcli sycm reports --keyword 'tbcli-temp-' --json`; delete nothing manually without verifying tbcli ownership.

## Other Stable Tasks

Read [references/command-reference.md](references/command-reference.md) when the request concerns shop products, logistics, AI点睛, DingTalk documents, browser startup, or the full command catalog. Do not load it for an ordinary SYCM report request.

## Failure Branches

- **Browser unavailable:** verify Chrome installation and the fixed Profile configuration with `tbcli doctor`; normal commands launch a managed persistent browser without requiring port 9223. Return to Main Flow Step 4 after resolving the dependency.
- **Profile already open:** an ordinary Chrome without an attachable session cannot be taken over safely. Ask the user to close the Chrome using the fixed Profile, then return to Main Flow Step 4. Never copy the Profile or extract Cookie databases.
- **Login or verification required:** run `tbcli auth login`, ask the user to complete login/captcha in the visible Chrome, wait for the CLI to confirm authentication, and return to Main Flow Step 4. Do not bypass verification or expose cookies.
- **Date unavailable:** report requested and valid periods; require approval before changing the period.
- **Unknown report/field/filter:** use `sycm catalog`; never invent names or codes.
- **Existing output:** select a new path; never bypass overwrite protection.
- **Partial multi-target result:** preserve completed new files, identify failed targets, and do not rerun successful targets unless requested.
- **Unsupported capability:** report `CONTRACT_UNSUPPORTED` and the closest discoverable stable command; do not fall back to raw private APIs.

## Evolution Rule

When a realistic run exposes a recurring routing, CLI, field, date, filter, cleanup, or QA gap, extend the stable tbcli command and update this canonical Skill. Classify the failure, patch the correct main-flow or branch contract, validate files on disk, and rerun a clean-context regression when the host permits it.
