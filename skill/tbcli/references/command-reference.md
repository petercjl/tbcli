# tbcli Command Reference

Read only the section relevant to the current request. Always confirm live syntax with `tbcli --help` and business capabilities with `tbcli capabilities --json`.

## Ecommerce browser and health

```bash
tbcli browser open [--url '<URL>']
tbcli doctor [--json]
tbcli capabilities [--json] [--all]
```

Use the shared dedicated ecommerce browser. Do not substitute a temporary browser profile. `doctor` checks Chrome/CDP and the authenticated session.

## SYCM and Wujie reports

```bash
tbcli sycm catalog [--data-platform '<平台>' [--data-type '<粒度>' [--data-dimension '<维度>']]] [--date-type '<类型>'] [--json]
tbcli sycm reports [--keyword '<名称>'] [--page N] [--page-size 100] [--json]
tbcli sycm export (--report-id ID | --report-name '<名称>') --out '<new.xlsx>' [--json]
tbcli sycm fetch (--report-id ID | --report-name '<名称>') --start-date YYYY-MM-DD --end-date YYYY-MM-DD --out '<new.xlsx>' [--json]
tbcli sycm fetch --data-platform '<平台>' --data-type '<粒度>' --data-dimension '<维度>' [--date-type day|week|month|customDaySum] [--fields 'all|字段,...'] [--filter '名称=值,...'] --start-date YYYY-MM-DD --end-date YYYY-MM-DD --out '<new.xlsx>' --json
```

Direct mode is the default for recurring extraction. Saved-report mode preserves a report's stored fields and filters. Every dimension owns its own field catalog and valid date range.

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
tbcli skill source --json
tbcli skill status (--agent codex|agents|openclaw|sealseek | --target-dir '<root>')
tbcli skill install (--agent codex|agents|openclaw|sealseek | --target-dir '<root>') [--mode auto|link|copy]
tbcli skill update (--agent codex|agents|openclaw|sealseek | --target-dir '<root>')
```

The bundled source is canonical. Installations refuse to replace existing unmanaged Skill directories. Link mode is preferred where supported; managed copies carry a digest and are updated recoverably.

## Development-only commands

`tbcli dev pages`, `dev inspect`, and `dev capture` are for capability discovery and debugging. Do not use them for an ordinary supported business task. When a recurring need is understood, extend a stable command and this Skill rather than leaving the workflow in development commands.
