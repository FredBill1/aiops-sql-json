# Changelog

## Unreleased

- Fixed regular `.sql` files not activating diagnostics when opened before any `sql-json` document.

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
