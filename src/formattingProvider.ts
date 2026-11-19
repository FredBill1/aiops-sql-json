import * as vscode from 'vscode';

import { getExtensionConfiguration } from './config';
import type { SqlAnalysisProgress } from './sqlAnalysisProgress';
import type { EditorFormattingOptions } from './sqlFormatting';
import type { SqlService } from './sqlService';
import { isSqlRequestCancelled, sqlDocumentSnapshot, sqlServiceFailureMessage } from './sqlServiceContext';

export class SqlDocumentFormattingProvider implements vscode.DocumentFormattingEditProvider {
  constructor(private readonly sqlService: SqlService, private readonly progress: SqlAnalysisProgress) {}

  async provideDocumentFormattingEdits(
    document: vscode.TextDocument,
    options: vscode.FormattingOptions,
    token: vscode.CancellationToken,
  ): Promise<vscode.TextEdit[]> {
    const configuration = getExtensionConfiguration(document.uri);
    const version = document.version;
    const generation = this.sqlService.generation;
    if (document.languageId === 'sql' && !configuration.plainSqlEnabled) return [];
    const request = this.progress.beginDocument(document, token);
    if (!request) return [];
    const editor: EditorFormattingOptions = {
      tabSize: Math.max(1, options.tabSize),
      insertSpaces: options.insertSpaces,
      eol: document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n',
    };

    let outcome: 'ready' | 'failed' | undefined;
    try {
      const formattedBody = document.languageId === 'sql-json'
        ? await this.sqlService.formatJson({ uri: document.uri.toString(), version, text: document.getText() }, {
          keyPatternSources: configuration.keyPatternSources,
          placeholderSources: configuration.placeholderSources,
          allowAllMultilineStrings: configuration.allowAllMultilineStrings,
          allowPlaceholdersEverywhere: configuration.allowPlaceholdersEverywhere,
          dialect: configuration.dialect,
          format: configuration.format,
        }, editor, request)
        : await this.sqlService.format(sqlDocumentSnapshot(document, configuration), configuration.format, editor, request);
      if (request.cancellation.isCancellationRequested || document.isClosed || document.version !== version
        || this.sqlService.generation !== generation) return [];
      const formatted = ensureFinalEol(formattedBody, editor.eol);
      outcome = 'ready';
      if (formatted === document.getText()) return [];
      return [vscode.TextEdit.replace(
        new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
        formatted,
      )];
    } catch (error) {
      if (!request.cancellation.isCancellationRequested && !isSqlRequestCancelled(error)
        && this.sqlService.generation === generation) {
        outcome = 'failed';
        void vscode.window.showWarningMessage(`AIOps SQL JSON: ${sqlServiceFailureMessage(error)}`);
      }
      return [];
    } finally {
      request.finish(outcome);
    }
  }
}

function ensureFinalEol(text: string, eol: string): string {
  if (text.length === 0) return text;
  return `${text.replace(/(?:\r\n|\r|\n)+$/u, '')}${eol}`;
}
