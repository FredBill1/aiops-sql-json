import * as vscode from 'vscode';

import { lexicalStateAt, type SqlLexicalState } from './editingCore';
import type { SqlEditingContextService, SqlEditingRegion } from './editingContext';
import { decodedOffsetAtOriginalOffset } from './regions';

const DELETE_LEFT_COMMAND = 'aiopsSqlJson.deleteLeft';

interface TypeCommandArguments {
  text?: unknown;
}

interface PlannedSelection {
  oldStart: number;
  oldEnd: number;
  replacement?: string;
  anchorRelative: number;
  activeRelative: number;
}

interface PairSource {
  open: string;
  close: string;
}

const BRACKET_PAIRS = new Map<string, string>([
  ['(', ')'],
  ['[', ']'],
  ['{', '}'],
]);

const CLOSING_BRACKETS = new Set(BRACKET_PAIRS.values());
const QUOTES = new Set(["'", '"', '`']);
const SPECIAL_CHARACTERS = new Set([...BRACKET_PAIRS.keys(), ...CLOSING_BRACKETS, ...QUOTES]);

export class SqlEditingController implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[];
  private typeDisposable: vscode.Disposable | undefined;

  constructor(private readonly contexts: SqlEditingContextService) {
    this.disposables = [
      vscode.commands.registerCommand(DELETE_LEFT_COMMAND, () => this.deleteLeft()),
      vscode.window.onDidChangeActiveTextEditor(() => this.updateTypeOverride()),
    ];
    this.updateTypeOverride();
  }

  dispose(): void {
    this.typeDisposable?.dispose();
    this.typeDisposable = undefined;
    this.disposables.forEach((disposable) => disposable.dispose());
  }

  private updateTypeOverride(): void {
    const shouldRegister = vscode.window.activeTextEditor?.document.languageId === 'sql-json';
    if (shouldRegister && !this.typeDisposable) {
      this.typeDisposable = vscode.commands.registerCommand(
        'type',
        (argumentsValue: TypeCommandArguments | undefined) => this.type(argumentsValue),
      );
    } else if (!shouldRegister && this.typeDisposable) {
      this.typeDisposable.dispose();
      this.typeDisposable = undefined;
    }
  }

  private async type(argumentsValue: TypeCommandArguments | undefined): Promise<void> {
    const text = argumentsValue?.text;
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'sql-json' || typeof text !== 'string'
      || [...text].length !== 1 || !SPECIAL_CHARACTERS.has(text)) {
      await vscode.commands.executeCommand('default:type', argumentsValue);
      return;
    }

    const document = editor.document;
    const plans: PlannedSelection[] = [];
    for (const selection of editor.selections) {
      const start = document.offsetAt(selection.start);
      const end = document.offsetAt(selection.end);
      const region = this.contexts.findRegionContainingRange(document, start, end);
      if (!region) {
        await vscode.commands.executeCommand('default:type', argumentsValue);
        return;
      }
      plans.push(planTypedCharacter(document, selection, region, text));
    }

    if (hasOverlappingPlans(plans)) {
      await vscode.commands.executeCommand('default:type', argumentsValue);
      return;
    }
    await applyPlans(editor, plans);
  }

  private async deleteLeft(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'sql-json') {
      await vscode.commands.executeCommand('deleteLeft');
      return;
    }
    const deleteSetting = getEditorSetting<string>(editor.document, 'autoClosingDelete', 'auto');
    if (deleteSetting === 'never' || editor.selections.some((selection) => !selection.isEmpty)) {
      await vscode.commands.executeCommand('deleteLeft');
      return;
    }

    const plans: PlannedSelection[] = [];
    for (const selection of editor.selections) {
      const caret = editor.document.offsetAt(selection.active);
      const region = this.contexts.findRegionAtOffset(editor.document, caret);
      const pair = region ? findEmptyPair(editor.document, region, caret) : undefined;
      if (!pair) {
        await vscode.commands.executeCommand('deleteLeft');
        return;
      }
      plans.push({
        oldStart: caret - pair.open.length,
        oldEnd: caret + pair.close.length,
        replacement: '',
        anchorRelative: 0,
        activeRelative: 0,
      });
    }

    if (hasOverlappingPlans(plans)) {
      await vscode.commands.executeCommand('deleteLeft');
      return;
    }
    await applyPlans(editor, plans);
  }
}

