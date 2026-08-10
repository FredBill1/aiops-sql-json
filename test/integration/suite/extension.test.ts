import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import * as vscode from 'vscode';

suite('AIOps SQL JSON extension', () => {
  let temporaryDirectory: string;

  suiteSetup(async () => {
    temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'aiops-sql-json-'));
    const extension = vscode.extensions.getExtension('fredbill1.aiops-sql-json');
    assert.ok(extension, 'Extension must be discoverable in the extension host.');
    await extension.activate();
  });

  suiteTeardown(async () => {
    await vscode.workspace.getConfiguration('json').update('schemas', undefined, vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration('aiopsSqlJson').update('plainSql.enabled', undefined, vscode.ConfigurationTarget.Global);
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  });

  test('associates .sql.json and accepts an indented multiline SQL string', async () => {
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

  test('rejects a multiline non-SQL string', async () => {
    const document = await openFile('invalid-string.sql.json', `{
  "name": "first
    second"
}`);
    const diagnostics = await waitForDiagnostics(
      document.uri,
      (items) => items.some((item) => item.code === 'illegal-multiline-string'),
    );
    assert.ok(diagnostics.some((diagnostic) => diagnostic.code === 'illegal-multiline-string'));
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

  test('uses json.schemas for projected schema validation', async () => {
    await vscode.workspace.getConfiguration('json').update('schemas', [{
      fileMatch: ['*.sql.json'],
      schema: {
        type: 'object',
        required: ['jobName'],
        properties: { jobName: { enum: ['daily'], description: 'Job name' } },
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
