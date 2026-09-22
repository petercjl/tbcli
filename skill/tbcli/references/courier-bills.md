# Courier bills

Input: authorized XLSX files, explicit carrier (`sto`, `yunda`, `jt`, `sf`) and
bill month (`YYYY-MM`). Output: uniform charge facts, provenance, idempotent
batch result and read-only per-waybill totals. No browser is required.

1. Discover `tbcli profit freight` in live help/capabilities.
2. Run `tbcli profit freight validate --input <FILE> --carrier <CARRIER> --bill-month <MONTH> --json` for every source first. Require `ok: true`, nonzero detail count and review dates outside the bill month. A supplied month identifies the bill, not necessarily every charge date.
3. With explicit import authority and a working maintainer configuration, run the same arguments with `profit freight import`. This transaction creates only courier tables and appends verified rows. Reader configurations cannot import. No employee grants are implicit.
4. Run `tbcli profit freight query --json` to verify carrier/month counts and amounts; `--tracking-no <NUMBER>` aggregates a waybill's signed charges separately by carrier. Report imported and already-imported batches separately. Return to delivery.

Core fields are tracking number (text), source business date and signed charge
amount. Auxiliary fields are nullable. Preserve individual charges; a waybill
can have multiple dates and service fees. Never discard rows merely because
their waybill repeats. Keep original source rows, file hash, sheet, row and
parser version. Financial decimals are preserved to eight fractional places.

Mappings: STO 应收金额 including listed supplements; Yunda 韵达运费 or 快递运费
(应收金额 is the balance after prepaid offset); J&T 合计金额 including row tax;
SF 应付金额 after discounts, with 服务 identifying charge type. SF dates without
a year use the confirmed bill month year. Do not treat 对方公司名称 as the shop.
Parse column labels, not positions. SF 淘天运单, quotes, subtotals and monthly
unallocated adjustments are outside this detail importer.

File/content hashes make identical reimports no-ops. Partial overlap and
identical charge rows stop for review, without replacing previous data. A
corrected bill requires a separately authorized correction workflow; do not
edit the source merely to defeat a conflict. Invalid dates, amounts, tracking
numbers, unknown headers, or uncached formulas fail before writes. A rollback
leaves no partial batch. Missing order matches are evaluated during profit
analysis; this importer does not change profit calculation or zero-fill
missing freight. Dates retain their source meaning.
