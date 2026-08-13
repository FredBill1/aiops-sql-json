# AIOps SQL JSON

A VS Code extension for AIOps Spark job configurations. It lets strings in `*.sql.json` files span physical lines, accepts configurable template placeholders throughout the document, and validates both JSON and SQL according to the platform's behavior of removing all physical line breaks before parsing JSON.

## Features

- Registers `*.sql.json` as the dedicated **SQL JSON** language without requiring a `files.associations` setting.
- Allows every JSON string to span physical lines by default while using property-name patterns only to identify embedded SQL.
- Accepts configurable placeholders in strings, bare values, unquoted property keys, and embedded bare tokens.
- Validates and highlights SQL strings selected by configurable property-name patterns such as `*Sql`.
- Completes dialect keywords, built-in functions, configured UDFs, and context-relevant fields in both regular SQL and embedded SQL strings.
- Gives recognized SQL strings code-like pair editing for brackets and quotes, including overtyping, pair deletion, selection surrounding, and JSON-safe escaped double quotes.
- Colorizes nested SQL bracket pairs using the active VS Code theme and supports jumping between matching SQL brackets.
- Maps the standard comment shortcuts to safe `/* ... */` comments inside recognized SQL strings.
- Supports Spark, Hive, Flink, MySQL, PostgreSQL, Trino, Impala, and Generic SQL. Spark SQL is the default.
- Preserves strict JSON diagnostics, JSON Schema validation, completion, and hover information.
- Enhances regular `.sql` files by default and can be disabled when not needed.
- Optionally builds an offline Schema from workspace DDL and strictly checks table, column, function, projection-count, and safely inferable type references.
- Provides AST-based SQL Hover and Go to Definition for local query symbols, plus cross-file DDL navigation when the offline Schema is enabled.
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
| `aiopsSqlJson.plainSql.enabled` | `true` | Enables this extension's diagnostics, semantic highlighting, completion, Hover, and definitions for regular `.sql` files. |
| `aiopsSqlJson.schemaValidation.enabled` | `false` | Enables strict offline Schema completion and validation. No database connection or SQL execution is performed. |
| `aiopsSqlJson.schemaValidation.completionOnly` | `false` | Keeps Schema-aware completion while suppressing all Schema-derived query and DDL diagnostics. Has no effect unless Schema validation is enabled. |
| `aiopsSqlJson.schemaFiles` | `["${workspaceFolder}/schema/*.sql"]` | Globs for `.sql` files containing explicit tables and inferable views. Relative globs are resolved from the resource's workspace folder. |
| `aiopsSqlJson.udfs` | `[]` | Simple or qualified UDF names offered by completion and accepted by Schema validation. |
| `aiopsSqlJson.placeholderPatterns` | `["\\$\\{[^}]+\\}", "\\$\\w+"]` | Regular expression sources for template placeholders that should be masked with equal-length text before parsing. |
| `aiopsSqlJson.placeholders.allowEverywhere` | `true` | Accepts matching placeholders in strings, unquoted property keys, and bare JSON tokens throughout SQL JSON documents. |

Example workspace settings:

