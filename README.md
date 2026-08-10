# AIOps SQL JSON

A VS Code extension for AIOps Spark job configurations. It lets selected strings in `*.sql.json` files span physical lines and validates both JSON and SQL according to the platform's behavior of removing all physical line breaks before parsing JSON.

## Features

- Registers `.sql.json` as the dedicated **SQL JSON** language, avoiding multiline-string errors from VS Code's built-in JSON service.
- Validates and highlights SQL strings selected by configurable property-name patterns such as `*Sql`.
- Supports Spark, Hive, Flink, MySQL, PostgreSQL, Trino, Impala, and Generic SQL. Spark SQL is the default.
- Preserves strict JSON diagnostics, JSON Schema validation, completion, and hover information.
- Enhances regular `.sql` files by default and can be disabled when not needed.
- Warns when unindented continuation lines concatenate SQL words or when `--` comments cross physical lines.

## Installation

Run **Extensions: Install from VSIX...** in VS Code, select the generated `aiops-sql-json.vsix` from the project root, and reload the window.

For development:

```powershell
npm install
npm run build
```

Press `F5` to launch a new VS Code window with the development version installed.

## Multiline SQL

```json
{
  "jobName": "daily-training",
  "trainSql": "SELECT user_id,
      sum(amount) AS total_amount
    FROM source_table
    WHERE dt = '${biz_date}'
    GROUP BY user_id",
  "testSql": "SELECT 1"
}
```

The physical line breaks in this example are not valid standard JSON, but they match the target platform's preprocessing behavior. The platform removes line breaks while preserving indentation on the following line, leaving the whitespace that SQL needs.

The following example becomes `SELECTuser_id`, so the extension reports a warning:

```json
{
  "trainSql": "SELECT
user_id FROM source_table"
}
```

For the same reason, an SQL `--` comment does not end at the visible line boundary after the platform removes line breaks. Prefer `/* ... */` comments in multiline configurations.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `aiopsSqlJson.keyPatterns` | `["*Sql"]` | Case-sensitive full-property-name globs. Supports `*` and `?`; multiple patterns use OR semantics. |
| `aiopsSqlJson.dialect` | `"spark"` | SQL dialect used for embedded SQL and regular `.sql` files. |
| `aiopsSqlJson.plainSql.enabled` | `true` | Enables this extension's diagnostics and semantic highlighting for regular `.sql` files. |
| `aiopsSqlJson.placeholderPatterns` | `[]` | Regular expression sources for template placeholders that should be masked with equal-length text before parsing. |

Example workspace settings:

```json
{
  "aiopsSqlJson.keyPatterns": ["*Sql", "sql_*", "query?"],
  "aiopsSqlJson.dialect": "spark",
  "aiopsSqlJson.plainSql.enabled": true,
  "aiopsSqlJson.placeholderPatterns": [
    "\\$\\{[^}]+\\}",
    "#\\{[^}]+\\}",
    "\\{\\{[\\s\\S]+?\\}\\}"
  ]
}
```

Patterns run as global JavaScript regular expressions in Unicode mode. Matches are replaced with equal-length text before SQL parsing, so diagnostic locations remain stable. Invalid patterns and patterns that match an empty string are ignored with a warning.

## JSON Schema

The extension supports `$schema` declarations in files and existing `json.schemas` settings:

```json
{
  "json.schemas": [
    {
      "fileMatch": ["/*.sql.json"],
      "url": "./schemas/spark-job.schema.json"
    }
  ]
}
```

Inline schemas, local and relative schemas, HTTP(S) schemas, and schemas contributed by other extensions through `jsonValidation` are supported. Remote downloads respect `json.schemaDownload.enable` and are disabled in untrusted workspaces.

JSON Schema completion and hover information are suppressed inside recognized SQL strings. The current version does not provide database-aware table or column completion and does not format `.sql.json` files, preventing formatting from damaging the platform-specific multiline-string representation.

## Development and verification

```powershell
npm run check
npm run test:unit
npm run test:integration
npm run package
```

- `check`: runs TypeScript and ESLint checks.
- `test:unit`: tests projection, position mapping, all eight dialects, placeholders, and JSON Schema behavior.
- `test:integration`: runs tests in a real VS Code Extension Host.
- `package`: runs the complete verification suite and generates a local VSIX.

The extension identifier is `fredbill1.aiops-sql-json`.
