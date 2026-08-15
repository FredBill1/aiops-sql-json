import * as vscode from 'vscode';

import { getExtensionConfiguration } from './config';
import type { JsonServiceManager } from './jsonService';
import { formatSqlJson } from './sqlJsonFormatting';
import { formatSql, SqlFormattingError, type EditorFormattingOptions } from './sqlFormatting';

export class SqlDocumentFormattingProvider implements vscode.DocumentFormattingEditProvider {
  constructor(private readonly jsonServices: JsonServiceManager) {}

  async provideDocumentFormattingEdits(
    document: vscode.TextDocument,
    options: vscode.FormattingOptions,
    token: vscode.CancellationToken,
  ): Promise<vscode.TextEdit[]> {
    const configuration = getExtensionConfiguration(document.uri);
    if (document.languageId === 'sql' && !configuration.plainSqlEnabled) return [];
    const editor: EditorFormattingOptions = {
      tabSize: Math.max(1, options.tabSize),
      insertSpaces: options.insertSpaces,
      eol: document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n',
    };

    try {
      const formatted = document.languageId === 'sql-json'
        ? formatSqlJson(this.jsonServices.createDocument(document, configuration), configuration, editor)
        : formatSql(
          document.getText(),
          configuration.dialect,
          configuration.placeholderPatterns,
          configuration.format,
          editor,
        ).text;
      if (token.isCancellationRequested || formatted === document.getText()) return [];
      return [vscode.TextEdit.replace(
        new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
        formatted,
      )];
    } catch (error) {
      if (!token.isCancellationRequested) {
        const message = error instanceof Error ? error.message : String(error);
        const prefix = error instanceof SqlFormattingError ? '' : 'Unexpected formatter failure: ';
        void vscode.window.showWarningMessage(`AIOps SQL JSON: ${prefix}${message}`);
      }
      return [];
    }
  }
}
