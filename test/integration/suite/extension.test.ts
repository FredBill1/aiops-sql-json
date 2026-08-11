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
    await extension.activate();
  });

  suiteTeardown(async () => {
    await vscode.workspace.getConfiguration('json').update('schemas', undefined, vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration('aiopsSqlJson').update('plainSql.enabled', undefined, vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration('aiopsSqlJson').update('multilineStrings.allowAll', undefined, vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration('aiopsSqlJson').update('placeholders.allowEverywhere', undefined, vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration('aiopsSqlJson').update('keyPatterns', undefined, vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration('editor').update('autoClosingBrackets', undefined, vscode.ConfigurationTarget.Global);
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  });

  test('associates .sql.json and accepts an indented multiline SQL string', async () => {
    const languageContribution = extension.packageJSON.contributes.languages[0] as { filenamePatterns?: string[] };
    const configurationDefaults = extension.packageJSON.contributes.configurationDefaults as Record<string, unknown>;
    assert.ok(languageContribution.filenamePatterns?.includes('*.sql.json'));
    assert.deepEqual(configurationDefaults['files.associations'], { '*.sql.json': 'sql-json' });

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
  });

  async function openFile(fileName: string, content: string): Promise<vscode.TextDocument> {
    const filePath = path.join(temporaryDirectory, fileName);
    await fs.writeFile(filePath, content, 'utf8');
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    await vscode.window.showTextDocument(document);
    return document;
  }
});

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
