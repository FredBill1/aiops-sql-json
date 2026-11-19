import * as vscode from 'vscode';

import { getSqlSlowNotificationMs, isPlainSqlEnabled, SQL_SLOW_NOTIFICATION_SETTING } from './config';
import { getConfigurationResource, getResourceWorkspaceFolder } from './resourceContext';
import type { SqlParseRequest } from './sqlService';

const SHOW_PROGRESS_COMMAND = 'aiopsSqlJson.showAnalysisProgress';
export const FORCE_REPARSE_COMMAND = 'aiopsSqlJson.forceReparse';

type Outcome = 'ready' | 'failed';

export interface SqlAnalysisRequest extends SqlParseRequest {
  readonly cancellation: vscode.CancellationToken;
  finish(outcome?: Outcome): void;
  cancel(): void;
}

interface Presentation {
  close(): void;
  report?(): void;
}

interface AnalysisRun {
  requests: Set<SqlAnalysisRequest>;
  startedAt?: number;
  timer?: NodeJS.Timeout;
  slow: boolean;
  presentation?: Presentation;
  outcome?: Outcome;
}

interface AnalysisActivity {
  key: string;
  resource: vscode.Uri;
  document?: vscode.TextDocument;
  version?: number;
  outcome?: Outcome;
  pause?: symbol;
  run?: AnalysisRun;
}

interface StatusActions {
  schemaKey(document: vscode.TextDocument): string | undefined;
  retryDocument(document: vscode.TextDocument): void;
  retrySchema(document: vscode.TextDocument): Promise<void>;
}

export class SqlAnalysisProgress implements vscode.Disposable {
  private readonly documents = new Map<string, AnalysisActivity>();
  private readonly schemas = new Map<string, AnalysisActivity>();
  private readonly changed = new vscode.EventEmitter<void>();
  private readonly pausedDocument = new vscode.EventEmitter<vscode.TextDocument>();
  readonly onDidPauseDocument = this.pausedDocument.event;
  private disposed = false;

  private readonly settings = vscode.workspace.onDidChangeConfiguration((event) => {
    for (const activity of this.activities()) {
      if (activity.run && event.affectsConfiguration(SQL_SLOW_NOTIFICATION_SETTING, getConfigurationResource(activity.resource))) {
        this.updateTimer(activity, activity.run);
      }
    }
    this.changed.fire();
  });

  isDocumentPaused(document: vscode.TextDocument): boolean {
    return this.documents.get(document.uri.toString())?.pause !== undefined;
  }

  updateDocument(document: vscode.TextDocument): void {
    const activity = this.documents.get(document.uri.toString());
    if (!activity || activity.version === document.version) return;
    this.stop(activity);
    activity.version = document.version;
    activity.outcome = undefined;
    this.changed.fire();
  }

  beginDocument(document: vscode.TextDocument, cancellation?: vscode.CancellationToken): SqlAnalysisRequest | undefined {
    if (this.disposed || document.isClosed || cancellation?.isCancellationRequested) return undefined;
    this.updateDocument(document);
    const key = document.uri.toString();
    let activity = this.documents.get(key);
    if (!activity) {
      activity = { key, resource: document.uri, document, version: document.version };
      this.documents.set(key, activity);
    }
    return activity.pause ? undefined : this.begin(activity, cancellation);
  }

  restartDocument(document: vscode.TextDocument): void {
    const activity = this.documents.get(document.uri.toString());
    if (!activity) return;
    this.stop(activity);
    activity.outcome = undefined;
    activity.pause = undefined;
    this.changed.fire();
  }

  closeDocument(document: vscode.TextDocument): void {
    const key = document.uri.toString();
    const activity = this.documents.get(key);
    if (!activity) return;
    this.documents.delete(key);
    this.stop(activity);
    this.changed.fire();
  }

  resetDocuments(): void {
    for (const activity of this.documents.values()) {
      this.stop(activity);
      activity.outcome = undefined;
    }
    this.changed.fire();
  }

