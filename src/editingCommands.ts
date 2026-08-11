import * as vscode from 'vscode';

import { rangeForDecodedOffset } from './bracketDecorations';
import { findBracketAt } from './editingCore';
import type { SqlEditingContextService, SqlEditingRegion } from './editingContext';
import { decodedOffsetAtOriginalOffset } from './regions';

export const JUMP_TO_SQL_BRACKET_COMMAND = 'aiopsSqlJson.jumpToMatchingSqlBracket';
export const TOGGLE_SQL_LINE_COMMENT_COMMAND = 'aiopsSqlJson.toggleSqlLineComment';
export const TOGGLE_SQL_BLOCK_COMMENT_COMMAND = 'aiopsSqlJson.toggleSqlBlockComment';

interface CommentEdit {
  start: number;
  end: number;
  replacement: string;
}

export class SqlEditingCommands implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[];

  constructor(private readonly contexts: SqlEditingContextService) {
    this.disposables = [
      vscode.commands.registerCommand(JUMP_TO_SQL_BRACKET_COMMAND, () => this.jumpToBracket()),
      vscode.commands.registerCommand(TOGGLE_SQL_LINE_COMMENT_COMMAND, () => (
        this.toggleSafeComment('editor.action.commentLine')
      )),
      vscode.commands.registerCommand(TOGGLE_SQL_BLOCK_COMMENT_COMMAND, () => (
        this.toggleSafeComment('editor.action.blockComment')
      )),
    ];
  }

  dispose(): void {
    this.disposables.forEach((disposable) => disposable.dispose());
  }

  private async jumpToBracket(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'sql-json') {
      await vscode.commands.executeCommand('editor.action.jumpToBracket');
      return;
    }

    const destinations: vscode.Position[] = [];
    for (const selection of editor.selections) {
      const originalOffset = editor.document.offsetAt(selection.active);
      const candidate = this.contexts.findRegionAtOffset(editor.document, originalOffset);
      if (!candidate) {
        await vscode.commands.executeCommand('editor.action.jumpToBracket');
        return;
      }
      const decodedOffset = decodedOffsetAtOriginalOffset(candidate.region.decoded, originalOffset);
      const bracket = findBracketAt(candidate.structure, decodedOffset);
      const range = bracket?.pairOffset === undefined
        ? undefined
        : rangeForDecodedOffset(editor.document, candidate, bracket.pairOffset);
      if (!range) {
        await vscode.commands.executeCommand('editor.action.jumpToBracket');
        return;
      }
      destinations.push(range.start);
    }

    editor.selections = destinations.map((position) => new vscode.Selection(position, position));
    const primary = destinations[0];
    if (primary) {
      editor.revealRange(new vscode.Range(primary, primary));
    }
  }

  private async toggleSafeComment(fallbackCommand: string): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'sql-json') {
      await vscode.commands.executeCommand(fallbackCommand);
      return;
    }

    const edits: CommentEdit[] = [];
    for (const selection of editor.selections) {
      const target = commentTarget(editor.document, selection, this.contexts);
      if (!target) {
        await vscode.commands.executeCommand(fallbackCommand);
        return;
      }
      edits.push(toggleCommentEdit(editor.document, target.start, target.end));
    }
    if (editsOverlap(edits)) {
      await vscode.commands.executeCommand(fallbackCommand);
      return;
    }

    await editor.edit((builder) => {
      for (const edit of edits) {
        builder.replace(
          new vscode.Range(editor.document.positionAt(edit.start), editor.document.positionAt(edit.end)),
          edit.replacement,
        );
      }
    }, { undoStopBefore: true, undoStopAfter: true });
  }
}

function commentTarget(
  document: vscode.TextDocument,
  selection: vscode.Selection,
  contexts: SqlEditingContextService,
): { start: number; end: number; region: SqlEditingRegion } | undefined {
  let start = document.offsetAt(selection.start);
  let end = document.offsetAt(selection.end);
  const region = contexts.findRegionContainingRange(document, start, end);
  if (!region) {
    return undefined;
  }
  if (!selection.isEmpty) {
    return { start, end, region };
  }

  const line = document.lineAt(selection.active.line);
  start = Math.max(region.contentStart, document.offsetAt(line.range.start));
  end = Math.min(region.contentEnd, document.offsetAt(line.range.end));
  const source = document.getText();
  while (start < end && /\s/u.test(source[start] ?? '')) {
    start += 1;
  }
  while (end > start && /\s/u.test(source[end - 1] ?? '')) {
    end -= 1;
  }
  if (start === end) {
    start = document.offsetAt(selection.active);
    end = start;
  }
  return { start, end, region };
}

function toggleCommentEdit(document: vscode.TextDocument, start: number, end: number): CommentEdit {
  const text = document.getText(new vscode.Range(document.positionAt(start), document.positionAt(end)));
  const leadingLength = text.length - text.trimStart().length;
  const trailingLength = text.length - text.trimEnd().length;
  const trimmedEnd = text.length - trailingLength;
  const trimmed = text.slice(leadingLength, trimmedEnd);

  if (trimmed.startsWith('/*') && trimmed.endsWith('*/')) {
    let innerStart = leadingLength + 2;
    let innerEnd = trimmedEnd - 2;
    if (text[innerStart] === ' ') {
      innerStart += 1;
    }
    if (text[innerEnd - 1] === ' ') {
      innerEnd -= 1;
    }
    return {
      start,
      end,
      replacement: `${text.slice(0, leadingLength)}${text.slice(innerStart, innerEnd)}${text.slice(trimmedEnd)}`,
    };
  }

  return {
    start,
    end,
    replacement: text.length === 0 ? '/**/' : `/* ${text} */`,
  };
}

function editsOverlap(edits: readonly CommentEdit[]): boolean {
  const sorted = [...edits].sort((left, right) => left.start - right.start || left.end - right.end);
  return sorted.some((edit, index) => {
    const previous = sorted[index - 1];
    return previous !== undefined && edit.start < previous.end;
  });
}
