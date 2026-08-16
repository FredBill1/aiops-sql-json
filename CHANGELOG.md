# Changelog

## Unreleased

## 0.0.10

- Fixed incomplete `CASE` expressions, including trailing `CASE` and `CASE WHEN`, being accepted without a syntax diagnostic in dialects whose primary parser did not report them.
- Added width- and AST-depth-aware structural `CASE` formatting plus the `aiopsSqlJson.format.caseLayout` setting for always-expanded branches.

## 0.0.9

- Added atomic document formatting for regular SQL and SQL JSON, with dialect-aware token preservation, configurable line width, AST inline depth, structural parentheses, statement lists, casing, commas, logical operators, semicolons, and statement spacing.
- Added SQL JSON structure formatting with fixed or JSON-depth-aware embedded SQL indentation, next-line SQL opening layout, exact preservation of non-SQL multiline strings, and protected placeholder round trips.
- Added format-time AST and significant-token equivalence checks so a failure in any JSON or SQL region leaves the whole document unchanged.

## 0.0.8

- Fixed unsaved SQL and SQL JSON documents failing to load DDL Schema files through `${workspaceFolder}` or relative globs; untitled documents now use the first workspace folder, including its resource-scoped settings.

## 0.0.7

- Fixed false Spark INSERT column-count diagnostics by deriving static partition columns from the SQL AST, including INSERT OVERWRITE variants without the optional TABLE keyword.
- Added Spark store-assignment semantics for ANSI, LEGACY, and STRICT policies, including statement-ordered SET and RESET handling, directional scalar conversions, and recursive ARRAY, MAP, and STRUCT compatibility.
- Fixed Spark INSERT BY NAME validation to match query outputs to writable target columns by name, and stopped treating INSERT OVERWRITE DIRECTORY paths as tables while retaining source-query validation.
- Added Spark set-operation common-type inference and propagation for compatible scalar, ARRAY, MAP, and STRUCT columns without relaxing other SQL dialects.

## 0.0.6

- Removed the global typing and Backspace command overrides that could corrupt Microsoft Chinese IME composition, including after changing the document language mode.
- Switched brackets, single quotes, and backticks to VS Code's native file-wide pair editing, and stopped automatically pairing escaped double quotes inside strings.
- Kept deeply nested SQL brackets visible by cycling through the three bracket colors defined by VS Code's built-in themes.
- Fixed dynamic CTE projections suppressing known fields or producing false unknown-column diagnostics.
- Fixed a SELECT expression resolving to its own same-name projection alias instead of the underlying table column.
- Added semantic validation, Hover, and Go to Definition inside parenthesized INSERT SELECT sources.

## 0.0.5

- Added AST-based SQL Hover and Go to Definition for regular `.sql` files and recognized SQL regions in `.sql.json` files.
- Added lexical-first navigation for relation aliases, CTE and derived-table projections, nested fields, generator outputs, Lambda parameters, and local DDL, with cross-file links to indexed table, view, and column declarations.
- Added recursive type signatures and source summaries to SQL Hover, including built-in/UDF classification and bounded table/STRUCT expansion.
- Kept local AST navigation available when offline Schema validation is disabled; external DDL navigation continues to require Schema indexing, while completion-only mode retains both features.
- Added a command to force rebuilding all cached offline Schema indexes.
- Added an optional completion-only Schema mode that suppresses Schema query and DDL diagnostics.
- Rebuilt the offline Schema checker around a unified SQL AST frontend, recursive query scopes, and conservative type propagation for all eight SQL dialects.
- Added semantic validation for ordered and correlated CTEs, derived tables, JOIN USING columns, qualified wildcards, set operations, INSERT targets, and UPDATE assignments.
- Added typed relation support for EXPLODE and POSEXPLODE, UNNEST, JSON_TABLE, PostgreSQL set-returning functions, and Impala collection iteration.
- Added nested ARRAY, MAP, and STRUCT inference for DDL, `from_json`, struct constructors, expressions, aggregates, and generator functions.
- Added cross-file view dependency resolution, duplicate-column rejection, and reliable schema removal after duplicate DDL files are changed or deleted.
- Made asynchronous Schema index rebuilds atomic so completion and diagnostics keep using the previous complete snapshot until the newest generation is ready.
- Fixed valid dialect SQL being rejected because of gaps in the fallback grammar while retaining structural diagnostics for invalid SQL.
- Fixed quoted identifier matching, partition-column extraction, LATERAL VIEW outputs, and nested function validation.
- Suppressed table and dependent-column diagnostics for placeholder-based dynamic relations.
- Changed unknown-function diagnostics from errors to warnings and expanded the Spark built-in function catalog.

## 0.0.4

- Added DDL and current-file field fallback while a SELECT source is absent or unresolved.
- Removed scalar functions, UDFs, and fields from table/view completion positions such as `FROM` and `JOIN`.

## 0.0.3

- Fixed regular `.sql` files not activating diagnostics when opened before any `sql-json` document.
- Added context-aware keyword, built-in function, UDF, table, and field completion for all eight SQL dialects in `.sql` and recognized `.sql.json` strings.
- Added optional, hot-reloaded offline Schema indexing from configurable DDL globs, with strict table, field, function, scope, projection-count, and inferable type diagnostics.
- Added DDL diagnostics for invalid, implicit-CTAS, and duplicate table definitions without introducing database connectivity.
- Added source-ordered local table/view CREATE and DROP lifecycles, including temporary-object shadowing and isolated embedded SQL strings.
- Added declarative global view indexing and removed the warning for an empty Schema glob list.
- Added stable VS Code path-variable expansion for Schema globs and changed the default to `${workspaceFolder}/schema/*.sql`.

## 0.0.2

- Made `*.sql.json` default to the `sql-json` language without workspace configuration.
- Allowed multiline strings and placeholders throughout SQL JSON documents by default, with switches that restore the previous restricted behavior.
- Added same-length JSON placeholder projection with focused JSON Schema diagnostic suppression.
- Added numeric masking for placeholders followed by decimal fractions.
- Added high-confidence structural SQL diagnostics for missing relations, expressions, and boolean operands.
- Added dynamic code-like pair editing and JSON-safe double-quote insertion inside SQL strings selected by `aiopsSqlJson.keyPatterns`.
- Added theme-aware SQL bracket pair colorization, matching-bracket navigation, and safe block-comment shortcuts.

## 0.0.1

- Initial release.
- Added multiline SQL support in `.sql.json` files, selected by property-name glob patterns.
- Added eight SQL dialects, regular `.sql` file support, template placeholders, semantic highlighting, and syntax diagnostics.
- Added strict projected JSON validation, JSON Schema validation, completion, and hover support.