  beginSchema(key: string, resource: vscode.Uri): SqlAnalysisRequest | undefined {
    if (this.disposed) return undefined;
    let activity = this.schemas.get(key);
    if (!activity) {
      activity = { key, resource };
      this.schemas.set(key, activity);
    }
    return activity.pause ? undefined : this.begin(activity);
  }

  isSchemaPaused(key: string): boolean { return this.schemas.get(key)?.pause !== undefined; }

  resumeSchema(key: string): void {
    if (!this.isSchemaPaused(key)) return;
    this.schemas.delete(key);
    this.changed.fire();
  }

  registerStatusBar(actions: StatusActions): vscode.Disposable {
    const item = vscode.window.createStatusBarItem('aiopsSqlJson.analysis', vscode.StatusBarAlignment.Right);
    item.name = 'AIOps SQL JSON Analysis';
    const activeDocument = (): vscode.TextDocument | undefined => {
      const document = vscode.window.activeTextEditor?.document;
      if (document?.languageId === 'sql-json'
        || (document?.languageId === 'sql' && isPlainSqlEnabled(document.uri))) return document;
      return undefined;
    };
    const activityFor = (document: vscode.TextDocument): AnalysisActivity | undefined => {
      const documentActivity = this.documents.get(document.uri.toString());
      if (documentActivity?.pause || documentActivity?.run || !this.schemas.size) return documentActivity;
      const key = actions.schemaKey(document);
      return (key ? this.schemas.get(key) : undefined) ?? documentActivity;
    };
    const update = (): void => {
      const document = activeDocument();
      if (!document) { item.hide(); return; }
      const activity = activityFor(document);
      const schema = activity && !activity.document;
      let text = '$(clock) SQL Waiting…';
      let tooltip = 'Waiting to analyze SQL';
      if (activity?.pause) {
        text = schema ? '$(debug-pause) Schema Paused' : '$(debug-pause) SQL Paused';
        tooltip = schema ? 'Click to retry the shared Schema index' : 'Click to retry SQL analysis';
      } else if (activity?.run) {
        if (activity.run.startedAt !== undefined) {
          text = schema ? '$(sync~spin) SQL Indexing Schema…' : '$(sync~spin) SQL Analyzing…';
        } else if (schema) text = '$(clock) SQL Waiting for Schema…';
        tooltip = schema ? 'Click for shared Schema indexing progress' : 'Click for SQL analysis progress';
      } else if (activity?.outcome === 'ready') {
        text = '$(check) SQL Ready';
        tooltip = 'SQL analysis completed';
      } else if (activity?.outcome === 'failed') {
        text = '$(warning) SQL Analysis Failed';
        tooltip = 'Run Force Reparse SQL to try again';
      }
      item.text = text;
      item.tooltip = tooltip;
      item.command = activity?.pause || activity?.run ? SHOW_PROGRESS_COMMAND : undefined;
      item.show();
    };
    const command = vscode.commands.registerCommand(SHOW_PROGRESS_COMMAND, async () => {
      const document = activeDocument();
      if (!document) return;
      const activity = activityFor(document);
      if (activity?.run) {
        // VS Code retains progress toasts briefly after completion. Reveal the existing item instead of creating a duplicate.
        if (activity.run.presentation) await vscode.commands.executeCommand('notifications.showList');
        else this.present(activity, activity.run);
      } else if (activity?.pause) {
        const pause = activity.pause;
        const message = activity.document ? 'SQL analysis is paused' : 'Shared SQL Schema indexing is paused';
        const action = await vscode.window.showInformationMessage(`${message} for ${this.label(activity)}.`, 'Retry');
        if (action !== 'Retry' || document.isClosed || activity.pause !== pause) return;
        if (activity.document && this.documents.get(activity.key) === activity) actions.retryDocument(document);
        else if (!activity.document && this.schemas.get(activity.key) === activity
          && actions.schemaKey(document) === activity.key) await actions.retrySchema(document);
      }
    });
    update();
    return vscode.Disposable.from(item, command, this.changed.event(update), vscode.window.onDidChangeActiveTextEditor(update));
  }

  dispose(): void {
    this.disposed = true;
    this.settings.dispose();
    for (const activity of this.activities()) this.stop(activity);
    this.documents.clear();
    this.schemas.clear();
    this.pausedDocument.dispose();
    this.changed.dispose();
  }

