import * as vscode from 'vscode';

import { compileGlobs, compilePlaceholderPatterns } from './patterns';
import { isSqlDialect, type SqlDialect } from './sql';

export interface ExtensionConfiguration {
  keyPatternSources: string[];
  keyPatterns: RegExp[];
  dialect: SqlDialect;
  plainSqlEnabled: boolean;
  placeholderSources: string[];
  placeholderPatterns: RegExp[];
  placeholderIssues: string[];
}

export function getExtensionConfiguration(resource: vscode.Uri): ExtensionConfiguration {
  const configuration = vscode.workspace.getConfiguration('aiopsSqlJson', resource);
  const keyPatternSources = configuration.get<string[]>('keyPatterns', ['*Sql']).filter(isString);
  const placeholderSources = configuration.get<string[]>('placeholderPatterns', []).filter(isString);
  const configuredDialect = configuration.get<unknown>('dialect', 'spark');
  const placeholders = compilePlaceholderPatterns(placeholderSources);
  return {
    keyPatternSources,
    keyPatterns: compileGlobs(keyPatternSources),
    dialect: isSqlDialect(configuredDialect) ? configuredDialect : 'spark',
    plainSqlEnabled: configuration.get<boolean>('plainSql.enabled', true),
    placeholderSources,
    placeholderPatterns: placeholders.patterns,
    placeholderIssues: placeholders.issues,
  };
}

export function configurationSignature(configuration: ExtensionConfiguration): string {
  return JSON.stringify({
    keys: configuration.keyPatternSources,
    dialect: configuration.dialect,
    plainSql: configuration.plainSqlEnabled,
    placeholders: configuration.placeholderSources,
  });
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}
