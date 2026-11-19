import { url as inspectorUrl } from 'node:inspector';

import * as vscode from 'vscode';

import { getExtensionConfiguration, getSqlWorkerLimit, SQL_MAX_WORKERS_SETTING } from './config';
import { DiagnosticController } from './diagnostics';
import { SqlDocumentFormattingProvider } from './formattingProvider';
import { SqlBracketDecorationController } from './bracketDecorations';
import { SqlEditingCommands } from './editingCommands';
import { SqlEditingContextService } from './editingContext';
import { JsonServiceManager } from './jsonService';
import { JsonCompletionProvider, JsonHoverProvider } from './providers';
import { SqlSchemaService, type SchemaRebuildRequest } from './schemaService';
import { SEMANTIC_TOKEN_LEGEND, SqlSemanticTokensProvider } from './semanticTokens';
import { SqlCompletionProvider } from './sqlCompletion';
import { FORCE_REPARSE_COMMAND, SqlAnalysisProgress } from './sqlAnalysisProgress';
import { SqlDefinitionProvider, SqlHoverProvider } from './sqlNavigation';
import { SqlService } from './sqlService';
import { resolveSqlDeadlinePolicy, serializeSqlWorkerMetadata, type SqlExtensionMode } from './sqlDeadlinePolicy';

const SQL_JSON_SELECTOR: vscode.DocumentFilter[] = [
  { language: 'sql-json', scheme: 'file' },
  { language: 'sql-json', scheme: 'untitled' },
  { language: 'sql-json' },
];

const SQL_SELECTOR: vscode.DocumentFilter[] = [
  { language: 'sql', scheme: 'file' },
  { language: 'sql', scheme: 'untitled' },
  { language: 'sql' },
];

const REBUILD_SCHEMA_INDEX_COMMAND = 'aiopsSqlJson.rebuildSchemaIndex';

