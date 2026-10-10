import type * as vscode from 'vscode';

import type { ExtensionConfiguration } from './config';
import { SqlServiceError } from './sqlService';
import type { SqlDocumentSnapshot } from './sqlWorkerProtocol';

export function sqlDocumentSnapshot(
  document: vscode.TextDocument,
  configuration: ExtensionConfiguration,
  text = document.getText(),
  region = 'document',
): SqlDocumentSnapshot {
  return {
    uri: document.uri.toString(),
    version: document.version,
    region,
    text,
    dialect: configuration.dialect,
    placeholderSources: configuration.placeholderSources,
  };
}

export function isSqlRequestCancelled(error: unknown): boolean {
  return error instanceof SqlServiceError && (error.code === 'cancelled' || error.code === 'stale');
}

export function sqlServiceFailureMessage(error: unknown): string {
  if (error instanceof SqlServiceError && error.code === 'timeout') {
    if (error.phase === 'startup') {
      return 'SQL worker startup timed out. Analysis can retry after the worker recovers.';
    }
    if (error.phase === 'schema') {
      return 'SQL Schema indexing timed out. Schema results are unavailable.';
    }
    return 'SQL analysis timed out. Results for this document version are unavailable.';
  }
  if (error instanceof SqlServiceError && error.retryable) {
    return 'SQL worker stopped or could not communicate. Analysis can retry after the worker recovers.';
  }
  return `SQL analysis could not complete: ${error instanceof Error ? error.message : String(error)}`;
}
