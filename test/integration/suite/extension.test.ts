import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import * as vscode from 'vscode';

suite('AIOps SQL JSON extension', () => {
  let temporaryDirectory: string;
  let extension: vscode.Extension<unknown>;

  suiteSetup(async () => {
    temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'aiops-sql-json-'));
    const discoveredExtension = vscode.extensions.getExtension('fredbill1.aiops-sql-json');
    assert.ok(discoveredExtension, 'Extension must be discoverable in the extension host.');
    extension = discoveredExtension;
  });

  suiteTeardown(async () => {
    await vscode.workspace.getConfiguration('json').update('schemas', undefined, vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration('aiopsSqlJson').update('plainSql.enabled', undefined, vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration('aiopsSqlJson').update('multilineStrings.allowAll', undefined, vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration('aiopsSqlJson').update('placeholders.allowEverywhere', undefined, vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration('aiopsSqlJson').update('keyPatterns', undefined, vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration('aiopsSqlJson').update('schemaValidation.enabled', undefined, vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration('aiopsSqlJson').update('schemaFiles', undefined, vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration('aiopsSqlJson').update('udfs', undefined, vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration('aiopsSqlJson').update('dialect', undefined, vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration('editor').update('autoClosingBrackets', undefined, vscode.ConfigurationTarget.Global);
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  });

  test('activates when a regular SQL file is opened first', async () => {
    assert.equal(extension.isActive, false, 'The extension must start inactive for this regression test.');

    const document = await openFile('cold-start.sql', 'SELEC 1;');
    assert.equal(document.languageId, 'sql');

    const diagnostics = await waitForDiagnostics(
      document.uri,
      (items) => items.some((diagnostic) => diagnostic.source?.includes('SQL')),
    );
    assert.equal(extension.isActive, true, 'Opening an SQL document should activate the extension.');
    assert.ok(diagnostics.some((diagnostic) => diagnostic.source?.includes('SQL')));
  });

  test('associates .sql.json and accepts an indented multiline SQL string', async () => {
    const languageContribution = extension.packageJSON.contributes.languages[0] as { filenamePatterns?: string[] };
    const configurationDefaults = extension.packageJSON.contributes.configurationDefaults as Record<string, unknown>;
    const schemaFiles = extension.packageJSON.contributes.configuration.properties['aiopsSqlJson.schemaFiles'] as {
      default?: string[];
    };
    assert.ok(languageContribution.filenamePatterns?.includes('*.sql.json'));
    assert.deepEqual(configurationDefaults['files.associations'], { '*.sql.json': 'sql-json' });
    assert.deepEqual(schemaFiles.default, ['${workspaceFolder}/schema/*.sql']);

    const document = await openFile('valid.sql.json', `{
  "trainSql": "SELECT
    * FROM source_table"
}`);
    assert.equal(document.languageId, 'sql-json');

    const diagnostics = await waitForDiagnostics(document.uri);
    assert.equal(diagnostics.filter((diagnostic) => diagnostic.severity === vscode.DiagnosticSeverity.Error).length, 0);

    const tokens = await vscode.commands.executeCommand<vscode.SemanticTokens>(
      'vscode.provideDocumentSemanticTokens',
      document.uri,
    );
    assert.ok(tokens && tokens.data.length > 0, 'Embedded SQL should produce semantic tokens.');
  });

  test('allows multiline non-SQL strings by default and can restore the restricted behavior', async () => {
    const allowedDocument = await openFile('multiline-string.sql.json', `{
  "display
    Name": "first
    second"
}`);
    const allowedDiagnostics = await waitForDiagnostics(allowedDocument.uri);
    assert.ok(!allowedDiagnostics.some((diagnostic) => diagnostic.code === 'illegal-multiline-string'));

    await vscode.workspace.getConfiguration('aiopsSqlJson').update(
      'multilineStrings.allowAll',
      false,
      vscode.ConfigurationTarget.Global,
    );
    const restrictedDocument = await openFile('restricted-string.sql.json', `{
  "name": "first
    second"
}`);
    const restrictedDiagnostics = await waitForDiagnostics(
      restrictedDocument.uri,
      (items) => items.some((item) => item.code === 'illegal-multiline-string'),
    );
    assert.ok(restrictedDiagnostics.some((diagnostic) => diagnostic.code === 'illegal-multiline-string'));
    await vscode.workspace.getConfiguration('aiopsSqlJson').update(
      'multilineStrings.allowAll',
      undefined,
      vscode.ConfigurationTarget.Global,
    );
  });

  test('allows placeholders throughout JSON by default and can disable the projection', async () => {
    const allowedDocument = await openFile(
      'placeholders.sql.json',
      '{"key1": $value, "key2": ${value2}, $key: prefix_$suffix}',
    );
    const allowedDiagnostics = await waitForDiagnostics(allowedDocument.uri);
    assert.equal(allowedDiagnostics.filter((diagnostic) => diagnostic.severity === vscode.DiagnosticSeverity.Error).length, 0);

    await vscode.workspace.getConfiguration('aiopsSqlJson').update(
      'placeholders.allowEverywhere',
      false,
      vscode.ConfigurationTarget.Global,
    );
    const restrictedDocument = await openFile('restricted-placeholder.sql.json', '{"key": $value}');
    const restrictedDiagnostics = await waitForDiagnostics(
      restrictedDocument.uri,
      (items) => items.some((item) => item.source === 'json' || item.source === 'JSON'),
    );
    assert.ok(restrictedDiagnostics.some((diagnostic) => diagnostic.severity === vscode.DiagnosticSeverity.Error));
    await vscode.workspace.getConfiguration('aiopsSqlJson').update(
      'placeholders.allowEverywhere',
      undefined,
      vscode.ConfigurationTarget.Global,
    );
  });

  test('accepts decimal placeholders and reports structural Spark SQL errors', async () => {
    const numericDocument = await openFile(
      'numeric-placeholder.sql.json',
      '{"Sql":"select data from mytable where value > $limit.0"}',
    );
    const numericDiagnostics = await waitForDiagnostics(numericDocument.uri);
    assert.ok(!numericDiagnostics.some((diagnostic) => diagnostic.source === 'spark SQL'));

    const invalidDocument = await openFile('structural-error.sql.json', '{"Sql":"select data from where and"}');
    const invalidDiagnostics = await waitForDiagnostics(
      invalidDocument.uri,
      (items) => items.some((item) => item.source === 'spark SQL'),
    );
    assert.ok(invalidDiagnostics.some((diagnostic) => diagnostic.source === 'spark SQL'));
  });

  test('warns about platform word joins and line comments', async () => {
    const joinedDocument = await openFile('joined.sql.json', '{"trainSql":"SELECT\ncolumn_a FROM source_table"}');
    const joinedDiagnostics = await waitForDiagnostics(
      joinedDocument.uri,
      (items) => items.some((item) => item.code === 'joined-by-platform'),
    );
    assert.ok(joinedDiagnostics.some((diagnostic) => diagnostic.code === 'joined-by-platform'));

    const commentDocument = await openFile(
      'line-comment.sql.json',
      '{"trainSql":"SELECT 1 -- comment\n    FROM source_table"}',
    );
    const commentDiagnostics = await waitForDiagnostics(
      commentDocument.uri,
      (items) => items.some((item) => item.code === 'line-comment-crosses-line'),
    );
    assert.ok(commentDiagnostics.some((diagnostic) => diagnostic.code === 'line-comment-crosses-line'));
  });

  test('maps embedded SQL errors back to their physical line', async () => {
    const document = await openFile('invalid-sql.sql.json', `{
  "trainSql": "SELECT
    ) FROM source_table"
}`);
    const diagnostics = await waitForDiagnostics(
      document.uri,
      (items) => items.some((item) => item.source === 'spark SQL'),
    );
    const sqlDiagnostic = diagnostics.find((diagnostic) => diagnostic.source === 'spark SQL');
    assert.ok(sqlDiagnostic);
    assert.ok(sqlDiagnostic.range.start.line >= 1);
  });

  test('provides dynamic SQL pair editing without changing unmatched strings', async () => {
    await vscode.workspace.getConfiguration('aiopsSqlJson').update(
      'keyPatterns',
      ['query', '*Sql'],
      vscode.ConfigurationTarget.Global,
    );
    const document = await openFile(
      'pair-editing.sql.json',
      '{"query":"SELECT ","name":"plain","otherSql":"FROM "}',
    );
    const editor = activeEditorFor(document);

    setCaret(editor, document.getText().indexOf('SELECT ') + 'SELECT '.length);
    await vscode.commands.executeCommand('type', { text: '(' });
    assert.equal(document.getText(), '{"query":"SELECT ()","name":"plain","otherSql":"FROM "}');

    await vscode.commands.executeCommand('type', { text: ')' });
    assert.equal(document.getText(), '{"query":"SELECT ()","name":"plain","otherSql":"FROM "}');
    assert.equal(document.offsetAt(editor.selection.active), document.getText().indexOf('SELECT ()') + 'SELECT ()'.length);

    const emptyPairCaret = document.getText().indexOf('SELECT ()') + 'SELECT ('.length;
    setCaret(editor, emptyPairCaret);
    await vscode.commands.executeCommand('aiopsSqlJson.deleteLeft');
    assert.equal(document.getText(), '{"query":"SELECT ","name":"plain","otherSql":"FROM "}');

    setCaret(editor, document.getText().indexOf('plain') + 'plain'.length);
    await vscode.commands.executeCommand('type', { text: '(' });
    assert.equal(document.getText(), '{"query":"SELECT ","name":"plain(","otherSql":"FROM "}');

    const queryCaret = document.getText().indexOf('SELECT ') + 'SELECT '.length;
    const otherCaret = document.getText().indexOf('FROM ') + 'FROM '.length;
    editor.selections = [
      new vscode.Selection(document.positionAt(queryCaret), document.positionAt(queryCaret)),
      new vscode.Selection(document.positionAt(otherCaret), document.positionAt(otherCaret)),
    ];
    await vscode.commands.executeCommand('type', { text: '{' });
    assert.ok(document.getText().includes('SELECT {}'));
    assert.ok(document.getText().includes('FROM {}'));
  });

  test('escapes SQL double quotes and surrounds selected SQL text', async () => {
    const document = await openFile('quote-editing.sql.json', '{"trainSql":"SELECT value "}');
    const editor = activeEditorFor(document);
    const valueStart = document.getText().indexOf('value');
    editor.selection = new vscode.Selection(
      document.positionAt(valueStart),
      document.positionAt(valueStart + 'value'.length),
    );
    await vscode.commands.executeCommand('type', { text: "'" });
    assert.equal(document.getText(), '{"trainSql":"SELECT \'value\' "}');
    assert.equal(document.getText(editor.selection), 'value');

    setCaret(editor, document.getText().indexOf(' "}') + 1);
    await vscode.commands.executeCommand('type', { text: '"' });
    assert.equal(document.getText(), String.raw`{"trainSql":"SELECT 'value' \"\""}`);
    assert.equal(document.offsetAt(editor.selection.active), document.getText().indexOf(String.raw`\"\"`) + 2);

    const manualEscapeDocument = await openFile('manual-escape.sql.json', '{"trainSql":"SELECT "}');
    const manualEscapeEditor = activeEditorFor(manualEscapeDocument);
    setCaret(
      manualEscapeEditor,
      manualEscapeDocument.getText().indexOf('SELECT ') + 'SELECT '.length,
    );
    await vscode.commands.executeCommand('type', { text: '\\' });
    await vscode.commands.executeCommand('type', { text: '"' });
    assert.equal(manualEscapeDocument.getText(), String.raw`{"trainSql":"SELECT \"\""}`);
  });

  test('applies key pattern changes to editing without a reload', async () => {
    const document = await openFile('dynamic-pattern.sql.json', '{"query":"SELECT ","trainSql":"FROM "}');
    const editor = activeEditorFor(document);
    await vscode.workspace.getConfiguration('aiopsSqlJson').update(
      'keyPatterns',
      ['query'],
      vscode.ConfigurationTarget.Global,
    );
    setCaret(editor, document.getText().indexOf('SELECT ') + 'SELECT '.length);
    await vscode.commands.executeCommand('type', { text: '[' });
    assert.ok(document.getText().includes('SELECT []'));

    await vscode.workspace.getConfiguration('aiopsSqlJson').update(
      'keyPatterns',
      ['*Sql'],
      vscode.ConfigurationTarget.Global,
    );
    setCaret(editor, document.getText().indexOf('SELECT []') + 'SELECT []'.length);
    await vscode.commands.executeCommand('type', { text: '{' });
    assert.ok(document.getText().includes('SELECT []{'));

    setCaret(editor, document.getText().indexOf('FROM ') + 'FROM '.length);
    await vscode.commands.executeCommand('type', { text: '{' });
    assert.ok(document.getText().includes('FROM {}'));
  });

  test('respects disabled bracket autoclosing', async () => {
    await vscode.workspace.getConfiguration('editor').update(
      'autoClosingBrackets',
      'never',
      vscode.ConfigurationTarget.Global,
    );
    const document = await openFile('disabled-pairs.sql.json', '{"trainSql":"SELECT "}');
    const editor = activeEditorFor(document);
    setCaret(editor, document.getText().indexOf('SELECT ') + 'SELECT '.length);
    await vscode.commands.executeCommand('type', { text: '(' });
    assert.equal(document.getText(), '{"trainSql":"SELECT ("}');
    await vscode.workspace.getConfiguration('editor').update(
      'autoClosingBrackets',
      undefined,
      vscode.ConfigurationTarget.Global,
    );
  });

  test('jumps between SQL brackets and toggles safe block comments', async () => {
    const document = await openFile('editing-commands.sql.json', '{"trainSql":"SELECT (a + (b))"}');
    const editor = activeEditorFor(document);
    const opening = document.getText().indexOf('(');
    setCaret(editor, opening);
    await vscode.commands.executeCommand('aiopsSqlJson.jumpToMatchingSqlBracket');
    assert.equal(document.offsetAt(editor.selection.active), document.getText().lastIndexOf(')'));

    setCaret(editor, document.getText().indexOf('SELECT'));
    await vscode.commands.executeCommand('aiopsSqlJson.toggleSqlLineComment');
    assert.equal(document.getText(), '{"trainSql":"/* SELECT (a + (b)) */"}');
    await vscode.commands.executeCommand('aiopsSqlJson.toggleSqlLineComment');
    assert.equal(document.getText(), '{"trainSql":"SELECT (a + (b))"}');
  });

  test('uses json.schemas for projected schema validation', async () => {
    await vscode.workspace.getConfiguration('json').update('schemas', [{
      fileMatch: ['*.sql.json'],
      schema: {
        type: 'object',
        required: ['jobName'],
        properties: {
          jobName: { enum: ['daily'], description: 'Job name' },
          attempts: { type: 'number' },
        },
      },
    }], vscode.ConfigurationTarget.Global);

    const document = await openFile('schema.sql.json', '{"trainSql":"SELECT 1"}');
    const diagnostics = await waitForDiagnostics(
      document.uri,
      (items) => items.some((item) => item.message.includes('jobName')),
    );
    assert.ok(diagnostics.some((diagnostic) => diagnostic.message.includes('jobName')));

    const completionDocument = await openFile('schema-completion.sql.json', '{"jobName":"","trainSql":"SELECT 1"}');
    const completionPosition = completionDocument.positionAt(completionDocument.getText().indexOf('"jobName":"') + 11);
    const completionList = await vscode.commands.executeCommand<vscode.CompletionList>(
      'vscode.executeCompletionItemProvider',
      completionDocument.uri,
      completionPosition,
    );
    assert.ok(completionList.items.some((item) => item.label.toString().includes('daily')));

    const hoverPosition = completionDocument.positionAt(completionDocument.getText().indexOf('jobName') + 2);
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      completionDocument.uri,
      hoverPosition,
    );
    assert.ok(hovers.some((hover) => hover.contents.some((content) => (
      typeof content === 'string' ? content : content.value
    ).includes('Job name'))));

    const dynamicValueDocument = await openFile('schema-placeholder-value.sql.json', '{"jobName":$jobName}');
    const dynamicValueDiagnostics = await waitForDiagnostics(dynamicValueDocument.uri);
    assert.ok(!dynamicValueDiagnostics.some((diagnostic) => diagnostic.message.includes('accepted')));

    const dynamicKeyDocument = await openFile(
      'schema-placeholder-key.sql.json',
      '{$key:"daily","attempts":"bad"}',
    );
    const dynamicKeyDiagnostics = await waitForDiagnostics(
      dynamicKeyDocument.uri,
      (items) => items.some((item) => item.message.includes('Expected "number"')),
    );
    assert.ok(!dynamicKeyDiagnostics.some((diagnostic) => diagnostic.message.includes('Missing property "jobName"')));
    assert.ok(dynamicKeyDiagnostics.some((diagnostic) => diagnostic.message.includes('Expected "number"')));
  });

  test('can disable diagnostics for plain SQL files', async () => {
    const document = await openFile('plain.sql', 'SELEC 1;');
    const enabledDiagnostics = await waitForDiagnostics(document.uri, (items) => items.length > 0);
    assert.ok(enabledDiagnostics.some((diagnostic) => diagnostic.source?.includes('SQL')));

    await vscode.workspace.getConfiguration('aiopsSqlJson').update(
      'plainSql.enabled',
      false,
      vscode.ConfigurationTarget.Global,
    );
    const disabledDiagnostics = await waitForDiagnostics(document.uri, (items) => items.length === 0);
    assert.equal(disabledDiagnostics.length, 0);
    await vscode.workspace.getConfiguration('aiopsSqlJson').update(
      'plainSql.enabled',
      undefined,
      vscode.ConfigurationTarget.Global,
    );
  });

  test('completes dialect keywords, functions, and fields seen in the current file', async () => {
    const lowerDocument = await openFile(
      'completion-lower.sql',
      'SELECT customer_id FROM orders;\nse',
    );
    const lowerItems = await completionItemsAtEnd(lowerDocument);
    assert.ok(
      lowerItems.some((item) => completionLabel(item) === 'select'),
      `Expected lowercase SELECT completion, got: ${lowerItems.map(completionLabel).slice(0, 40).join(', ')}`,
    );

    const fieldDocument = await openFile(
      'completion-field.sql',
      'SELECT customer_id FROM orders;\nSELECT cu',
    );
    const fieldItems = await completionItemsAtEnd(fieldDocument);
    assert.ok(fieldItems.some((item) => completionLabel(item) === 'customer_id'));

    const upperDocument = await openFile('completion-upper.sql', 'SE');
    const upperItems = await completionItemsAtEnd(upperDocument);
    assert.ok(upperItems.some((item) => completionLabel(item) === 'SELECT'));

    const functionDocument = await openFile('completion-function.sql', 'SELECT su');
    const functionItems = await completionItemsAtEnd(functionDocument);
    const sum = functionItems.find((item) => completionLabel(item) === 'sum');
    assert.ok(sum);
    assert.equal(sum.kind, vscode.CompletionItemKind.Function);
    assert.ok(sum.insertText instanceof vscode.SnippetString);

    const emptyPrefixDocument = await openFile('completion-create-empty.sql', 'create ');
    const emptyPrefixResult = await completionListAtEnd(emptyPrefixDocument);
    assert.equal(emptyPrefixResult.isIncomplete, true);
    assert.ok(emptyPrefixResult.items.some((item) => completionLabel(item) === 'table'));

    const uppercaseSpaceDocument = await openFile('completion-create-space-upper.sql', 'CREATE ');
    const uppercaseSpaceItems = await completionItemsAtEnd(uppercaseSpaceDocument);
    assert.ok(uppercaseSpaceItems.some((item) => completionLabel(item) === 'TABLE'));

    const lowercaseExpressionDocument = await openFile('completion-select-space-lower.sql', 'select ');
    const lowercaseExpressionItems = await completionItemsAtEnd(lowercaseExpressionDocument);
    assert.ok(lowercaseExpressionItems.some((item) => completionLabel(item) === 'sum'));

    const resetDocument = await openFile('completion-case-reset.sql', 'select 1; ');
    const resetItems = await completionItemsAtEnd(resetDocument);
    assert.ok(resetItems.some((item) => completionLabel(item) === 'SELECT'));

    const createLowerDocument = await openFile('completion-create-lower.sql', 'create t');
    const createLowerItems = await completionItemsAtEnd(createLowerDocument);
    assert.ok(createLowerItems.some((item) => completionLabel(item) === 'table'));

    const createUpperDocument = await openFile('completion-create-upper.sql', 'create T');
    const createUpperItems = await completionItemsAtEnd(createUpperDocument);
    assert.ok(createUpperItems.some((item) => completionLabel(item) === 'TABLE'));
  });

  test('completes fields inside recognized SQL JSON strings', async () => {
    const document = await openFile(
      'completion.sql.json',
      '{"trainSql":"SELECT customer_id FROM orders WHERE cu"}',
    );
    const offset = document.getText().indexOf('cu"') + 2;
    const result = await vscode.commands.executeCommand<vscode.CompletionList>(
      'vscode.executeCompletionItemProvider',
      document.uri,
      document.positionAt(offset),
    );
    assert.ok(result.items.some((item) => completionLabel(item) === 'customer_id'));
  });

  test('indexes configured DDL for schema completion and strict diagnostics', async () => {
    const schemaDirectory = path.join(temporaryDirectory, 'schemas');
    await fs.mkdir(schemaDirectory, { recursive: true });
    await fs.writeFile(
      path.join(schemaDirectory, 'catalog.sql'),
      'CREATE TABLE sales.orders (id BIGINT, amount DECIMAL(10,2), customer_id STRING);',
      'utf8',
    );
    await fs.writeFile(
      path.join(schemaDirectory, 'views.sql'),
      'CREATE VIEW sales.order_ids AS SELECT id FROM sales.orders; DROP TABLE sales.orders;',
      'utf8',
    );
    await vscode.workspace.getConfiguration('aiopsSqlJson').update(
      'schemaFiles',
      ['schemas/*.sql'],
      vscode.ConfigurationTarget.Global,
    );
    await vscode.workspace.getConfiguration('aiopsSqlJson').update(
      'udfs',
      ['score_udf'],
      vscode.ConfigurationTarget.Global,
    );
    await vscode.workspace.getConfiguration('aiopsSqlJson').update(
      'schemaValidation.enabled',
      true,
      vscode.ConfigurationTarget.Global,
    );

    const validDocument = await openFile(
      'schema-valid.sql',
      'SELECT o.id, score_udf(o.amount) FROM sales.orders o WHERE o.customer_id > 0; SELECT id FROM sales.order_ids',
    );
    const validDiagnostics = await waitForDiagnostics(validDocument.uri);
    assert.ok(!validDiagnostics.some((item) => item.source?.includes('SQL schema')));

    const completionDocument = await openFile(
      'schema-field-completion.sql',
      'SELECT o.i FROM sales.orders o',
    );
    const completionOffset = completionDocument.getText().indexOf('o.i') + 3;
    const completions = await vscode.commands.executeCommand<vscode.CompletionList>(
      'vscode.executeCompletionItemProvider',
      completionDocument.uri,
      completionDocument.positionAt(completionOffset),
    );
    assert.ok(completions.items.some((item) => completionLabel(item) === 'id'));

    const invalidDocument = await openFile(
      'schema-invalid.sql',
      'SELECT o.missing, mystery(o.id) FROM sales.orders o',
    );
    const invalidDiagnostics = await waitForDiagnostics(
      invalidDocument.uri,
      (items) => items.some((item) => item.code === 'unknown-column')
        && items.some((item) => item.code === 'unknown-function'),
    );
    assert.ok(
      invalidDiagnostics.some((item) => item.code === 'unknown-column'),
      `Expected unknown-column diagnostic, got: ${invalidDiagnostics.map((item) => `${String(item.code)}:${item.message}`).join(' | ')}`,
    );
    assert.ok(invalidDiagnostics.some((item) => item.code === 'unknown-function'));

    await fs.writeFile(
      path.join(schemaDirectory, 'catalog.sql'),
      'CREATE TABLE sales.orders (id BIGINT, amount DECIMAL(10,2), customer_id STRING, missing STRING);',
      'utf8',
    );
    const changedDdlDiagnostics = await waitForDiagnostics(
      invalidDocument.uri,
      (items) => !items.some((item) => item.code === 'unknown-column')
        && items.some((item) => item.code === 'unknown-function'),
    );
    assert.ok(!changedDdlDiagnostics.some((item) => item.code === 'unknown-column'));

    await vscode.workspace.getConfiguration('aiopsSqlJson').update(
      'udfs',
      ['score_udf', 'mystery'],
      vscode.ConfigurationTarget.Global,
    );
    const changedConfigurationDiagnostics = await waitForDiagnostics(
      invalidDocument.uri,
      (items) => !items.some((item) => item.source?.includes('SQL schema')),
    );
    assert.ok(!changedConfigurationDiagnostics.some((item) => item.source?.includes('SQL schema')));

    await vscode.workspace.getConfiguration('aiopsSqlJson').update(
      'schemaValidation.enabled',
      undefined,
      vscode.ConfigurationTarget.Global,
    );
    await vscode.workspace.getConfiguration('aiopsSqlJson').update(
      'schemaFiles',
      undefined,
      vscode.ConfigurationTarget.Global,
    );
    await vscode.workspace.getConfiguration('aiopsSqlJson').update(
      'udfs',
      undefined,
      vscode.ConfigurationTarget.Global,
    );
  });

  test('falls back to known fields and keeps relation completions free of functions', async () => {
    const schemaDirectory = path.join(temporaryDirectory, 'completion-schemas');
    await fs.mkdir(schemaDirectory, { recursive: true });
    await fs.writeFile(
      path.join(schemaDirectory, 'catalog.sql'),
      `CREATE TABLE sales.orders (OrderId INTEGER, Amount INTEGER);
CREATE TABLE sales.customers (CustomerName VARCHAR(32));
CREATE TABLE archive.orders (ArchiveCode INTEGER);
CREATE VIEW sales.order_ids AS SELECT OrderId FROM sales.orders;`,
      'utf8',
    );
    await vscode.workspace.getConfiguration('aiopsSqlJson').update(
      'schemaFiles',
      ['completion-schemas/*.sql'],
      vscode.ConfigurationTarget.Global,
    );
    await vscode.workspace.getConfiguration('aiopsSqlJson').update(
      'udfs',
      ['score_udf'],
      vscode.ConfigurationTarget.Global,
    );
    await vscode.workspace.getConfiguration('aiopsSqlJson').update(
      'schemaValidation.enabled',
      true,
      vscode.ConfigurationTarget.Global,
    );

    const noSourceDocument = await openFile(
      'completion-schema-fallback.sql',
      'SELECT FileOnlySymbol FROM missing_history;\nSELECT ',
    );
    const noSourceItems = await completionItemsAtEnd(noSourceDocument);
    assert.ok(noSourceItems.some((item) => completionLabel(item) === 'OrderId'));
    assert.ok(noSourceItems.some((item) => completionLabel(item) === 'CustomerName'));
    assert.ok(noSourceItems.some((item) => completionLabel(item) === 'FileOnlySymbol'));

    const unknownDocument = await openFile('completion-unknown-source.sql', 'SELECT  FROM missing_source');
    const unknownItems = await completionItemsAtOffset(unknownDocument, 'SELECT '.length);
    assert.ok(unknownItems.some((item) => completionLabel(item) === 'CustomerName'));

    const mixedDocument = await openFile(
      'completion-mixed-sources.sql',
      'SELECT  FROM sales.orders o JOIN missing_source m ON true',
    );
    const mixedItems = await completionItemsAtOffset(mixedDocument, 'SELECT '.length);
    assert.ok(mixedItems.some((item) => completionLabel(item) === 'CustomerName'));

    const ambiguousDocument = await openFile('completion-ambiguous-source.sql', 'SELECT  FROM orders');
    const ambiguousItems = await completionItemsAtOffset(ambiguousDocument, 'SELECT '.length);
    assert.ok(ambiguousItems.some((item) => completionLabel(item) === 'ArchiveCode'));
    assert.ok(ambiguousItems.some((item) => completionLabel(item) === 'CustomerName'));

    const resolvedDocument = await openFile('completion-resolved-source.sql', 'SELECT  FROM sales.orders o');
    const resolvedItems = await completionItemsAtOffset(resolvedDocument, 'SELECT '.length);
    assert.ok(resolvedItems.some((item) => completionLabel(item) === 'OrderId'));
    assert.ok(!resolvedItems.some((item) => completionLabel(item) === 'CustomerName'));

    const qualifierDocument = await openFile(
      'completion-unknown-qualifier.sql',
      'SELECT bad_alias. FROM missing_source',
    );
    const qualifierOffset = qualifierDocument.getText().indexOf('.') + 1;
    const qualifierItems = await completionItemsAtOffset(qualifierDocument, qualifierOffset);
    assert.ok(!qualifierItems.some((item) => item.kind === vscode.CompletionItemKind.Field));

    const jsonDocument = await openFile(
      'completion-schema-fallback.sql.json',
      '{"firstSql":"SELECT JsonOnly FROM missing","secondSql":"SELECT "}',
    );
    const jsonOffset = jsonDocument.getText().lastIndexOf('SELECT ') + 'SELECT '.length;
    const jsonItems = await completionItemsAtOffset(jsonDocument, jsonOffset);
    assert.ok(jsonItems.some((item) => completionLabel(item) === 'JsonOnly'));
    assert.ok(jsonItems.some((item) => completionLabel(item) === 'CustomerName'));

    const localDocument = await openFile(
      'completion-local-fallback.sql',
      'CREATE TABLE local_active (LocalActive INTEGER); SELECT ',
    );
    const localItems = await completionItemsAtEnd(localDocument);
    const localField = localItems.find((item) => completionLabel(item) === 'LocalActive');
    assert.ok(localField);
    assert.ok(String(localField.detail).includes('local_active.LocalActive'));

    const droppedDocument = await openFile(
      'completion-dropped-fallback.sql',
      'CREATE TABLE local_dropped (DroppedOnly INTEGER); DROP TABLE local_dropped; SELECT ',
    );
    const droppedItems = await completionItemsAtEnd(droppedDocument);
    assert.ok(!droppedItems.some((item) => (
      completionLabel(item) === 'DroppedOnly' && String(item.detail).includes('local_dropped.DroppedOnly')
    )));

    const futureDocument = await openFile(
      'completion-future-fallback.sql',
      'SELECT ; CREATE TABLE future_table (FutureOnly INTEGER);',
    );
    const futureItems = await completionItemsAtOffset(futureDocument, 'SELECT '.length);
    assert.ok(!futureItems.some((item) => (
      completionLabel(item) === 'FutureOnly' && String(item.detail).includes('future_table.FutureOnly')
    )));

    const fromDocument = await openFile('completion-relation-from.sql', 'SELECT * FROM ');
    const joinDocument = await openFile(
      'completion-relation-join.sql',
      'SELECT * FROM sales.orders o JOIN ',
    );
    const prefixDocument = await openFile('completion-relation-prefix.sql', 'SELECT * FROM sal');
    for (const [contextName, document] of [
      ['FROM', fromDocument],
      ['JOIN', joinDocument],
      ['prefix', prefixDocument],
    ] as const) {
      const items = await completionItemsAtEnd(document);
      assert.ok(
        items.some((item) => completionLabel(item) === 'sales.orders'),
        `Expected a table in Spark ${contextName} completion.`,
      );
      assert.ok(!items.some((item) => item.kind === vscode.CompletionItemKind.Function));
      assert.ok(!items.some((item) => item.kind === vscode.CompletionItemKind.Field));
    }
    await vscode.workspace.getConfiguration('aiopsSqlJson').update(
      'schemaValidation.enabled',
      false,
      vscode.ConfigurationTarget.Global,
    );
    const dialects = ['spark', 'hive', 'flink', 'mysql', 'postgresql', 'trino', 'impala', 'generic'];
    for (const dialect of dialects) {
      await vscode.workspace.getConfiguration('aiopsSqlJson').update(
        'dialect',
        dialect,
        vscode.ConfigurationTarget.Global,
      );
      for (const [contextName, document] of [
        ['FROM', fromDocument],
        ['JOIN', joinDocument],
        ['prefix', prefixDocument],
      ] as const) {
        const items = await completionItemsAtEnd(document);
        assert.ok(
          !items.some((item) => item.kind === vscode.CompletionItemKind.Function),
          `Unexpected function in ${dialect} ${contextName} completion.`,
        );
        assert.ok(
          !items.some((item) => item.kind === vscode.CompletionItemKind.Field),
          `Unexpected field in ${dialect} ${contextName} completion.`,
        );
      }
    }

    await vscode.workspace.getConfiguration('aiopsSqlJson').update(
      'dialect',
      undefined,
      vscode.ConfigurationTarget.Global,
    );
    await vscode.workspace.getConfiguration('aiopsSqlJson').update(
      'schemaValidation.enabled',
      undefined,
      vscode.ConfigurationTarget.Global,
    );
    await vscode.workspace.getConfiguration('aiopsSqlJson').update(
      'schemaFiles',
      undefined,
      vscode.ConfigurationTarget.Global,
    );
    await vscode.workspace.getConfiguration('aiopsSqlJson').update(
      'udfs',
      undefined,
      vscode.ConfigurationTarget.Global,
    );
  });

  test('applies local DDL in order without requiring global schema files', async () => {
    await vscode.workspace.getConfiguration('aiopsSqlJson').update(
      'schemaFiles',
      [],
      vscode.ConfigurationTarget.Global,
    );
    await vscode.workspace.getConfiguration('aiopsSqlJson').update(
      'schemaValidation.enabled',
      true,
      vscode.ConfigurationTarget.Global,
    );

    const validDocument = await openFile(
      'local-ddl-valid.sql',
      `set spark.sql.ansi.enabled = true;
CREATE TEMPORARY TABLE local_orders (id BIGINT, amount STRING);
SELECT id, amount FROM local_orders;`,
    );
    const validDiagnostics = await waitForDiagnostics(validDocument.uri);
    assert.ok(!validDiagnostics.some((item) => item.source?.includes('SQL schema')));

    const completionDocument = await openFile(
      'local-ddl-completion.sql',
      'CREATE TABLE local_orders (id BIGINT, amount STRING); SELECT o.i FROM local_orders o;',
    );
    const completionOffset = completionDocument.getText().indexOf('o.i') + 3;
    const completion = await vscode.commands.executeCommand<vscode.CompletionList>(
      'vscode.executeCompletionItemProvider',
      completionDocument.uri,
      completionDocument.positionAt(completionOffset),
    );
    assert.ok(completion.items.some((item) => completionLabel(item) === 'id'));

    const droppedDocument = await openFile(
      'local-ddl-dropped.sql',
      'CREATE TABLE local_orders (id BIGINT); DROP TABLE local_orders; SELECT id FROM local_orders;',
    );
    const droppedDiagnostics = await waitForDiagnostics(
      droppedDocument.uri,
      (items) => items.some((item) => item.code === 'unknown-table'),
    );
    assert.equal(droppedDiagnostics.filter((item) => item.code === 'unknown-table').length, 1);

    const isolatedDocument = await openFile(
      'local-ddl-isolated.sql.json',
      `{
  "firstSql":"CREATE TABLE isolated_table (id BIGINT); SELECT id FROM isolated_table",
  "secondSql":"SELECT id FROM isolated_table"
}`,
    );
    const isolatedDiagnostics = await waitForDiagnostics(
      isolatedDocument.uri,
      (items) => items.some((item) => item.code === 'unknown-table'),
    );
    const unknownTable = isolatedDiagnostics.filter((item) => item.code === 'unknown-table');
    assert.equal(unknownTable.length, 1);
    assert.ok(unknownTable[0]!.range.start.line >= 2);

    await vscode.workspace.getConfiguration('aiopsSqlJson').update(
      'schemaValidation.enabled',
      undefined,
      vscode.ConfigurationTarget.Global,
    );
    await vscode.workspace.getConfiguration('aiopsSqlJson').update(
      'schemaFiles',
      undefined,
      vscode.ConfigurationTarget.Global,
    );
  });

  test('resolves the default schema variable and invalidates renamed or deleted schema directories', async () => {
    const schemaDirectory = path.join(temporaryDirectory, 'schema');
    const renamedDirectory = path.join(temporaryDirectory, 'schema1');
    const catalogPath = path.join(schemaDirectory, 'catalog.sql');
    await fs.mkdir(schemaDirectory, { recursive: true });
    await fs.writeFile(catalogPath, 'CREATE TABLE variable_table (id BIGINT);', 'utf8');
    await vscode.workspace.getConfiguration('aiopsSqlJson').update(
      'schemaFiles',
      undefined,
      vscode.ConfigurationTarget.Global,
    );
    await vscode.workspace.getConfiguration('aiopsSqlJson').update(
      'schemaValidation.enabled',
      true,
      vscode.ConfigurationTarget.Global,
    );

    const document = await openFile('schema-variable-query.sql', 'SELECT id FROM variable_table;');
    const initial = await waitForDiagnostics(
      document.uri,
      (items) => !items.some((item) => item.source?.includes('SQL schema')),
    );
    assert.ok(!initial.some((item) => item.source?.includes('SQL schema')));

    await vscode.workspace.fs.rename(
      vscode.Uri.file(schemaDirectory),
      vscode.Uri.file(renamedDirectory),
      { overwrite: false },
    );
    const renamed = await waitForDiagnostics(
      document.uri,
      (items) => items.some((item) => item.code === 'unknown-table'),
    );
    assert.ok(renamed.some((item) => item.code === 'unknown-table'));

    await vscode.workspace.fs.rename(
      vscode.Uri.file(renamedDirectory),
      vscode.Uri.file(schemaDirectory),
      { overwrite: false },
    );
    const restored = await waitForDiagnostics(
      document.uri,
      (items) => !items.some((item) => item.code === 'unknown-table'),
    );
    assert.ok(!restored.some((item) => item.code === 'unknown-table'));

    await fs.rename(schemaDirectory, renamedDirectory);
    const externallyRenamed = await waitForDiagnostics(
      document.uri,
      (items) => items.some((item) => item.code === 'unknown-table'),
    );
    assert.ok(externallyRenamed.some((item) => item.code === 'unknown-table'));
    await fs.rename(renamedDirectory, schemaDirectory);
    await waitForDiagnostics(document.uri, (items) => !items.some((item) => item.code === 'unknown-table'));

    await vscode.workspace.getConfiguration('aiopsSqlJson').update(
      'schemaFiles',
      ['schema/*.sql'],
      vscode.ConfigurationTarget.Global,
    );
    const relativePattern = await waitForDiagnostics(
      document.uri,
      (items) => !items.some((item) => item.code === 'unknown-table'),
    );
    assert.ok(!relativePattern.some((item) => item.code === 'unknown-table'));

    await fs.rm(schemaDirectory, { recursive: true, force: true });
    const deleted = await waitForDiagnostics(
      document.uri,
      (items) => items.some((item) => item.code === 'unknown-table'),
    );
    assert.ok(deleted.some((item) => item.code === 'unknown-table'));
    await fs.mkdir(schemaDirectory, { recursive: true });
    await fs.writeFile(catalogPath, 'CREATE TABLE variable_table (id BIGINT);', 'utf8');
    const recreated = await waitForDiagnostics(
      document.uri,
      (items) => !items.some((item) => item.code === 'unknown-table'),
    );
    assert.ok(!recreated.some((item) => item.code === 'unknown-table'));

    await vscode.workspace.getConfiguration('aiopsSqlJson').update(
      'schemaValidation.enabled',
      undefined,
      vscode.ConfigurationTarget.Global,
    );
    await vscode.workspace.getConfiguration('aiopsSqlJson').update(
      'schemaFiles',
      undefined,
      vscode.ConfigurationTarget.Global,
    );
  });

  async function openFile(fileName: string, content: string): Promise<vscode.TextDocument> {
    const filePath = path.join(temporaryDirectory, fileName);
    await fs.writeFile(filePath, content, 'utf8');
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    await vscode.window.showTextDocument(document);
    return document;
  }

  async function completionItemsAtEnd(document: vscode.TextDocument): Promise<readonly vscode.CompletionItem[]> {
    return (await completionListAtEnd(document)).items;
  }

  async function completionItemsAtOffset(
    document: vscode.TextDocument,
    offset: number,
  ): Promise<readonly vscode.CompletionItem[]> {
    const result = await vscode.commands.executeCommand<vscode.CompletionList>(
      'vscode.executeCompletionItemProvider',
      document.uri,
      document.positionAt(offset),
    );
    return result.items;
  }

  async function completionListAtEnd(document: vscode.TextDocument): Promise<vscode.CompletionList> {
    const result = await vscode.commands.executeCommand<vscode.CompletionList>(
      'vscode.executeCompletionItemProvider',
      document.uri,
      document.positionAt(document.getText().length),
    );
    return result;
  }
});

function completionLabel(item: vscode.CompletionItem): string {
  return typeof item.label === 'string' ? item.label : item.label.label;
}

function activeEditorFor(document: vscode.TextDocument): vscode.TextEditor {
  const editor = vscode.window.activeTextEditor;
  assert.ok(editor && editor.document === document, 'The requested document must be active.');
  return editor;
}

function setCaret(editor: vscode.TextEditor, offset: number): void {
  const position = editor.document.positionAt(offset);
  editor.selection = new vscode.Selection(position, position);
}

async function waitForDiagnostics(
  uri: vscode.Uri,
  predicate: (diagnostics: readonly vscode.Diagnostic[]) => boolean = () => true,
): Promise<readonly vscode.Diagnostic[]> {
  const earliestCheck = Date.now() + 350;
  const timeoutAt = Date.now() + 15_000;
  while (Date.now() < timeoutAt) {
    const diagnostics = vscode.languages.getDiagnostics(uri);
    if (Date.now() >= earliestCheck && predicate(diagnostics)) {
      return diagnostics;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return vscode.languages.getDiagnostics(uri);
}