function planTypedCharacter(
  document: vscode.TextDocument,
  selection: vscode.Selection,
  region: SqlEditingRegion,
  input: string,
): PlannedSelection {
  const oldStart = document.offsetAt(selection.start);
  const oldEnd = document.offsetAt(selection.end);
  const selectedText = document.getText(selection);
  const decodedOffset = decodedOffsetAtOriginalOffset(region.region.decoded, oldStart);
  const source = document.getText();
  const manualDoubleQuoteEscape = input === '"' && hasOddBackslashPrefix(source, oldStart);
  const state = manualDoubleQuoteEscape && source[oldStart] === '"'
    ? 'code'
    : lexicalStateAt(region.structure, decodedOffset);
  const inputSource = sourceForQuoteInput(source, oldStart, input);

  if (!selection.isEmpty) {
    const close = BRACKET_PAIRS.get(input) ?? (QUOTES.has(input) ? input : undefined);
    if (close && shouldSurround(document, input)) {
      const closeSource = sourceForClose(close);
      const replacement = `${inputSource}${selectedText}${closeSource}`;
      const contentStart = inputSource.length;
      const contentEnd = contentStart + selectedText.length;
      return {
        oldStart,
        oldEnd,
        replacement,
        anchorRelative: selection.isReversed ? contentEnd : contentStart,
        activeRelative: selection.isReversed ? contentStart : contentEnd,
      };
    }
    return replacementPlan(oldStart, oldEnd, inputSource);
  }

  const overtypeSource = sourceForClose(input);
  if ((CLOSING_BRACKETS.has(input) || QUOTES.has(input))
    && shouldOvertype(document)
    && canOvertype(document, oldStart, overtypeSource, state, input)) {
    return {
      oldStart,
      oldEnd,
      anchorRelative: overtypeSource.length,
      activeRelative: overtypeSource.length,
    };
  }

  const close = BRACKET_PAIRS.get(input) ?? (QUOTES.has(input) ? input : undefined);
  const category = QUOTES.has(input) ? 'quotes' : 'brackets';
  if (close && state === 'code' && shouldAutoClose(document, category, oldStart)) {
    const closeSource = sourceForClose(close);
    return {
      oldStart,
      oldEnd,
      replacement: `${inputSource}${closeSource}`,
      anchorRelative: inputSource.length,
      activeRelative: inputSource.length,
    };
  }

  return replacementPlan(oldStart, oldEnd, inputSource);
}

function replacementPlan(oldStart: number, oldEnd: number, replacement: string): PlannedSelection {
  return {
    oldStart,
    oldEnd,
    replacement,
    anchorRelative: replacement.length,
    activeRelative: replacement.length,
  };
}

async function applyPlans(editor: vscode.TextEditor, plans: readonly PlannedSelection[]): Promise<void> {
  const edits = plans.filter((plan) => plan.replacement !== undefined)
    .sort((left, right) => left.oldStart - right.oldStart);
  if (edits.length > 0) {
    const applied = await editor.edit((builder) => {
      for (const plan of edits) {
        builder.replace(
          new vscode.Range(editor.document.positionAt(plan.oldStart), editor.document.positionAt(plan.oldEnd)),
          plan.replacement ?? '',
        );
      }
    }, { undoStopBefore: false, undoStopAfter: false });
    if (!applied) {
      return;
    }
  }

  editor.selections = plans.map((plan) => {
    const shift = edits.reduce((total, edit) => (
      edit.oldStart < plan.oldStart
        ? total + (edit.replacement?.length ?? 0) - (edit.oldEnd - edit.oldStart)
        : total
    ), 0);
    const base = plan.oldStart + shift;
    return new vscode.Selection(
      editor.document.positionAt(base + plan.anchorRelative),
      editor.document.positionAt(base + plan.activeRelative),
    );
  });
}

