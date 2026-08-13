import * as vscode from 'vscode';

import { getExtensionConfiguration } from './config';
import { DiagnosticController } from './diagnostics';
import { SqlBracketDecorationController } from './bracketDecorations';
import { SqlEditingController } from './editing';
import { SqlEditingCommands } from './editingCommands';
import { SqlEditingContextService } from './editingContext';
import { JsonServiceManager } from './jsonService';
import { JsonCompletionProvider, JsonHoverProvider } from './providers';
import { SqlSchemaService, type SchemaRebuildRequest } from './schemaService';
import { SEMANTIC_TOKEN_LEGEND, SqlSemanticTokensProvider } from './semanticTokens';
import { SqlCompletionProvider } from './sqlCompletion';
import { SqlDefinitionProvider, SqlHoverProvider } from './sqlNavigation';

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
  const jsonServices = new JsonServiceManager();
  const editingContexts = new SqlEditingContextService(jsonServices);
  const semanticTokens = new SqlSemanticTokensProvider(jsonServices);
  const schemas = new SqlSchemaService();
  const diagnostics = new DiagnosticController(jsonServices, () => semanticTokens.refresh(), schemas);
  const editing = new SqlEditingController(editingContexts);
  const bracketDecorations = new SqlBracketDecorationController(editingContexts);
  const editingCommands = new SqlEditingCommands(editingContexts);

  context.subscriptions.push(
    semanticTokens,
    schemas,
    diagnostics,
    editing,
    bracketDecorations,
    editingCommands,
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
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'AIOps SQL JSON: Rebuilding Schema index…',
          cancellable: false,
        },
        () => schemas.rebuild(requests),
      );
      void vscode.window.showInformationMessage('AIOps SQL JSON: Schema index rebuilt.');
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
      new SqlCompletionProvider(jsonServices, schemas),
      ' ',
      '.',
      '(',
      ',',
    ),
    vscode.languages.registerHoverProvider(SQL_JSON_SELECTOR, new JsonHoverProvider(jsonServices)),
    vscode.languages.registerHoverProvider(
      [...SQL_JSON_SELECTOR, ...SQL_SELECTOR],
      new SqlHoverProvider(jsonServices, schemas),
    ),
    vscode.languages.registerDefinitionProvider(
      [...SQL_JSON_SELECTOR, ...SQL_SELECTOR],
      new SqlDefinitionProvider(jsonServices, schemas),
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
