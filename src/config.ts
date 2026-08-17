import * as vscode from 'vscode';

import { compileGlobs, compilePlaceholderPatterns } from './patterns';
import { getConfigurationResource } from './resourceContext';
import { isSqlDialect, type SqlDialect } from './sql';

export const DEFAULT_SCHEMA_FILE_GLOBS = ['${workspaceFolder}/schema/*.sql'];

export type FormatCase = 'preserve' | 'upper' | 'lower';
export type LayoutMode = 'compact' | 'expanded';
export type StructuralParenthesisPosition = 'sameLine' | 'newLine';
export type CommaPosition = 'trailing' | 'leading';
export type LogicalOperatorPosition = 'before' | 'after';
export type SemicolonPosition = 'sameLine' | 'newLine';
export type SqlJsonBaseIndent = number | 'auto';

export interface SqlFormatConfiguration {
  maxLineWidth: number;
  maxInlineExpressionDepth: number;
  maxInlineItems: number;
  layoutMode: LayoutMode;
  structuralParenthesisPosition: StructuralParenthesisPosition;
  sqlJsonBaseIndent: SqlJsonBaseIndent;
  keywordCase: FormatCase;
  functionCase: FormatCase;
  dataTypeCase: FormatCase;
  commaPosition: CommaPosition;
  logicalOperatorPosition: LogicalOperatorPosition;
  semicolonPosition: SemicolonPosition;
  blankLinesBetweenStatements: number;
}

export interface ExtensionConfiguration {
  keyPatternSources: string[];
  keyPatterns: RegExp[];
  allowAllMultilineStrings: boolean;
  dialect: SqlDialect;
  plainSqlEnabled: boolean;
  schemaValidationEnabled: boolean;
  schemaValidationCompletionOnly: boolean;
  schemaFileGlobs: string[];
  udfs: string[];
  placeholderSources: string[];
  placeholderPatterns: RegExp[];
  placeholderIssues: string[];
  allowPlaceholdersEverywhere: boolean;
  format: SqlFormatConfiguration;
}

export function getExtensionConfiguration(resource: vscode.Uri): ExtensionConfiguration {
  const configuration = vscode.workspace.getConfiguration('aiopsSqlJson', getConfigurationResource(resource));
  const keyPatternSources = configuration.get<string[]>('keyPatterns', ['*Sql']).filter(isString);
  const placeholderSources = configuration.get<string[]>('placeholderPatterns', []).filter(isString);
  const schemaFileGlobs = configuration.get<string[]>('schemaFiles', DEFAULT_SCHEMA_FILE_GLOBS).filter(isNonEmptyString);
  const udfs = configuration.get<string[]>('udfs', []).filter(isNonEmptyString).map((value) => value.trim());
  const configuredDialect = configuration.get<unknown>('dialect', 'spark');
  const placeholders = compilePlaceholderPatterns(placeholderSources);
  return {
    keyPatternSources,
    keyPatterns: compileGlobs(keyPatternSources),
    allowAllMultilineStrings: configuration.get<boolean>('multilineStrings.allowAll', true),
    dialect: isSqlDialect(configuredDialect) ? configuredDialect : 'spark',
    plainSqlEnabled: configuration.get<boolean>('plainSql.enabled', true),
    schemaValidationEnabled: configuration.get<boolean>('schemaValidation.enabled', false),
    schemaValidationCompletionOnly: configuration.get<boolean>('schemaValidation.completionOnly', false),
    schemaFileGlobs,
    udfs,
    placeholderSources,
    placeholderPatterns: placeholders.patterns,
    placeholderIssues: placeholders.issues,
    allowPlaceholdersEverywhere: configuration.get<boolean>('placeholders.allowEverywhere', true),
    format: {
      maxLineWidth: integerAtLeast(configuration.get<unknown>('format.maxLineWidth'), 120, 20),
      maxInlineExpressionDepth: integerAtLeast(
        configuration.get<unknown>('format.maxInlineExpressionDepth'),
        4,
        1,
      ),
      maxInlineItems: integerAtLeast(configuration.get<unknown>('format.maxInlineItems'), 4, 1),
      layoutMode: enumValue(
        configuration.get<unknown>('format.layoutMode'),
        ['compact', 'expanded'] as const,
        'compact',
      ),
      structuralParenthesisPosition: enumValue(
        configuration.get<unknown>('format.structuralParenthesisPosition'),
        ['sameLine', 'newLine'] as const,
        'sameLine',
      ),
      sqlJsonBaseIndent: sqlJsonBaseIndent(configuration.get<unknown>('format.sqlJson.baseIndent')),
      keywordCase: formatCase(configuration.get<unknown>('format.keywordCase'), 'upper'),
      functionCase: formatCase(configuration.get<unknown>('format.functionCase'), 'upper'),
      dataTypeCase: formatCase(configuration.get<unknown>('format.dataTypeCase'), 'upper'),
      commaPosition: enumValue(
        configuration.get<unknown>('format.commaPosition'),
        ['trailing', 'leading'] as const,
        'trailing',
      ),
      logicalOperatorPosition: enumValue(
        configuration.get<unknown>('format.logicalOperatorPosition'),
        ['before', 'after'] as const,
        'before',
      ),
      semicolonPosition: enumValue(
        configuration.get<unknown>('format.semicolonPosition'),
        ['sameLine', 'newLine'] as const,
        'sameLine',
      ),
      blankLinesBetweenStatements: integerAtLeast(
        configuration.get<unknown>('format.blankLinesBetweenStatements'),
        1,
        0,
      ),
    },
  };
}

export function configurationSignature(configuration: ExtensionConfiguration): string {
  return JSON.stringify({
    keys: configuration.keyPatternSources,
    multilineStrings: configuration.allowAllMultilineStrings,
    dialect: configuration.dialect,
    plainSql: configuration.plainSqlEnabled,
    schemaValidation: configuration.schemaValidationEnabled,
    schemaValidationCompletionOnly: configuration.schemaValidationCompletionOnly,
    schemaFiles: configuration.schemaFileGlobs,
    udfs: configuration.udfs,
    placeholders: configuration.placeholderSources,
    placeholdersEverywhere: configuration.allowPlaceholdersEverywhere,
    format: configuration.format,
  });
}

function formatCase(value: unknown, fallback: FormatCase): FormatCase {
  return enumValue(value, ['preserve', 'upper', 'lower'] as const, fallback);
}

function enumValue<const T extends string>(value: unknown, values: readonly T[], fallback: T): T {
  return typeof value === 'string' && (values as readonly string[]).includes(value)
    ? value as T
    : fallback;
}

function integerAtLeast(value: unknown, fallback: number, minimum: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= minimum ? value : fallback;
}

function sqlJsonBaseIndent(value: unknown): SqlJsonBaseIndent {
  if (value === 'auto') {
    return value;
  }
  return integerAtLeast(value, 1, 1);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
