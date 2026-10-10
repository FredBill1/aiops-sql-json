import type { SqlFormatConfiguration } from './config';
import type { SqlFunctionDefinition } from './sqlFunctionSignatures';
import type { EditorFormattingOptions } from './sqlFormatting';
import type { SchemaSnapshot, SqlScopeInfo, SqlSemanticIssue, SqlSymbolResolution } from './sqlSchemaCore';
import type { SqlDialect } from './sqlDialect';
import type { SqlAnalysis, SqlToken } from './sqlTypes';

export interface SqlDocumentSnapshot {
  uri: string;
  version: number;
  region: string;
  text: string;
  dialect: SqlDialect;
  placeholderSources: readonly string[];
}

export interface SqlCancellationToken {
  readonly isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): { dispose(): void };
}

export interface SqlAnalysisOptions {
  schemaKey?: string;
  udfs?: readonly string[];
  validateSchema?: boolean;
}

export interface SqlCompletionOptions {
  allSqlTexts?: readonly string[];
  schemaKey?: string;
  udfs?: readonly string[];
}

export interface SqlAnalysisResult {
  sql: SqlAnalysis;
  semantics: SqlSemanticIssue[];
}

export interface SqlCompletionResult {
  context: {
    word: { start: number; end: number };
    prefix: string;
    casingPrefix: string;
    qualifier?: string;
    nextCharacter?: string;
    expressionContext: boolean;
  };
  keywords: string[];
  syntaxTypes: string[];
  fields: string[];
  schema: SchemaSnapshot;
  scope: SqlScopeInfo;
  catalog: {
    version: string;
    keywords: readonly string[];
    functions: readonly string[];
    functionDefinitions: readonly SqlFunctionDefinition[];
  };
}

export interface SqlJsonWorkerConfiguration {
  keyPatternSources: readonly string[];
  placeholderSources: readonly string[];
  allowAllMultilineStrings: boolean;
  allowPlaceholdersEverywhere: boolean;
  dialect: SqlDialect;
  format: SqlFormatConfiguration;
}

export interface SqlSchemaRegistration {
  key: string;
  revision: number;
  sources: readonly { source: string; text: string }[];
  dialect: SqlDialect;
  udfs: readonly string[];
}

interface SchemaRequest {
  schemaKey?: string;
  schemaRevision?: number;
  schema?: SqlSchemaRegistration;
}

export type SqlWorkerOperation =
  | { operation: 'tokens'; snapshot: SqlDocumentSnapshot }
  | ({ operation: 'analyze'; snapshot: SqlDocumentSnapshot; options: SqlAnalysisOptions } & SchemaRequest)
  | ({ operation: 'completion'; snapshot: SqlDocumentSnapshot; offset: number; options: SqlCompletionOptions } & SchemaRequest)
  | ({ operation: 'symbol'; snapshot: SqlDocumentSnapshot; offset: number; options: SqlAnalysisOptions } & SchemaRequest)
  | { operation: 'format'; snapshot: SqlDocumentSnapshot; format: SqlFormatConfiguration; editor: EditorFormattingOptions }
  | { operation: 'formatJson'; snapshot: { uri: string; version: number; text: string }; configuration: SqlJsonWorkerConfiguration; editor: EditorFormattingOptions }
  | { operation: 'buildSchema'; schema: SqlSchemaRegistration }
  | { operation: 'forgetSchema'; key: string }
  | { operation: 'clearDocument'; uri: string }
  | { operation: 'clear' };

export type SqlWorkerResult = SqlToken[] | SqlAnalysisResult | SqlCompletionResult | SqlSymbolResolution | SchemaSnapshot | string | undefined;

export type SqlWorkerRequest = SqlWorkerOperation & { id: number; epoch: number };
export type SqlWorkerMessage =
  | { kind: 'ready' }
  | { kind: 'schemaReady'; id: number; epoch: number }
  | { kind: 'result'; id: number; epoch: number; value: SqlWorkerResult }
  | { kind: 'error'; id: number; epoch: number; message: string };
