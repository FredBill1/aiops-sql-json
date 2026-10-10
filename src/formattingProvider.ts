import * as vscode from 'vscode';

import { getExtensionConfiguration } from './config';
import type { EditorFormattingOptions } from './sqlFormatting';
import type { SqlService } from './sqlService';
import { isSqlRequestCancelled, sqlDocumentSnapshot, sqlServiceFailureMessage } from './sqlServiceContext';

export class SqlDocumentFormattingProvider implements vscode.DocumentFormattingEditProvider {
  constructor(private readonly sqlService: SqlService) {}

  async provideDocumentFormattingEdits(
    document: vscode.TextDocument,
    options: vscode.FormattingOptions,
    token: vscode.CancellationToken,
  ): Promise<vscode.TextEdit[]> {
    const configuration = getExtensionConfiguration(document.uri);
    const version = document.version;
    const generation = this.sqlService.generation;
    if (document.languageId === 'sql' && !configuration.plainSqlEnabled) return [];
    const editor: EditorFormattingOptions = {
      tabSize: Math.max(1, options.tabSize),
      insertSpaces: options.insertSpaces,
      eol: document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n',
    };

    try {
      const formattedBody = document.languageId === 'sql-json'
        ? await this.sqlService.formatJson({ uri: document.uri.toString(), version, text: document.getText() }, {
          keyPatternSources: configuration.keyPatternSources,
          placeholderSources: configuration.placeholderSources,
          allowAllMultilineStrings: configuration.allowAllMultilineStrings,
          allowPlaceholdersEverywhere: configuration.allowPlaceholdersEverywhere,
          dialect: configuration.dialect,
          format: configuration.format,
        }, editor, token)
        : await this.sqlService.format(sqlDocumentSnapshot(document, configuration), configuration.format, editor, token);
      const formatted = ensureFinalEol(formattedBody, editor.eol);
      if (token.isCancellationRequested || document.isClosed || document.version !== version
        || this.sqlService.generation !== generation
        || formatted === document.getText()) return [];
      return [vscode.TextEdit.replace(
        new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
        formatted,
      )];
    } catch (error) {
      if (!token.isCancellationRequested && !isSqlRequestCancelled(error)
        && this.sqlService.generation === generation) {
        void vscode.window.showWarningMessage(`AIOps SQL JSON: ${sqlServiceFailureMessage(error)}`);
      }
      return [];
    }
  }
}

function ensureFinalEol(text: string, eol: string): string {
  if (text.length === 0) return text;
  return `${text.replace(/(?:\r\n|\r|\n)+$/u, '')}${eol}`;
}
