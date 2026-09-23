# tbcli Command Reference

Read only the section relevant to the current request. Always confirm live syntax with `tbcli --help` and business capabilities with `tbcli capabilities --json`.

## Ecommerce browser and health

```bash
tbcli auth login [--timeout-ms 300000] [--json]
tbcli auth status [--json]
tbcli browser open [--url '<URL>']
tbcli doctor [--json]
tbcli doctor --agent sealseek [--fix] [--json]
tbcli capabilities [--json] [--all]
```

Use the fixed persistent tbcli Profile. Start with `auth status`; if logged out,
run `auth login` and wait while the user completes the visible login flow. Normal
commands use a managed browser without requiring port 9223. `browser open` is a
legacy compatibility/debugging command. If another ordinary Chrome owns the
Profile, ask the user to close it; never copy the Profile or export cookies. If
the caller supplies `--profile-dir` or `--session-mode`, keep the same values on
the status, login, status-confirmation, and business commands.

Managed Chrome must run with its security sandbox enabled. If Chrome shows an
unsupported `--no-sandbox` warning, stop authentication, upgrade tbcli, close
that browser, and start `auth login` again. Never work around a slider by
disabling the sandbox or repeatedly retrying verification.

For npm installs, use `tbcli update --agent <agent> --json`. This is the stable
upgrade boundary: it upgrades the CLI package, then installs an absent Skill or
updates a stale managed copy, and finally requires the Skill state to be
`current`. A current linked Skill already follows the upgraded package. Stop
without overwriting an unmanaged directory, foreign link, or broken link. If a
legacy release does not recognize `tbcli update`, bootstrap once with `npm
install -g @petercjl/tbcli@latest`, then immediately run the unified update
command. Do not keep npm and Skill upgrades as separate routine steps.
For a source checkout, use the repository's update workflow instead of
installing over it globally.

## SYCM and Wujie reports

```bash
tbcli sycm catalog [--data-platform '<平台>' [--data-type '<粒度>' [--data-dimension '<维度>']]] [--date-type '<类型>'] [--json]
tbcli sycm reports [--keyword '<名称>'] [--page N] [--page-size 100] [--json]
tbcli sycm export (--report-id ID | --report-name '<名称>') --out '<new.xlsx>' [--json]
tbcli sycm fetch (--report-id ID | --report-name '<名称>') --start-date YYYY-MM-DD --end-date YYYY-MM-DD --out '<new.xlsx>' [--json]
tbcli sycm fetch --data-platform '<平台>' --data-type '<粒度>' --data-dimension '<维度>' [--date-type day|week|month|customDaySum] [--fields 'all|字段,...'] [--device all|overall|wireless|pc] [--item-ids 'ID,...'] [--filter '名称=值,...'] (--all-history | --start-date YYYY-MM-DD --end-date YYYY-MM-DD) --out '<new.xlsx>' --json
tbcli sycm market-rank --category-url '<商品排行类目链接>' --last-week YYYY-MM-DD [--out-dir '<directory>'] [--json]
```

Direct mode is the default for recurring extraction. Saved-report mode preserves a report's stored fields and filters. Every dimension owns its own field catalog and valid date range.

`--item-ids` accepts up to 100 numeric IDs in direct 商品 mode. `--all-history` uses the dimension's current complete `validPeriod` and is mutually exclusive with explicit dates. `--device all` retains overall, wireless, and PC field groups; the other accepted values select one group while preserving identity fields.

`sycm market-rank` is the four-natural-week product-ranking command. `--last-week` may be any date in the final week. It writes one workbook per week and exactly six price-band sheets per workbook: `0-50`, `50-135`, `135-255`, `255-455`, `455-660`, and `660以上`; there is no `不限` sheet. Every sheet has these 13 columns in order: `榜单排名`, `商品ID`, `商品标题`, `店铺`, `店铺类型`, `核心关键词`, `支付买家数`, `访客数`, `所属价格带`, `价格带排名`, `商品链接`, `店铺链接`, `图片链接`. Ranking values preserve the platform's strictly increasing values, including a stable gap if the platform omits a rank. Default request pacing is a guarded random 1,000–2,000 ms, and verification or 挤爆了 stops the run immediately while preserving completed week files.

## Shop products

```bash
tbcli shop products --url '<shop-url>' [--page N | --max-pages N] [--cache-path '<checkpoint.json>'] --out '<new.xlsx>' [--json]
```

Use for Taobao/Tmall shop product lists. Default to all real pages unless the user limits pages. Preserve checkpoints on partial failures. Verify overview, product rows, SKU details, prices, and requested page scope.

## Order logistics

```bash
tbcli logistics get --trade-id '<order-id>' [--seller-id '<seller-id>'] [--json] [--out '<new.json>']
```

Use only for an authorized seller-visible order. Deliver package, carrier, tracking number, and timeline without exposing session data.

## AI Dianjing

```bash
tbcli ai-dianjing export --url '<plan-url>' [--days 7] [--out '<new.json>'] [--json]
tbcli ai-dianjing export --campaign-id '<id>' [--days 7] [--out '<new.json>'] [--json]
```

Use for AI点睛 plan summaries, demand performance, search terms, and audiences. Prefer the plan URL unless the corresponding page is already open and the campaign ID is unambiguous.

