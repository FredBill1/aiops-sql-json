import * as vscode from 'vscode';

import {
  findBracketAt,
  visibleBracketColorIndex,
  VISIBLE_BRACKET_COLOR_COUNT,
} from './editingCore';
import type { SqlEditingContextService, SqlEditingRegion } from './editingContext';
import { decodedOffsetAtOriginalOffset, mapDecodedRange } from './regions';

export class SqlBracketDecorationController implements vscode.Disposable {
  private readonly levelDecorations = Array.from({ length: VISIBLE_BRACKET_COLOR_COUNT }, (_, index) => (
    vscode.window.createTextEditorDecorationType({
      color: new vscode.ThemeColor(`editorBracketHighlight.foreground${index + 1}`),
    })
  ));
  private readonly unexpectedDecoration = vscode.window.createTextEditorDecorationType({
    color: new vscode.ThemeColor('editorBracketHighlight.unexpectedBracket.foreground'),
  });
  private readonly matchingDecoration = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('editorBracketMatch.background'),
    border: '1px solid',
    borderColor: new vscode.ThemeColor('editorBracketMatch.border'),
    color: new vscode.ThemeColor('editorBracketMatch.foreground'),
  });
  private readonly disposables: vscode.Disposable[];
  private readonly timers = new Map<vscode.TextEditor, NodeJS.Timeout>();

  constructor(private readonly contexts: SqlEditingContextService) {
    this.disposables = [
      vscode.window.onDidChangeVisibleTextEditors((editors) => editors.forEach((editor) => this.schedule(editor, 0))),
      vscode.window.onDidChangeTextEditorSelection((event) => this.schedule(event.textEditor, 0)),
      vscode.workspace.onDidChangeTextDocument((event) => {
        this.contexts.clear(event.document);
        for (const editor of vscode.window.visibleTextEditors) {
          if (editor.document === event.document) {
            this.schedule(editor);
          }
        }
      }),
      vscode.workspace.onDidCloseTextDocument((document) => this.clearTimers(document)),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('aiopsSqlJson.keyPatterns')
          || event.affectsConfiguration('editor.bracketPairColorization')
          || event.affectsConfiguration('editor.matchBrackets')) {
          this.contexts.clear();
          vscode.window.visibleTextEditors.forEach((editor) => this.schedule(editor, 0));
        }
      }),
      ...this.levelDecorations,
      this.unexpectedDecoration,
      this.matchingDecoration,
    ];
    vscode.window.visibleTextEditors.forEach((editor) => this.schedule(editor, 0));
  }

  dispose(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.disposables.forEach((disposable) => disposable.dispose());
  }

  private schedule(editor: vscode.TextEditor, delay = 40): void {
    if (editor.document.languageId !== 'sql-json') {
      return;
    }
    const existing = this.timers.get(editor);
    if (existing) {
      clearTimeout(existing);
    }
    this.timers.set(editor, setTimeout(() => {
      this.timers.delete(editor);
      this.update(editor);
    }, delay));
  }

  private update(editor: vscode.TextEditor): void {
    if (editor.document.isClosed || editor.document.languageId !== 'sql-json') {
      return;
    }
    const configuration = vscode.workspace.getConfiguration('editor', editor.document);
    const colorizationEnabled = configuration.get<boolean>('bracketPairColorization.enabled', true);
    const independentColors = configuration.get<boolean>(
      'bracketPairColorization.independentColorPoolPerBracketType',
      false,
    );
    const levels = Array.from({ length: VISIBLE_BRACKET_COLOR_COUNT }, () => [] as vscode.Range[]);
    const unexpected: vscode.Range[] = [];
    const analysis = this.contexts.get(editor.document);

    if (colorizationEnabled) {
      for (const candidate of analysis.regions) {
        for (const bracket of candidate.structure.brackets) {
          const range = rangeForDecodedOffset(editor.document, candidate, bracket.offset);
          if (!range) {
            continue;
          }
          if (bracket.unexpected) {
            unexpected.push(range);
          } else {
            const level = independentColors ? bracket.independentLevel : bracket.level;
            levels[visibleBracketColorIndex(level)]?.push(range);
          }
        }
      }
    }

    this.levelDecorations.forEach((decoration, index) => editor.setDecorations(decoration, levels[index] ?? []));
    editor.setDecorations(this.unexpectedDecoration, unexpected);
    editor.setDecorations(
      this.matchingDecoration,
      configuration.get<string>('matchBrackets', 'always') === 'never'
        ? []
        : matchingBracketRanges(editor, this.contexts),
    );
  }

  private clearTimers(document: vscode.TextDocument): void {
    for (const [editor, timer] of this.timers) {
      if (editor.document === document) {
        clearTimeout(timer);
        this.timers.delete(editor);
      }
    }
  }
}

export function matchingBracketRanges(
  editor: vscode.TextEditor,
  contexts: SqlEditingContextService,
): vscode.Range[] {
  const ranges: vscode.Range[] = [];
  const seen = new Set<string>();
  for (const selection of editor.selections) {
    const originalOffset = editor.document.offsetAt(selection.active);
    const candidate = contexts.findRegionAtOffset(editor.document, originalOffset);
    if (!candidate) {
      continue;
    }
    const decodedOffset = decodedOffsetAtOriginalOffset(candidate.region.decoded, originalOffset);
    const bracket = findBracketAt(candidate.structure, decodedOffset);
    if (!bracket || bracket.pairOffset === undefined) {
      continue;
    }
    for (const offset of [bracket.offset, bracket.pairOffset]) {
      const range = rangeForDecodedOffset(editor.document, candidate, offset);
      const key = range ? `${range.start.line}:${range.start.character}:${range.end.line}:${range.end.character}` : '';
      if (range && !seen.has(key)) {
        seen.add(key);
        ranges.push(range);
      }
    }
  }
  return ranges;
}

export function rangeForDecodedOffset(
  document: vscode.TextDocument,
  candidate: SqlEditingRegion,
  decodedOffset: number,
): vscode.Range | undefined {
  const spans = mapDecodedRange(candidate.region.decoded, decodedOffset, decodedOffset + 1);
  const first = spans[0];
  const last = spans.at(-1);
  return first && last
    ? new vscode.Range(document.positionAt(first.start), document.positionAt(last.end))
    : undefined;
}
