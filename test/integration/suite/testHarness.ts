import * as assert from 'node:assert/strict';

import * as vscode from 'vscode';

const ASYNC_TIMEOUT_MS = 15_000;

export interface ManagedConfiguration {
  readonly section: string;
  readonly key: string;
  readonly target: vscode.ConfigurationTarget.Global | vscode.ConfigurationTarget.WorkspaceFolder;
  readonly resource?: vscode.Uri;
}

interface ConfigurationSnapshot extends ManagedConfiguration {
  readonly value: unknown;
}

interface PendingEditorChange {
  readonly promise: Promise<void>;
  dispose(): void;
}

export class IntegrationTestFixture {
  private readonly documents: vscode.TextDocument[] = [];
  private readonly diagnosticGenerations = new Map<string, number>();
  private readonly consumedDiagnosticGenerations = new Map<string, number>();
  private readonly diagnosticSubscription: vscode.Disposable;
  private configurationSnapshots: ConfigurationSnapshot[] = [];

  constructor(private readonly managedConfigurations: readonly ManagedConfiguration[]) {
    this.diagnosticSubscription = vscode.languages.onDidChangeDiagnostics((event) => {
      for (const uri of event.uris) {
        const key = uri.toString();
        this.diagnosticGenerations.set(key, (this.diagnosticGenerations.get(key) ?? 0) + 1);
      }
    });
  }

  async captureConfiguration(): Promise<void> {
    this.configurationSnapshots = this.managedConfigurations.map((setting) => {
      const inspected = vscode.workspace.getConfiguration(setting.section, setting.resource).inspect(setting.key);
      assert.ok(inspected, `Configuration ${setting.section}.${setting.key} must be inspectable.`);
      return {
        ...setting,
        value: setting.target === vscode.ConfigurationTarget.Global
          ? inspected.globalValue
          : inspected.workspaceFolderValue,
      };
    });
  }

  async openUri(uri: vscode.Uri, show = false): Promise<vscode.TextDocument> {
    const document = await vscode.workspace.openTextDocument(uri);
    this.trackDocument(document);
    if (show) await this.showDocument(document);
    return document;
  }

  async openUntitled(
    options: { language?: string; content?: string },
    show = true,
  ): Promise<vscode.TextDocument> {
    const document = await vscode.workspace.openTextDocument(options);
    this.trackDocument(document);
    if (show) await this.showDocument(document);
    return document;
  }

  trackDocument(document: vscode.TextDocument): void {
    if (!this.documents.some((candidate) => candidate.uri.toString() === document.uri.toString())) {
      this.documents.push(document);
    }
  }

  async showDocument(document: vscode.TextDocument): Promise<vscode.TextEditor> {
    const editor = await vscode.window.showTextDocument(document, {
      preview: false,
      preserveFocus: false,
    });
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    await waitForEventCondition(
      `active editor ${document.uri.toString()}`,
      () => vscode.window.activeTextEditor?.document.uri.toString() === document.uri.toString(),
      (check) => vscode.window.onDidChangeActiveTextEditor(check),
    );
    return editor;
  }

  async executeEditorCommand(
    editor: vscode.TextEditor,
    command: string,
    args?: unknown,
  ): Promise<void> {
    const activeEditor = await this.showDocument(editor.document);
    const beforeVersion = activeEditor.document.version;
    const beforeSelection = activeEditor.selection;
    const pendingChange = observeEditorChange(activeEditor, beforeVersion, beforeSelection, command);
    try {
      if (args === undefined) {
        await vscode.commands.executeCommand(command);
      } else {
        await vscode.commands.executeCommand(command, args);
      }
      if (editorChanged(activeEditor, beforeVersion, beforeSelection)) return;
      await pendingChange.promise;
    } finally {
      pendingChange.dispose();
    }
  }

  async typeText(editor: vscode.TextEditor, text: string): Promise<void> {
    await this.executeEditorCommand(editor, 'type', { text });
  }

