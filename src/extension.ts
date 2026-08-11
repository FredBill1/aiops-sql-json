import * as vscode from 'vscode';

import { DiagnosticController } from './diagnostics';
import { SqlBracketDecorationController } from './bracketDecorations';
import { SqlEditingController } from './editing';
import { SqlEditingCommands } from './editingCommands';
import { SqlEditingContextService } from './editingContext';
import { JsonServiceManager } from './jsonService';
import { JsonCompletionProvider, JsonHoverProvider } from './providers';
import { SEMANTIC_TOKEN_LEGEND, SqlSemanticTokensProvider } from './semanticTokens';

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

export function activate(context: vscode.ExtensionContext): void {
  const jsonServices = new JsonServiceManager();
  const editingContexts = new SqlEditingContextService(jsonServices);
  const semanticTokens = new SqlSemanticTokensProvider(jsonServices);
  const diagnostics = new DiagnosticController(jsonServices, () => semanticTokens.refresh());
  const editing = new SqlEditingController(editingContexts);
  const bracketDecorations = new SqlBracketDecorationController(editingContexts);
  const editingCommands = new SqlEditingCommands(editingContexts);

  context.subscriptions.push(
    semanticTokens,
    diagnostics,
    editing,
    bracketDecorations,
    editingCommands,
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
    vscode.languages.registerHoverProvider(SQL_JSON_SELECTOR, new JsonHoverProvider(jsonServices)),
  );
}

export function deactivate(): void {
  // All resources are owned by context.subscriptions.
}