function canOvertype(
  document: vscode.TextDocument,
  offset: number,
  closeSource: string,
  state: SqlLexicalState,
  input: string,
): boolean {
  if (!document.getText().startsWith(closeSource, offset)) {
    return false;
  }
  if (CLOSING_BRACKETS.has(input)) {
    return state === 'code';
  }
  if (input === "'") {
    return state === 'singleQuote' || state === 'code';
  }
  if (input === '"') {
    return state === 'doubleQuote' || state === 'code';
  }
  return state === 'backtick' || state === 'code';
}

function shouldAutoClose(
  document: vscode.TextDocument,
  category: 'brackets' | 'quotes',
  offset: number,
): boolean {
  const settingName = category === 'quotes' ? 'autoClosingQuotes' : 'autoClosingBrackets';
  const setting = getEditorSetting<string>(document, settingName, 'languageDefined');
  if (setting === 'never') {
    return false;
  }
  if (setting === 'always') {
    return true;
  }
  const next = document.getText()[offset] ?? '';
  if (setting === 'beforeWhitespace') {
    return next === '' || /\s/u.test(next);
  }
  return next === '' || /[\s)}\]>:;,."']/u.test(next);
}

function shouldSurround(document: vscode.TextDocument, input: string): boolean {
  const setting = getEditorSetting<string>(document, 'autoSurround', 'languageDefined');
  if (setting === 'never') {
    return false;
  }
  if (setting === 'quotes') {
    return QUOTES.has(input);
  }
  if (setting === 'brackets') {
    return BRACKET_PAIRS.has(input);
  }
  return QUOTES.has(input) || BRACKET_PAIRS.has(input);
}

function shouldOvertype(document: vscode.TextDocument): boolean {
  return getEditorSetting<string>(document, 'autoClosingOvertype', 'auto') !== 'never';
}

function sourceForQuoteInput(source: string, offset: number, input: string): string {
  if (input !== '"') {
    return input;
  }
  return hasOddBackslashPrefix(source, offset) ? '"' : '\\"';
}

function sourceForClose(character: string): string {
  return character === '"' ? '\\"' : character;
}

function hasOddBackslashPrefix(source: string, offset: number): boolean {
  let count = 0;
  for (let index = offset - 1; index >= 0 && source[index] === '\\'; index -= 1) {
    count += 1;
  }
  return count % 2 === 1;
}

function findEmptyPair(
  document: vscode.TextDocument,
  region: SqlEditingRegion,
  caret: number,
): PairSource | undefined {
  const source = document.getText();
  const candidates: PairSource[] = [
    { open: '\\"', close: '\\"' },
    { open: '(', close: ')' },
    { open: '[', close: ']' },
    { open: '{', close: '}' },
    { open: "'", close: "'" },
    { open: '`', close: '`' },
  ];
  for (const candidate of candidates) {
    if (!source.startsWith(candidate.open, caret - candidate.open.length)
      || !source.startsWith(candidate.close, caret)) {
      continue;
    }
    const decodedOffset = decodedOffsetAtOriginalOffset(region.region.decoded, caret);
    if (candidate.open === '(' || candidate.open === '[' || candidate.open === '{') {
      const bracket = region.structure.brackets.find((item) => item.offset === decodedOffset - 1);
      if (bracket?.pairOffset === decodedOffset) {
        return candidate;
      }
      continue;
    }
    const expectedState: SqlLexicalState = candidate.open === "'"
      ? 'singleQuote'
      : candidate.open === '`' ? 'backtick' : 'doubleQuote';
    if (lexicalStateAt(region.structure, decodedOffset) === expectedState
      && lexicalStateAt(region.structure, decodedOffset - 1) === 'code') {
      return candidate;
    }
  }
  return undefined;
}

function hasOverlappingPlans(plans: readonly PlannedSelection[]): boolean {
  const sorted = [...plans].sort((left, right) => left.oldStart - right.oldStart || left.oldEnd - right.oldEnd);
  return sorted.some((plan, index) => {
    const previous = sorted[index - 1];
    return previous !== undefined && plan.oldStart < previous.oldEnd;
  });
}

function getEditorSetting<T>(document: vscode.TextDocument, name: string, fallback: T): T {
  return vscode.workspace.getConfiguration('editor', document).get<T>(name, fallback);
}
