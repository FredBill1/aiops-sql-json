# AIOps SQL JSON

A VS Code extension for AIOps Spark job configurations. It lets strings in `*.sql.json` files span physical lines, accepts configurable template placeholders throughout the document, and validates both JSON and SQL according to the platform's behavior of removing all physical line breaks before parsing JSON.

## Features

- Registers `*.sql.json` as the dedicated **SQL JSON** language without requiring a `files.associations` setting.
- Allows every JSON string to span physical lines by default while using property-name patterns only to identify embedded SQL.
- Accepts configurable placeholders in strings, bare values, unquoted property keys, and embedded bare tokens.
- Validates and highlights SQL strings selected by configurable property-name patterns such as `*Sql`.
- Gives recognized SQL strings code-like pair editing for brackets and quotes, including overtyping, pair deletion, selection surrounding, and JSON-safe escaped double quotes.
- Colorizes nested SQL bracket pairs using the active VS Code theme and supports jumping between matching SQL brackets.
- Maps the standard comment shortcuts to safe `/* ... */` comments inside recognized SQL strings.
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

## Multiline strings and SQL

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

The physical line breaks in this example are not valid standard JSON, but they match the target platform's preprocessing behavior. The platform removes line breaks while preserving indentation on the following line, leaving the whitespace that SQL needs. By default this behavior applies to every JSON string; only strings selected by `aiopsSqlJson.keyPatterns` receive SQL validation and semantic highlighting.

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
| `aiopsSqlJson.multilineStrings.allowAll` | `true` | Allows physical line breaks in every JSON string. Disable it to allow them only in SQL strings selected by `keyPatterns`. |
| `aiopsSqlJson.dialect` | `"spark"` | SQL dialect used for embedded SQL and regular `.sql` files. |
| `aiopsSqlJson.plainSql.enabled` | `true` | Enables this extension's diagnostics and semantic highlighting for regular `.sql` files. |
| `aiopsSqlJson.placeholderPatterns` | `["\\$\\{[^}]+\\}", "\\$\\w+"]` | Regular expression sources for template placeholders that should be masked with equal-length text before parsing. |
| `aiopsSqlJson.placeholders.allowEverywhere` | `true` | Accepts matching placeholders in strings, unquoted property keys, and bare JSON tokens throughout SQL JSON documents. |

Example workspace settings:

```json
{
  "aiopsSqlJson.keyPatterns": ["*Sql", "sql_*", "query?"],
  "aiopsSqlJson.multilineStrings.allowAll": true,
  "aiopsSqlJson.dialect": "spark",
  "aiopsSqlJson.plainSql.enabled": true,
  "aiopsSqlJson.placeholders.allowEverywhere": true,
  "aiopsSqlJson.placeholderPatterns": [
    "\\$\\{[^}]+\\}",
    "#\\{[^}]+\\}",
    "\\{\\{[\\s\\S]+?\\}\\}"
  ]
}
```

Patterns run as global JavaScript regular expressions in Unicode mode. Matches are replaced with equal-length text before SQL parsing, so diagnostic locations remain stable. Invalid patterns and patterns that match an empty string are ignored with a warning.

Placeholders may also stand in for JSON tokens without quotes:

```json
{
  "key1": $value,
  "key2": ${value2},
  $dynamicKey: prefix_$suffix
}
```

The JSON projection uses same-length synthetic keys or values so syntax locations remain stable. Schema diagnostics that depend on a dynamic key or value are suppressed, while diagnostics for known surrounding properties remain active. A placeholder represents one lexical token; it is not interpreted as a comma, colon, or a fragment that expands to multiple JSON properties.

In SQL, placeholders normally use an identifier-shaped mask. A placeholder immediately followed by a decimal fraction uses a numeric mask, so expressions such as `value > $limit.0` validate correctly.

## Editing embedded SQL

The extension applies SQL editing behavior only to direct string values whose property names match `aiopsSqlJson.keyPatterns`. Parentheses, square brackets, braces, single quotes, and backticks close in pairs; typing a closing delimiter over an existing one advances the cursor, Backspace removes an empty pair, and typing an opening delimiter around a selection surrounds it.

Because the outer document is JSON, typing a double quote inside recognized SQL inserts the JSON-safe source text `\"\"` and leaves the cursor between the two decoded SQL quotes. The behavior follows VS Code's `editor.autoClosingBrackets`, `editor.autoClosingQuotes`, `editor.autoSurround`, `editor.autoClosingDelete`, and `editor.autoClosingOvertype` settings.

When `editor.bracketPairColorization.enabled` is enabled, recognized SQL brackets use the active theme's bracket colors. The standard matching-bracket shortcut (`Ctrl+Shift+\` on Windows/Linux or `Cmd+Shift+\` on macOS) works inside these strings. The standard line and block comment shortcuts create `/* ... */` comments because `--` comments can cross physical lines after the target platform removes line endings.

The matched regions are computed dynamically, so changing `aiopsSqlJson.keyPatterns` takes effect without reloading VS Code. VS Code does not expose a way to assign a native embedded-language ID to dynamically computed ranges; native bracket guide lines and automatic integration with unrelated SQL extensions therefore remain unavailable inside `.sql.json` strings.

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
- `test:unit`: tests projection, position mapping, all eight dialects, placeholders, structural SQL checks, and JSON Schema behavior.
- `test:integration`: runs tests in a real VS Code Extension Host.
- `package`: runs the complete verification suite and generates a local VSIX.

The extension identifier is `fredbill1.aiops-sql-json`.
