# Guarded Warehouse SQL Query

Use this branch for a physical warehouse relation such as versioned master data, a cross-table question, or a query the single-dataset semantic command cannot express.

Read the [guarded physical-table command contract](../command-reference.md#guarded-physical-table-queries) before execution, then return here.

## Main Flow

1. Run `tbcli capabilities --json`, `tbcli db network --json`, `tbcli db access-check --json`, and `tbcli db status --json`. Stop with `DATABASE_UNAVAILABLE` or `PERMISSION_REQUIRED` when applicable.
2. Run `tbcli db tables --json`, optionally narrowed by `--schema` or `--keyword`. Only returned relations are candidates.
3. Run `tbcli db describe --relation '<schema.table>' --json` for every relation used. Derive columns, types, keys, and joins only from these live results.
4. Build one parameterized `SELECT`, `WITH ... SELECT`, `UNION`, or `VALUES` statement. Qualify physical relations with their schema, use explicit columns, put user-supplied values in `$1`, `$2`, and so on, and pass those values with `--params-json`.
5. Save the query to a new temporary file and run:

```bash
tbcli db sql --sql-file '<new-query.sql>' --params-json '<JSON array>' --limit '<1-1000>' --json
```

6. Require `readOnly: true`; report the relations, business filters, returned row count, truncation state, and interpretation. Show SQL only when the user asks for it.

## Boundaries

- “All tables” means all business tables and views the current database identity can `SELECT`; never seek a stronger credential to bypass a denial.
- Do not query system catalogs, permission tables, credentials, secrets, or personal contact/address fields. If a legitimate request needs sensitive data, stop and require the applicable authorization and data-minimization rule.
- The CLI accepts only one read query, executes it in a read-only transaction, applies timeout and row limits, and lets PostgreSQL enforce table and row permissions.
- If a relation or column is absent from live discovery, return `CONTRACT_UNSUPPORTED`; do not guess it.
- Zero rows means the current filters returned no data. A truncated result is not a complete population.

Return to **Company Warehouse Flow → Warehouse QA and handoff** after a successful query.
