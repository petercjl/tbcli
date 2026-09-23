---
name: ecommerce-monthly-profit-report
description: Generate a standalone monthly actual-profit HTML report for an ecommerce shop from tbcli reconciled profit data through the shared compact-commerce-ui renderer. Use when the user asks to review a completed month, explain whole-shop profit, compare responsible owners, identify the most profitable or loss-making products, or create a shareable HTML profit analysis.
---

# 月度实际利润分析报告

## Goal

Turn one complete natural month's actual-profit facts into a standalone HTML management report. Lead with the whole-shop result, then explain owner performance and the products creating profit or loss. Preserve data-quality qualifications. Keep calculation, analysis orchestration, and presentation in separate ownership layers.

## Required dependencies

### Business data: `tbcli`

- Logical Skill: exact name `tbcli`.
- Resolution: resolve it from the host's advertised Skill catalog or configured Skill roots, read its complete current `SKILL.md`, load its actual-profit route, then return here.
- Required CLI capability: `profit-actual-query`, including `--group-by report` and the `sections.shop`, `sections.owners`, `sections.products`, `quality`, and `reconciliation` output contract.
- Runtime discovery: execute `tbcli capabilities --json --all` and verify the live capability. Do not infer availability from this file.
- Failure: return `DEPENDENCY_UNAVAILABLE` if the exact Skill or capability is missing. Do not substitute estimated profit, raw SQL, generic warehouse queries, or reconstructed business logic.
- Return point: after obtaining one verified report payload, resume at Main Line step 5.

### Presentation: `compact-commerce-ui`

- Logical Skill: exact name `compact-commerce-ui`.
- Resolution: resolve it from the host's advertised Skill catalog or configured Skill roots and read its complete current `SKILL.md`; do not use fuzzy matching or copy its implementation here.
- Required CLI contract: discover the live `commerce-ui` executable, version, health, installed template packs, and selected template schema. This Skill requires the `monthly-profit-review` pack with contract `monthly-profit-review@1.0`.
- Runtime discovery: run `command -v commerce-ui`, `commerce-ui version --json`, `commerce-ui doctor`, `commerce-ui templates list --json`, and `commerce-ui schema --template monthly-profit-review` before building the ViewModel.
- Failure: return `DEPENDENCY_UNAVAILABLE` if the exact Skill, CLI, compatible template, or contract is missing. If no installed template is semantically suitable, follow the dependency's documented template-pack lifecycle; never add a private HTML renderer to this Skill or tbcli.
- Return point: after loading the live ViewModel contract, resume at Main Line step 4; after validated rendering, resume at Main Line step 9.

tbcli does not depend on `compact-commerce-ui`. This application Skill composes the two independent capabilities at runtime.

## Input

- Exact shop key resolved through tbcli.
- One complete natural month in `YYYY-MM`.
- A new `.html` output path.
- Optional positive `top-n`; default 10.

Do not embed shop-specific defaults, private paths, credentials, or company-only identifiers in this Skill.

## Main Line

1. Resolve and load the exact `tbcli` dependency.
2. Resolve the requested shop to one stable shop key and the requested period to one complete `YYYY-MM`.
3. Resolve and load the exact `compact-commerce-ui` dependency.
4. Discover the live `commerce-ui` CLI, require the `monthly-profit-review` template pack, and read its current schema.
5. Preflight the HTML output path. Refuse to overwrite an existing file. Create a temporary directory for the intermediate ViewModel.
6. Build the business ViewModel from the stable tbcli capability:

   ```bash
   node scripts/build-viewmodel.mjs \
     --shop-key '<店铺键>' \
     --month '<YYYY-MM>' \
     --out '<临时目录>/profit-report.viewmodel.json' \
   ```

7. Require `calculationPerformed:true`, exactly one shop row, owner and product sections, and passed reconciliation within the declared tolerance. If `blockingGaps` is non-empty, stop with `PROFIT_DATA_INCOMPLETE`.
   Require product-image URL coverage for the interactive product tables. Missing URLs remain `PRODUCT_IMAGE_URL_MISSING`; show an explicit placeholder and coverage note, and do not download images or invent URLs.
8. Render and validate only through the presentation dependency:

   ```bash
   commerce-ui render \
     --template monthly-profit-review \
     --input '<临时目录>/profit-report.viewmodel.json' \
     --output '<新文件.html>'
   commerce-ui validate --template monthly-profit-review --json '<新文件.html>'
   ```

9. For `provisional`, retain the visible estimate badge and every estimated/reference amount. For `actual/reconciled`, retain the reconciled badge.
10. Inspect the real HTML on desktop and narrow viewport: it opens; every real owner has an independent page with a sticky owner title; exceptional non-owner groups have a separate page; owner and whole-shop product tables show linked thumbnails, keep their table header visible below the sticky top bar and current view title while scrolling vertically, place `退款后付费占比 = 推广费 ÷ 净销售额` immediately after the owner column, search by product name/ID, sort the full result before pagination, and display 50 products per page.
11. Return the clickable HTML path, validation result, status, whole-shop profit and margin, owner count, product count, and material quality notes.

## Analysis rules

- Use the shop row as the authoritative total. Do not derive it by summing displayed, rounded owner or product rows.
- Profit margin is total actual profit divided by total net sales; never average row-level margins.
- Treat `无法归属`, `未分配负责人`, `已下架未分配`, and `不归属负责人` as explicit groups. Do not silently merge them into named employees.
- Rank owner and product gains/losses by actual-profit amount. Use margin as supporting context, not as the sole rank.
- Explain loss from observed components such as goods cost, freight, advertising, refunds, platform fee, and tax. Label unsupported causal explanations as questions to investigate.
- Preserve negative profit, negative net sales, negative courier adjustments, zero-value rows, and unmapped refunds.
- Do not save profit snapshots to the database. The HTML is a dated analysis artifact built from the live read-only calculation.

## ViewModel contract

Read [references/report-contract.md](references/report-contract.md) before changing the report's business content mapping. The bundled script owns only tbcli-to-ViewModel transformation. HTML, CSS, JavaScript, responsive behavior, printing, routing, component rendering, and deterministic HTML validation belong exclusively to `compact-commerce-ui` and its selected template pack.

## Patches and return to main line

- Missing tbcli capability or incompatible business schema: stop with the explicit dependency error, update tbcli in a separately authorized plugin-development task, then return to Main Line step 1.
- Missing UI capability or incompatible ViewModel schema: stop with the explicit dependency error, follow `compact-commerce-ui` to update or create a reusable template pack, then return to Main Line step 3.
- Rounding reconciliation over tolerance: stop with `RECONCILIATION_FAILED`; do not hide the difference with an invented adjustment.
- Empty owner or product section: keep the shop facts, mark the report incomplete, and return to Main Line step 7.
- ViewModel, render, validation, or browser inspection failure: preserve the deterministic error evidence, repair the owning layer, and return to Main Line step 6 or 8 as appropriate.

## Evolution

User feedback on business interpretation, ranking, or content mapping belongs in this Skill and its ViewModel adapter. Business formula changes belong in tbcli's actual-profit policy. Visual language, components, layout, interaction, HTML, or validation changes belong in `compact-commerce-ui` or a reusable template pack managed by it. Forward-test material changes in a clean conversation with a real month and inspect the rendered file before calling them complete.