## DingTalk documents

```bash
tbcli document get --url '<document-url>' [--out '<new-directory>'] [--no-images] [--close-tab] [--json]
tbcli document tree --url '<node-url>' [--out '<new-tree.json>'] [--max-depth 20] [--json]
```

Use only for the supported browser-session document workflows exposed by tbcli. For general DingTalk data operations, follow the environment's official DingTalk CLI policy instead.

## Companion Skill lifecycle

```bash
tbcli setup sealseek --json
tbcli update (--agent codex|agents|openclaw|sealseek | --target-dir '<root>') --json
tbcli skill source --json
tbcli skill status (--agent codex|agents|openclaw|sealseek | --target-dir '<root>')
tbcli skill install (--agent codex|agents|openclaw|sealseek | --target-dir '<root>') [--mode auto|link|copy]
tbcli skill update (--agent codex|agents|openclaw|sealseek | --target-dir '<root>')
```

The bundled source is canonical. Installations refuse to replace existing unmanaged Skill directories. Link mode is preferred where supported; managed copies carry a digest and are updated recoverably. Normal CLI use performs a cached npm version check at most once every six hours. When stderr prints an update notice, preserve the current business command and offer the unified update command; do not silently mutate global packages during an unrelated task.

For Windows SealSeek, read `windows-sealseek.md` before installation or updates.
Use the managed runtime discovered from runtime-info and invoke `.cmd` launchers;
do not require manual PATH edits or a PowerShell ExecutionPolicy change.

## Company warehouse access

For employee onboarding, use the encrypted company reader credential file
downloaded from the approved internal document. The employee supplies only its
local path; never ask them to paste a password.

```bash
tbcli db setup-reader --credential-file '<downloaded .tbcred path>' --json
tbcli db access-check --json
tbcli db status --json
```

`setup-reader` validates a working local reader first and returns `action:
unchanged` without replacement. Otherwise it imports the approved encrypted
file into the current user's stable configuration directory, creates a read-only
configuration, backs up broken reader files, and verifies the account. It never
replaces a maintainer configuration. `access-check` independently verifies that the reader
cannot create a database/schema or insert, update, or delete warehouse rows.
If the check fails, stop rather than querying or importing. `db init` and `db
import` reject a read-only configuration. The encrypted file prevents casual
plaintext display; the company LAN and database reader role remain the real
access controls. Administrators use `db configure --ingest-user '<maintainer
role>'` with an independently protected maintenance credential. That single
role serves both query and import commands under `accessMode: maintainer`; it
must never be placed in an employee bundle.

### Guarded physical-table queries

Use these commands when a request targets versioned master data, another
authorized physical relation, or a cross-table question that `db query` cannot
express:

```bash
tbcli db tables [--schema '<schema>'] [--keyword '<text>'] --json
tbcli db describe --relation '<schema.table>' --json
tbcli db sql (--sql '<query>' | --sql-file '<file>') \
  [--params-json '<JSON array>'] [--limit 200] [--timeout-ms 30000] --json
```

`db tables` returns only non-system relations for which the current identity has
schema usage and table `SELECT`. `db describe` applies the same permission
boundary. `db sql` accepts exactly one `SELECT`, `WITH`, `UNION`, or `VALUES`
query, rejects write and system-catalog statements, starts a read-only
transaction, and applies a 1,000-row hard maximum plus a 120-second hard timeout.
PostgreSQL table permissions and row-level security remain authoritative. The
result includes `readOnly`, a query hash, returned row count, truncation state,
column metadata, duration, and rows.

### Individual employee accounts and audit

Use only with an administrator database configuration whose login can manage
roles and owns the warehouse access-control objects.

```bash
tbcli db employee-provision --input '<管理员专用员工信息.xlsx>' --credential-dir '<private-directory>' --json
tbcli db employee-list --json
tbcli db employee-grant --account '<NAS账号>' --dataset '<数据集>' --json
tbcli db employee-grant --department '<部门>' --table '<schema.table>' --json
tbcli db employee-revoke --account '<NAS账号>' --dataset '<数据集>' --json
tbcli db employee-audit [--account '<NAS账号>'] [--days 90] --json
```

`employee-provision` reads employee name, department, account name, and the
database-access flag. It ignores NAS passwords, creates a different random
database password, and writes one protected `.tbcred` bearer credential per new
employee. It never overwrites an existing credential file. A new account can
connect but sees no business dataset until an administrator grants one.

Current SYCM/Wujie datasets share `raw.sycm_rows`, so dataset grants are enforced
with row-level security keyed by `dataset_key`. Future standalone relations use
explicit `schema.table` SELECT grants. Employee queries issued through `tbcli db
query` write an audit event with the employee role, dataset, query scope, result
row count, client address, and application name. Do not log passwords or return
credential contents. A `.tbcred` file is a bearer secret rather than a
device-bound credential; revoke or rotate the employee account if it leaks.

## Development-only commands

`tbcli dev pages`, `dev inspect`, and `dev capture` are for capability discovery and debugging. Do not use them for an ordinary supported business task. When a recurring need is understood, extend a stable command and this Skill rather than leaving the workflow in development commands.
