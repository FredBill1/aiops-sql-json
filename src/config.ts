import * as vscode from 'vscode';

import { compileGlobs, compilePlaceholderPatterns } from './patterns';
import { isSqlDialect, type SqlDialect } from './sql';

export const DEFAULT_SCHEMA_FILE_GLOBS = ['${workspaceFolder}/schema/*.sql'];

export interface ExtensionConfiguration {
  keyPatternSources: string[];
  keyPatterns: RegExp[];
  allowAllMultilineStrings: boolean;
  dialect: SqlDialect;
  plainSqlEnabled: boolean;
  schemaValidationEnabled: boolean;
  schemaFileGlobs: string[];
  udfs: string[];
  placeholderSources: string[];
  placeholderPatterns: RegExp[];
  placeholderIssues: string[];
  allowPlaceholdersEverywhere: boolean;
}

export function getExtensionConfiguration(resource: vscode.Uri): ExtensionConfiguration {
  const configuration = vscode.workspace.getConfiguration('aiopsSqlJson', resource);
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
    schemaFileGlobs,
    udfs,
    placeholderSources,
    placeholderPatterns: placeholders.patterns,
    placeholderIssues: placeholders.issues,
    allowPlaceholdersEverywhere: configuration.get<boolean>('placeholders.allowEverywhere', true),
  };
}

export function configurationSignature(configuration: ExtensionConfiguration): string {
  return JSON.stringify({
    keys: configuration.keyPatternSources,
    multilineStrings: configuration.allowAllMultilineStrings,
    dialect: configuration.dialect,
    plainSql: configuration.plainSqlEnabled,
    schemaValidation: configuration.schemaValidationEnabled,
    schemaFiles: configuration.schemaFileGlobs,
    udfs: configuration.udfs,
    placeholders: configuration.placeholderSources,
    placeholdersEverywhere: configuration.allowPlaceholdersEverywhere,
  });
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