```json
{
  "aiopsSqlJson.keyPatterns": ["*Sql", "sql_*", "query?"],
  "aiopsSqlJson.multilineStrings.allowAll": true,
  "aiopsSqlJson.dialect": "spark",
  "aiopsSqlJson.plainSql.enabled": true,
  "aiopsSqlJson.schemaValidation.enabled": true,
  "aiopsSqlJson.schemaValidation.completionOnly": false,
  "aiopsSqlJson.schemaFiles": ["${workspaceFolder}/schema/**/*.sql"],
  "aiopsSqlJson.udfs": ["score_udf", "analytics.normalize_score"],
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

## SQL completion and offline Schema validation

Completion is available for Spark, Hive, Flink, MySQL, PostgreSQL, Trino, Impala, and Generic SQL. Keyword and function catalogs are pinned with the extension; a lowercase first typed letter produces a lowercase candidate and an uppercase first letter produces uppercase. After whitespace, candidates follow the most recent word in the current statement; a new statement with no preceding word defaults to uppercase. Functions insert a snippet with the cursor inside `()`. Field names retain their original spelling.

With Schema validation disabled (the default), field candidates are collected from all statements in the current `.sql` file, or from all recognized SQL strings in the current `.sql.json` file. Enabling `aiopsSqlJson.schemaValidation.enabled` prioritizes fields resolved from configured DDL, CTEs, subqueries, projections, aliases, and known wildcards. Before a relation is written, or while any relation is unresolved, an unqualified expression also offers every field in the currently effective DDL Schema plus current-file field symbols. Qualified expressions never guess fields for an unknown qualifier. In `FROM`, `JOIN`, and other relation-name positions, completion offers tables, views, and valid keywords without scalar functions, UDFs, or fields. Configuration changes, matching DDL changes, and Schema directory creation, deletion, or rename are picked up without reloading the extension.

Set `aiopsSqlJson.schemaValidation.completionOnly` to `true` to retain all of that Schema-aware completion while suppressing every Schema-derived query and DDL diagnostic. Regular SQL syntax, JSON, multiline-string, placeholder, and platform diagnostics remain unchanged. Use **AIOps SQL JSON: Force Rebuild Schema Index** from the Command Palette to discard and rebuild every cached Schema index when automatic file watching misses an external or unusual filesystem change; the command is available only while Schema validation is enabled.

Schema globs support `${workspaceFolder}`, `${workspaceFolder:Name}`, `${workspaceFolderBasename}`, `${userHome}`, `${file}`, `${fileWorkspaceFolder}`, `${relativeFile}`, `${relativeFileDirname}`, `${fileBasename}`, `${fileBasenameNoExtension}`, `${fileExtname}`, `${fileDirname}`, `${fileDirnameBasename}`, `${cwd}`, `${execPath}`, `${pathSeparator}`, `${/}`, and `${env:NAME}`. Relative globs remain relative to the current resource's workspace folder, or its directory outside a workspace. Variables that are unknown, empty, or refer to a missing named workspace cause that glob entry to be ignored with a warning. Interactive and task variables such as `command`, `input`, `config`, cursor, and selection variables are not evaluated.

Schema files may contain multiple explicit `CREATE TABLE` and inferable `CREATE VIEW ... AS SELECT` statements. Their declarations are merged workspace-wide: tables are indexed first and view dependencies are then resolved without relying on file order. `DROP` statements in Schema files are ignored. Invalid DDL, CTAS without an explicit column list, unresolved views, cycles, and duplicate table/view names are reported on the source DDL and excluded from the index. Qualified names match exactly; an unqualified object name must uniquely identify one object. An empty `schemaFiles` list is valid and uses an empty global Schema.

In other SQL files, DDL follows source order within that file. Explicit `CREATE [TEMPORARY] TABLE`, `DROP TABLE`, `CREATE [TEMPORARY] VIEW`, and `DROP VIEW` update the Schema seen by later statements. Temporary objects may shadow global objects and reveal them again when dropped. Each recognized SQL string in a `.sql.json` file has its own isolated DDL sequence. `IF EXISTS` and `IF NOT EXISTS` suppress the corresponding missing or duplicate-object error.

The strict checker covers SELECT, INSERT, UPDATE, DELETE, and MERGE references, including joins, CTEs, nested and correlated subqueries, unknown or ambiguous fields, INSERT/UNION projection counts, and type compatibility where both sides are safely known. Its dialect adapters derive references from parser contexts instead of treating every identifier token as a field. Spark complex values from DDL types, `from_json`, `struct`, and `named_struct` retain known nested fields, and `explode`/`posexplode` outputs participate in scope resolution. Configuration and administration statements such as Spark `SET` receive syntax validation but are not treated as table/field expressions.

Functions absent from the pinned built-in catalog and `aiopsSqlJson.udfs` produce a warning because an offline checker cannot distinguish every server-side UDF or engine-version addition. UDF return types and function arity remain unknown and do not cause cascading type errors. Statements with syntax errors skip semantic validation. A relation name containing a configured placeholder is treated as dynamic and produces no relation or dependent-field diagnostic. Dialect-native aliases remain valid; for example, Spark accepts both `expression alias` and `expression AS alias`.

This is a static, offline approximation of whether a statement can execute. It does not connect to a database and cannot verify permissions, live catalogs, data, engine configuration, execution plans, runtime temporary objects, `ALTER TABLE`, or UDF signatures.

## SQL Hover and Go to Definition

Hover and Go to Definition use the same normalized AST, recursive scopes, and inferred types as the offline checker. They work in regular `.sql` documents and inside SQL JSON strings selected by `aiopsSqlJson.keyPatterns`; JSON escape sequences and physical multiline-string positions are mapped back to the original document. Hover shows the symbol kind, qualified name, inferred recursive type, and source. Relation summaries show at most 20 fields, nested types expand to at most four levels, and omitted fields are counted.

Local symbols do not require `aiopsSqlJson.schemaValidation.enabled`. This includes CTEs, derived tables, projection aliases, Lambda parameters, local DDL, and generator outputs such as `POSEXPLODE`, `UNNEST`, `JSON_TABLE`, ordinality, typed PostgreSQL records, and Impala collection iteration. Cross-file table, view, column, and recursive field information comes from `aiopsSqlJson.schemaFiles`, so those targets are available only while Schema validation is enabled. `schemaValidation.completionOnly` suppresses diagnostics but does not disable Hover or definitions. Setting `plainSql.enabled` to `false` disables these providers in regular `.sql` files.

Definitions are lexical-first. For example, a reference to `r.total` from a CTE jumps to that CTE's projection alias; invoking Go to Definition again on the alias follows the underlying expression or DDL column. Relation aliases and Lambda parameters behave the same way. `USING` columns, ambiguous unqualified columns, and UNION outputs may return multiple same-level targets. Built-in functions and name-only configured UDFs have Hover information but no source definition.

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

JSON Schema completion and hover information are suppressed inside recognized SQL strings. The extension does not format `.sql.json` files, preventing formatting from damaging the platform-specific multiline-string representation.

## Development and verification

```powershell
npm run check
npm run test:unit
npm run test:integration
npm run package
```

- `check`: runs TypeScript and ESLint checks.
- `test:unit`: tests projection, position mapping, all eight dialects, completion catalogs, placeholders, structural and Schema SQL checks, and JSON Schema behavior.
- `test:integration`: runs tests in a real VS Code Extension Host.
- `package`: runs the complete verification suite and generates a local VSIX.

The extension identifier is `fredbill1.aiops-sql-json`.
