# 预策类目月数据增量入库

Use this branch when the user asks to import yccli first-, second-, or third-category
monthly data into the company warehouse. The canonical source is the JSON
artifact produced by `yccli industry first-category-monthly`,
`yccli industry second-category-monthly`, or
`yccli industry third-category-monthly`; the corresponding Excel may be a
one-sheet presentation copy but is not the import source.

## Main line

1. Resolve all explicit input paths, check file existence and metadata, and
   confirm the requested category and inclusive months. Do not overwrite source
   files. For a 24-month request ending in the latest completed month, require
   exactly 24 contiguous month keys in every input.
2. Run `tbcli yuce categories validate --input '<yccli-export.json>' --json`
   for each first/second/third-category source. Verify the level, parent path, first
   and last month, month count and row count. Independently reconcile third
   category monthly sums to their second category, and second-category sums
   to an available first-category monthly source.
3. Check `tbcli db status --json`, `tbcli db access-check --json`, and
   `tbcli db write-check --json`. Require a maintainer configuration and a
   rolled-back write probe with no residue. Do not create or replace a database
   configuration in this branch.
4. Import any missing first-category months, then the second-category file,
   then each third-category file:

   ```bash
   tbcli yuce categories import --input '<yccli-export.json>' --json
   ```

   Each file is one transaction. The importer matches category paths, compares
   overlapping month values, preserves identical existing rows and their
   provenance, and inserts only missing rows. An overlap conflict rolls back
   that file without replacing history. Report successful files and any failed
   file separately; do not retry successful files merely because another
   import failed.
5. Verify the physical `market.yuce_categories`,
   `market.yuce_category_monthly`, and `market.yuce_import_batches` tables via
   tbcli's guarded read-only discovery/query flow. Check the requested month
   coverage, expected hierarchy, row counts and source batch range, then
   return to the parent Skill's warehouse QA and handoff.

## Boundaries

- Import only data the user authorized and yccli collected from the logged-in
  account. Do not use direct provider API calls or database writes outside
  tbcli.
- The command is an additive historical import, not an update of prior values.
  A changed provider value needs a separate source-correction decision.
- The first-category data may cover a longer period. Do not shorten or rewrite
  it when adding second/third-category history.
- A source JSON can contain more months than the new database gap; report
  inserted and unchanged counts separately. A zero-insert result is a no-op,
  not proof that the requested scope is incomplete.
