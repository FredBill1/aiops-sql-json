import { getLanguageService } from 'vscode-json-languageservice';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { describe, expect, it } from 'vitest';

import type { ExtensionConfiguration } from '../../src/config';
import { projectJsonPlaceholders } from '../../src/jsonProjection';
import { compileGlobs, compilePlaceholderPatterns } from '../../src/patterns';
import { PlatformProjection } from '../../src/projection';
import { extractSqlRegions } from '../../src/regions';
import { SQL_DIALECTS } from '../../src/sql';
import { formatSqlJson } from '../../src/sqlJsonFormatting';
import { commentCases, commentFormat, commentSql } from './sql-comment-whitespace.cases';

const modes = [
  { name: 'schema disabled', enabled: false, completionOnly: false },
  { name: 'schema enabled', enabled: true, completionOnly: false },
  { name: 'schema completion only', enabled: true, completionOnly: true },
];

// Core configuration coverage is complemented by real configuration/provider
// integration tests; formatSqlJson itself does not consult the schema service.
describe.each(SQL_DIALECTS)('%s SQL JSON comment whitespace', (dialect) => {
  describe.each(modes)('$name', ({ enabled, completionOnly }) => {
    const configuration: ExtensionConfiguration = {
      keyPatternSources: ['*Sql'], keyPatterns: compileGlobs(['*Sql']),
      allowAllMultilineStrings: true, dialect, plainSqlEnabled: true,
      schemaValidationEnabled: enabled, schemaValidationCompletionOnly: completionOnly,
      schemaFileGlobs: [], udfs: [],
      placeholderSources: ['\\$\\{[^}]+\\}', '\\$\\w+'],
      placeholderPatterns: compilePlaceholderPatterns(['\\$\\{[^}]+\\}', '\\$\\w+']).patterns,
      placeholderIssues: [], allowPlaceholdersEverywhere: true, format: commentFormat,
    };
    const project = (source: string) => {
      const projection = new PlatformProjection(source);
      const placeholders = projectJsonPlaceholders(projection.text, configuration.placeholderPatterns);
      const textDocument = TextDocument.create('file:///comments.sql.json', 'json', 1, placeholders.text);
      const service = getLanguageService({});
      return {
        projection, textDocument, service, jsonDocument: service.parseJSONDocument(textDocument),
        placeholders: placeholders.occurrences, dynamicKeyObjectOffsets: new Set<number>(),
      };
    };

    for (const encoding of ['escaped LF', 'escaped LF + physical LF', 'escaped CRLF'] as const) {
      it.each([
        ['reported HAVING', commentCases[0][1]],
        ['EOF comment', 'select 1 -- test{{ws}}'],
        ['literal and placeholder', "select 'keep  ', ${value} -- test{{ws}}\n"],
      ])(`${encoding}: %s`, (_name, template) => {
        const eol = encoding === 'escaped CRLF' ? '\r\n' : '\n';
        const editor = { tabSize: 2, insertSpaces: true, eol };
        const wrap = (sql: string) => {
          const literal = JSON.stringify(sql);
          // Physical newlines are removed by the platform. Keep the escaped SQL
          // newline as well, otherwise the following SQL becomes comment text.
          const encoded = encoding === 'escaped LF + physical LF' ? literal.replaceAll('\\n', '\\n\n') : literal;
          return `{"description":"keep  ","firstSql":"select 2","nested":{"querySql":${encoded}}}`;
        };
        const cleanSql = commentSql(template!, '', eol);
        const dirtySql = commentSql(template!, ' \t ', eol);
        for (const sql of [cleanSql, dirtySql]) {
          const input = project(wrap(sql));
          const regions = extractSqlRegions(input.projection, input.jsonDocument, configuration.keyPatterns);
          expect(regions[1]!.decoded.text).toBe(sql);
        }
        const expected = formatSqlJson(project(wrap(cleanSql)), configuration, editor);
        const actual = formatSqlJson(project(wrap(dirtySql)), configuration, editor);
        expect(actual).toBe(expected);
        expect(actual).toContain('"description": "keep  "');
        expect(formatSqlJson(project(actual), configuration, editor)).toBe(actual);
        const projected = project(actual);
        const regions = extractSqlRegions(projected.projection, projected.jsonDocument, configuration.keyPatterns);
        expect(regions).toHaveLength(2);
        expect(regions[1]!.decoded.text).toContain('-- test');
      });
    }
  });
});
