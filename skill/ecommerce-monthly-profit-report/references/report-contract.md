# Profit report ViewModel mapping

This reference defines business content, not HTML implementation. The live selected `commerce-ui` template schema is authoritative for ViewModel structure and presentation behavior.

## Required views

1. `overview`: report identity, status, authoritative whole-shop totals, executive conclusions, expense structure, and the complete shop profit statement.
2. `owner-comparison`: compare only real responsible owners; exceptional ownership groups are excluded.
3. One independent view per responsible owner: a sticky title identifies the current owner, followed by that owner's summary and complete product table.
4. `unowned`: `无法归属`, `未分配负责人`, `已下架未分配`, `不归属负责人`, and similar non-owner groups and products.
5. `products`: the complete whole-shop product profit table with an owner column.
6. `quality`: blocking/advisory gaps, actual and estimated freight, unmapped refunds, missing cost count, reconciliation evidence, formula, policy rates, allocation method, and financial-statement boundary.

## Data mapping rules

- `sections.shop[0]` is the authoritative report total.
- `sections.owners` and `sections.products` explain attribution; their rounded display values do not replace the shop total.
- Product detail has exactly one row per product ID. Historical title, SKU, or owner variants never create additional rows. Use the latest authoritative product-mapping title when available; otherwise use the title from the most recent transaction date.
- Currency displays two decimals and thousands separators. Ratios display two percentage decimals.
- Profit amount determines gain/loss ranking. Margin is supporting context.
- Owner groups remain explicit, including unassigned, delisted, non-owner, or otherwise exceptional groups.
- Product tables include a remote HTTPS thumbnail, owner, 退款后付费占比, product name and ID, revenue, refunds, net sales, cost, freight, advertising, profit, and margin.
- `退款后付费占比 = 推广费 ÷ 净销售额`，其中净销售额为实付收入减退款。净销售额为零时显示空值；其他正负结果按真实值保留。
- 退款后付费占比紧跟在负责人列右侧，并与其他字段一样参与完整筛选结果的全局排序。
- Every owner table contains all of that owner's products. The whole-shop table contains all products.
- Product search matches product name or product ID.
- Every displayed field can be sorted; sorting applies to the complete filtered result before pagination.
- Pagination is fixed at 50 products per page.
- While the page scrolls vertically, each product table header stays visible below the sticky top bar and current view title, and releases when the table ends.
- Missing image URLs are counted as `PRODUCT_IMAGE_URL_MISSING` and rendered with an explicit placeholder until a stable product-catalog source supplies the remote URL.
- Provisional reports disclose every estimated or reference amount and remain visibly provisional.
- Quality messages retain stable machine codes so readers can trace them back to tbcli output.

## Presentation ownership

- The adapter emits `monthly-profit-review@1.0` ViewModel JSON for the `monthly-profit-review` template pack.
- `compact-commerce-ui` and the selected template pack own HTML, CSS, JavaScript, navigation, search, tabs, responsive layout, print behavior, asset handling, and validation.
- This Skill must not contain a private HTML renderer, copied template, copied CSS/JavaScript, or a replacement validator.
- Product images remain HTTPS links rendered by the browser. They are not downloaded or embedded. Scripts, stylesheets, fonts, and other rendering dependencies remain local to the report.

## Content boundaries

- The report is an operating-profit analysis, not a statutory financial statement or platform settlement statement.
- Do not claim causation from correlation. Describe observed cost composition and phrase unsupported explanations as follow-up questions.
- Do not reveal database connection details, credentials, private filesystem paths, raw source payloads, or unrelated customer/order information.