  async waitForDiagnostics(
    uri: vscode.Uri,
    predicate: (diagnostics: readonly vscode.Diagnostic[]) => boolean = () => true,
  ): Promise<readonly vscode.Diagnostic[]> {
    const key = uri.toString();
    const baseline = this.consumedDiagnosticGenerations.get(key) ?? 0;

    return new Promise<readonly vscode.Diagnostic[]>((resolve, reject) => {
      let settled = false;
      const finish = (diagnostics: readonly vscode.Diagnostic[]): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        subscription.dispose();
        this.consumedDiagnosticGenerations.set(key, this.diagnosticGenerations.get(key) ?? baseline);
        resolve(diagnostics);
      };
      const check = (): void => {
        const generation = this.diagnosticGenerations.get(key) ?? 0;
        const diagnostics = vscode.languages.getDiagnostics(uri);
        if (generation > baseline && predicate(diagnostics)) finish(diagnostics);
      };
      const subscription = vscode.languages.onDidChangeDiagnostics((event) => {
        if (event.uris.some((changedUri) => changedUri.toString() === key)) check();
      });
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        subscription.dispose();
        const diagnostics = vscode.languages.getDiagnostics(uri);
        reject(new Error([
          `Timed out waiting for fresh diagnostics for ${key}.`,
          `Observed generation: ${this.diagnosticGenerations.get(key) ?? 0}; required: > ${baseline}.`,
          `Last diagnostics: ${summarizeDiagnostics(diagnostics)}`,
        ].join(' ')));
      }, ASYNC_TIMEOUT_MS);
      check();
    });
  }

  async waitForCompletionItems(
    document: vscode.TextDocument,
    offset: number,
    predicate: (items: readonly vscode.CompletionItem[]) => boolean,
    expectation = 'matching completion items',
  ): Promise<readonly vscode.CompletionItem[]> {
    return pollProvider(
      `completion items (${expectation}) at ${document.uri.toString()}:${offset}`,
      async () => {
        const result = await vscode.commands.executeCommand<vscode.CompletionList | undefined>(
          'vscode.executeCompletionItemProvider',
          document.uri,
          document.positionAt(offset),
        );
        return result?.items ?? [];
      },
      predicate,
      (items) => items.slice(0, 30).map(completionLabel).join(', ') || '<none>',
    );
  }

  async waitForCompletionList(
    document: vscode.TextDocument,
    offset: number,
    predicate: (list: vscode.CompletionList) => boolean,
    expectation = 'matching completion list',
  ): Promise<vscode.CompletionList> {
    return pollProvider(
      `completion list (${expectation}) at ${document.uri.toString()}:${offset}`,
      async () => (await vscode.commands.executeCommand<vscode.CompletionList | undefined>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        document.positionAt(offset),
      )) ?? new vscode.CompletionList(),
      predicate,
      (list) => `${list.items.length} item(s), incomplete=${list.isIncomplete}`,
    );
  }

  async waitForHovers(
    document: vscode.TextDocument,
    offset: number,
    predicate: (hovers: readonly vscode.Hover[]) => boolean,
    expectation = 'matching hover results',
  ): Promise<readonly vscode.Hover[]> {
    return pollProvider(
      `hover results (${expectation}) at ${document.uri.toString()}:${offset}`,
      async () => (await vscode.commands.executeCommand<vscode.Hover[] | undefined>(
        'vscode.executeHoverProvider',
        document.uri,
        document.positionAt(offset),
      )) ?? [],
      predicate,
      (hovers) => `${hovers.length} hover(s)`,
    );
  }

  async waitForDefinitions(
    document: vscode.TextDocument,
    offset: number,
    predicate: (definitions: readonly (vscode.Location | vscode.LocationLink)[]) => boolean,
    expectation = 'matching definition results',
  ): Promise<readonly (vscode.Location | vscode.LocationLink)[]> {
    return pollProvider(
      `definition results (${expectation}) at ${document.uri.toString()}:${offset}`,
      async () => (await vscode.commands.executeCommand<Array<vscode.Location | vscode.LocationLink> | undefined>(
        'vscode.executeDefinitionProvider',
        document.uri,
        document.positionAt(offset),
      )) ?? [],
      predicate,
      (definitions) => definitions.map(definitionUri).join(', ') || '<none>',
    );
  }

  async dispose(): Promise<void> {
    const cleanupErrors: unknown[] = [];
    for (const document of [...this.documents].reverse()) {
      try {
        await closeDocument(document);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    for (const snapshot of [...this.configurationSnapshots].reverse()) {
      try {
        await restoreConfiguration(snapshot);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    this.diagnosticSubscription.dispose();
    if (cleanupErrors.length > 0) {
      const details = cleanupErrors.map((error) => error instanceof Error ? error.message : String(error)).join(' | ');
      throw new AggregateError(cleanupErrors, `Integration test fixture cleanup failed: ${details}`);
    }
  }
}

export function completionLabel(item: vscode.CompletionItem): string {
  return typeof item.label === 'string' ? item.label : item.label.label;
}

function observeEditorChange(
  editor: vscode.TextEditor,
  beforeVersion: number,
  beforeSelection: vscode.Selection,
  command: string,
): PendingEditorChange {
  let settled = false;
  let resolvePromise: (() => void) | undefined;
  let rejectPromise: ((error: Error) => void) | undefined;
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  const finishIfChanged = (): void => {
    if (!settled && editorChanged(editor, beforeVersion, beforeSelection)) {
      settled = true;
      resolvePromise?.();
    }
  };
  const documentSubscription = vscode.workspace.onDidChangeTextDocument((event) => {
    if (event.document === editor.document) finishIfChanged();
  });
  const selectionSubscription = vscode.window.onDidChangeTextEditorSelection((event) => {
    if (event.textEditor === editor) finishIfChanged();
  });
  const timeout = setTimeout(() => {
    if (settled) return;
    settled = true;
    rejectPromise?.(new Error(
      `Command ${command} did not change document text or selection for ${editor.document.uri.toString()}.`,
    ));
  }, ASYNC_TIMEOUT_MS);
  return {
    promise,
    dispose: () => {
      settled = true;
      clearTimeout(timeout);
      documentSubscription.dispose();
      selectionSubscription.dispose();
    },
  };
}

function editorChanged(
  editor: vscode.TextEditor,
  beforeVersion: number,
  beforeSelection: vscode.Selection,
): boolean {
  return editor.document.version !== beforeVersion || !editor.selection.isEqual(beforeSelection);
}

async function waitForEventCondition(
  label: string,
  predicate: () => boolean,
  subscribe: (check: () => void) => vscode.Disposable,
): Promise<void> {
  if (predicate()) return;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const check = (): void => {
      if (settled || !predicate()) return;
      settled = true;
      clearTimeout(timeout);
      subscription.dispose();
      resolve();
    };
    const subscription = subscribe(check);
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      subscription.dispose();
      reject(new Error(`Timed out waiting for ${label}.`));
    }, ASYNC_TIMEOUT_MS);
    check();
  });
}

