# Changelog

## Unreleased

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