  private *activities(): Iterable<AnalysisActivity> {
    yield* this.documents.values();
    yield* this.schemas.values();
  }

  private begin(activity: AnalysisActivity, cancellation?: vscode.CancellationToken): SqlAnalysisRequest {
    const run = activity.run ??= { requests: new Set(), slow: false };
    const source = new vscode.CancellationTokenSource();
    const request: SqlAnalysisRequest = {
      cancellation: source.token,
      onWorkerStart: () => {
        if (activity.run !== run || !run.requests.has(request) || run.startedAt !== undefined) return;
        run.startedAt = performance.now();
        this.updateTimer(activity, run);
        this.changed.fire();
      },
      cancel: () => {
        if (!run.requests.has(request)) return;
        source.cancel();
        request.finish();
      },
      finish: (outcome) => {
        if (!run.requests.delete(request)) return;
        subscription?.dispose();
        source.dispose();
        if (activity.run !== run) return;
        if (outcome === 'failed' || !run.outcome) run.outcome = outcome;
        if (run.requests.size === 0) {
          activity.outcome = run.outcome ?? activity.outcome;
          this.stop(activity);
          if (!activity.document) this.schemas.delete(activity.key);
          this.changed.fire();
        }
      },
    };
    run.requests.add(request);
    const subscription = cancellation?.onCancellationRequested(request.cancel);
    if (cancellation?.isCancellationRequested) request.cancel();
    if (run.requests.size === 1) this.changed.fire();
    return request;
  }

  private stop(activity: AnalysisActivity): void {
    const run = activity.run;
    if (!run) return;
    activity.run = undefined;
    if (run.timer) clearTimeout(run.timer);
    this.closePresentation(run);
    for (const request of run.requests) request.cancel();
  }

  private updateTimer(activity: AnalysisActivity, run: AnalysisRun): void {
    if (run.timer) clearTimeout(run.timer);
    run.timer = undefined;
    if (activity.run !== run || run.startedAt === undefined) return;
    const remaining = getSqlSlowNotificationMs(activity.resource) - (performance.now() - run.startedAt);
    run.slow = remaining <= 0;
    if (run.slow && !run.presentation) {
      this.present(activity, run);
      return;
    }
    if (!run.slow) {
      run.timer = setTimeout(() => this.updateTimer(activity, run), Math.ceil(remaining));
    }
    run.presentation?.report?.();
  }

  private closePresentation(run: AnalysisRun): void {
    const presentation = run.presentation;
    run.presentation = undefined;
    presentation?.close();
  }

  private present(activity: AnalysisActivity, run: AnalysisRun): void {
    let close!: () => void;
    const pending = new Promise<void>((resolve) => { close = resolve; });
    const presentation: Presentation = { close };
    run.presentation = presentation;
    const title = activity.document ? 'SQL analysis' : 'Shared SQL Schema indexing';
    const isCurrent = (): boolean => activity.run === run && run.presentation === presentation;
    void Promise.resolve(vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification, title: `${title} for ${this.label(activity)}`, cancellable: true,
    }, async (progress, token) => {
      if (!isCurrent()) return;
      presentation.report = () => progress.report({ message: run.slow ? 'Taking longer than expected…'
        : run.startedAt === undefined ? 'Waiting…' : 'Running…' });
      presentation.report();
      const cancel = (): void => {
        if (!isCurrent()) return;
        activity.pause = Symbol();
        this.stop(activity);
        this.changed.fire();
        if (activity.document) this.pausedDocument.fire(activity.document);
      };
      const subscription = token.onCancellationRequested(cancel);
      try {
        if (token.isCancellationRequested) cancel();
        await pending;
      } finally { subscription.dispose(); }
    })).catch(() => { if (isCurrent()) this.closePresentation(run); });
  }

  private label(activity: AnalysisActivity): string {
    return (!activity.document && getResourceWorkspaceFolder(activity.resource)?.name)
      || vscode.workspace.asRelativePath(activity.resource, true) || activity.resource.toString(true);
  }
}