async function pollProvider<T>(
  label: string,
  query: () => Promise<T>,
  predicate: (value: T) => boolean,
  summarize: (value: T) => string,
): Promise<T> {
  const timeoutAt = Date.now() + ASYNC_TIMEOUT_MS;
  let retryDelayMs = 50;
  let lastValue = await query();
  while (!predicate(lastValue) && Date.now() < timeoutAt) {
    await delay(Math.min(retryDelayMs, Math.max(0, timeoutAt - Date.now())));
    retryDelayMs = Math.min(retryDelayMs * 2, 500);
    lastValue = await query();
  }
  if (!predicate(lastValue)) {
    throw new Error(`Timed out waiting for ${label}. Last result: ${summarize(lastValue)}.`);
  }
  return lastValue;
}

async function closeDocument(document: vscode.TextDocument): Promise<void> {
  if (document.isClosed) return;
  const uri = document.uri;
  const cleanupDocument = document.languageId === 'plaintext'
    ? document
    : await vscode.languages.setTextDocumentLanguage(document, 'plaintext');
  if (cleanupDocument.isUntitled && cleanupDocument.isDirty) {
    await vscode.window.showTextDocument(cleanupDocument, { preview: false, preserveFocus: false });
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  } else {
    if (cleanupDocument.isDirty) {
      assert.equal(await cleanupDocument.save(), true, `Could not save temporary test document ${uri.toString()}.`);
    }
    const tab = findTextTab(uri);
    if (tab) {
      assert.equal(
        await vscode.window.tabGroups.close(tab),
        true,
        `Could not close editor tab for ${uri.toString()}.`,
      );
    }
  }
  await waitForEventCondition(
    `editor tab for ${uri.toString()} to close`,
    () => findTextTab(uri) === undefined,
    (check) => vscode.Disposable.from(
      vscode.workspace.onDidCloseTextDocument((closed) => {
        if (closed.uri.toString() === uri.toString()) check();
      }),
      vscode.window.tabGroups.onDidChangeTabs(check),
    ),
  );
}

function findTextTab(uri: vscode.Uri): vscode.Tab | undefined {
  return vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .find((candidate) => candidate.input instanceof vscode.TabInputText
      && candidate.input.uri.toString() === uri.toString());
}

async function restoreConfiguration(snapshot: ConfigurationSnapshot): Promise<void> {
  const configuration = vscode.workspace.getConfiguration(snapshot.section, snapshot.resource);
  const inspected = configuration.inspect(snapshot.key);
  assert.ok(inspected, `Configuration ${snapshot.section}.${snapshot.key} must be inspectable during cleanup.`);
  const currentValue = snapshot.target === vscode.ConfigurationTarget.Global
    ? inspected.globalValue
    : inspected.workspaceFolderValue;
  if (deepEqual(currentValue, snapshot.value)) return;

  const qualifiedKey = `${snapshot.section}.${snapshot.key}`;
  const changed = waitForEventCondition(
    `configuration ${qualifiedKey} to be restored`,
    () => {
      const current = vscode.workspace.getConfiguration(snapshot.section, snapshot.resource).inspect(snapshot.key);
      const value = snapshot.target === vscode.ConfigurationTarget.Global
        ? current?.globalValue
        : current?.workspaceFolderValue;
      return deepEqual(value, snapshot.value);
    },
    (check) => vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(qualifiedKey, snapshot.resource)) check();
    }),
  );
  await Promise.all([
    configuration.update(snapshot.key, snapshot.value, snapshot.target),
    changed,
  ]);
}

function deepEqual(left: unknown, right: unknown): boolean {
  try {
    assert.deepEqual(left, right);
    return true;
  } catch {
    return false;
  }
}

function summarizeDiagnostics(diagnostics: readonly vscode.Diagnostic[]): string {
  if (diagnostics.length === 0) return '<none>';
  return diagnostics.slice(0, 10).map((diagnostic) => {
    const code = typeof diagnostic.code === 'object' ? diagnostic.code.value : diagnostic.code;
    return `${code ?? 'no-code'}: ${diagnostic.message}`;
  }).join(' | ');
}

function definitionUri(definition: vscode.Location | vscode.LocationLink): string {
  return ('targetUri' in definition ? definition.targetUri : definition.uri).toString();
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