export function activate(context: vscode.ExtensionContext): void {
  const extensionMode: SqlExtensionMode = context.extensionMode === vscode.ExtensionMode.Development
    ? 'development'
    : context.extensionMode === vscode.ExtensionMode.Test ? 'test' : 'production';
  const deadlinePolicy = resolveSqlDeadlinePolicy(
    extensionMode, inspectorUrl(), process.env.AIOPS_SQL_JSON_ENFORCE_TIMEOUTS,
  );
  const output = vscode.window.createOutputChannel('AIOps SQL JSON');
  output.appendLine(JSON.stringify({ event: 'deadline-policy', extensionMode, policy: deadlinePolicy }));
  const workerLimit = getSqlWorkerLimit();
  output.appendLine(JSON.stringify({ event: 'analysis-worker-limit', ...workerLimit }));
  const sqlService = new SqlService({
    analysisWorkerPath: context.asAbsolutePath('dist/sqlAnalysisWorker.js'),
    analysisWorkerLimit: workerLimit.limit,
    lexicalWorkerPath: context.asAbsolutePath('dist/sqlLexicalWorker.js'),
    deadlinePolicy,
    onWorkerEvent: (event) => output.appendLine(serializeSqlWorkerMetadata(event)),
  });
  const jsonServices = new JsonServiceManager();
  const editingContexts = new SqlEditingContextService(jsonServices);
  const semanticTokens = new SqlSemanticTokensProvider(jsonServices, sqlService);
  const progress = new SqlAnalysisProgress();
  const schemas = new SqlSchemaService(sqlService, progress);
  const diagnostics = new DiagnosticController(jsonServices, () => semanticTokens.refresh(), schemas, sqlService, progress);
  const bracketDecorations = new SqlBracketDecorationController(editingContexts);
  const editingCommands = new SqlEditingCommands(editingContexts);

  context.subscriptions.push(
    output,
    sqlService,
    semanticTokens,
    schemas,
    diagnostics,
    progress,
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration(SQL_MAX_WORKERS_SETTING)) return;
      const limit = getSqlWorkerLimit();
      sqlService.setAnalysisWorkerLimit(limit.limit);
      output.appendLine(JSON.stringify({ event: 'analysis-worker-limit', ...limit }));
    }),
    progress.registerStatusBar({
      schemaKey: (document) => schemas.getIndexKey(document.uri, getExtensionConfiguration(document.uri)),
      retryDocument: (document) => diagnostics.forceReparse(document),
      retrySchema: (document) => schemas.retryIndex(document.uri, getExtensionConfiguration(document.uri)),
    }),
    bracketDecorations,
    editingCommands,
    vscode.commands.registerCommand(FORCE_REPARSE_COMMAND, () => {
      const document = vscode.window.activeTextEditor?.document;
      if (document) diagnostics.forceReparse(document);
    }),
    vscode.commands.registerCommand(REBUILD_SCHEMA_INDEX_COMMAND, async () => {
      const resource = commandResource();
      if (!resource || !getExtensionConfiguration(resource).schemaValidationEnabled) {
        void vscode.window.showInformationMessage(
          'AIOps SQL JSON: Enable aiopsSqlJson.schemaValidation.enabled before rebuilding the Schema index.',
        );
        return;
      }
      const requests: SchemaRebuildRequest[] = vscode.workspace.textDocuments
        .filter(isSupportedSqlDocument)
        .map((document) => ({
          resource: document.uri,
          configuration: getExtensionConfiguration(document.uri),
        }));
      await schemas.rebuild(requests);
      const snapshots = await Promise.all(requests.map((request) => schemas.getSchema(
        request.resource, request.configuration, true,
      )));
      if (snapshots.some((snapshot) => schemas.getSchemaFailure(snapshot))) {
        void vscode.window.showWarningMessage('AIOps SQL JSON: Schema index rebuild could not complete. See SQL diagnostics for details.');
      } else if (requests.some(({ resource, configuration }) => schemas.isIndexPaused(resource, configuration))) {
        void vscode.window.showInformationMessage('AIOps SQL JSON: Schema indexing paused.');
      } else {
        void vscode.window.showInformationMessage('AIOps SQL JSON: Schema index rebuilt.');
      }
    }),
    vscode.languages.registerDocumentSemanticTokensProvider(
      [...SQL_JSON_SELECTOR, ...SQL_SELECTOR],
      semanticTokens,
      SEMANTIC_TOKEN_LEGEND,
    ),
    vscode.languages.registerCompletionItemProvider(
      SQL_JSON_SELECTOR,
      new JsonCompletionProvider(jsonServices),
      '"',
      ':',
    ),
    vscode.languages.registerCompletionItemProvider(
      [...SQL_JSON_SELECTOR, ...SQL_SELECTOR],
      new SqlCompletionProvider(jsonServices, schemas, sqlService, progress),
      ' ',
      '.',
      '(',
      ',',
    ),
    vscode.languages.registerHoverProvider(SQL_JSON_SELECTOR, new JsonHoverProvider(jsonServices)),
    vscode.languages.registerHoverProvider(
      [...SQL_JSON_SELECTOR, ...SQL_SELECTOR],
      new SqlHoverProvider(jsonServices, schemas, sqlService, progress),
    ),
    vscode.languages.registerDefinitionProvider(
      [...SQL_JSON_SELECTOR, ...SQL_SELECTOR],
      new SqlDefinitionProvider(jsonServices, schemas, sqlService, progress),
    ),
    vscode.languages.registerDocumentFormattingEditProvider(
      [...SQL_JSON_SELECTOR, ...SQL_SELECTOR],
      new SqlDocumentFormattingProvider(sqlService, progress),
    ),
  );
}

export function deactivate(): void {
  // All resources are owned by context.subscriptions.
}

function commandResource(): vscode.Uri | undefined {
  return vscode.window.activeTextEditor?.document.uri
    ?? vscode.workspace.textDocuments.find(isSupportedSqlDocument)?.uri
    ?? vscode.workspace.workspaceFolders?.[0]?.uri;
}

function isSupportedSqlDocument(document: vscode.TextDocument): boolean {
  return document.languageId === 'sql' || document.languageId === 'sql-json';
}
