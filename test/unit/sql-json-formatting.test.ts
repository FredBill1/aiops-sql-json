import { getLanguageService } from 'vscode-json-languageservice';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { describe, expect, it } from 'vitest';

import type { ExtensionConfiguration, SqlFormatConfiguration } from '../../src/config';
import { projectJsonPlaceholders } from '../../src/jsonProjection';
import type { ProjectedJsonDocument } from '../../src/jsonService';
import { compileGlobs, compilePlaceholderPatterns } from '../../src/patterns';
import { PlatformProjection } from '../../src/projection';
import { extractSqlRegions } from '../../src/regions';
import { formatSqlJson } from '../../src/sqlJsonFormatting';

const format: SqlFormatConfiguration = {
  maxLineWidth: 120,
  maxInlineExpressionDepth: 4,
  structuralParenthesisPosition: 'sameLine',
  statementListLayout: 'onePerLine',
  sqlJsonBaseIndent: 1,
  keywordCase: 'upper',
  functionCase: 'upper',
  dataTypeCase: 'upper',
  commaPosition: 'trailing',
  logicalOperatorPosition: 'before',
  semicolonPosition: 'sameLine',
  blankLinesBetweenStatements: 1,
};

const compiledPlaceholders = compilePlaceholderPatterns(['\\$\\{[^}]+\\}', '\\$\\w+']);
const configuration: ExtensionConfiguration = {
  keyPatternSources: ['*Sql'],
  keyPatterns: compileGlobs(['*Sql']),
  allowAllMultilineStrings: true,
  dialect: 'spark',
  plainSqlEnabled: true,
  schemaValidationEnabled: false,
  schemaValidationCompletionOnly: false,
  schemaFileGlobs: [],
  udfs: [],
  placeholderSources: ['\\$\\{[^}]+\\}', '\\$\\w+'],
  placeholderPatterns: compiledPlaceholders.patterns,
  placeholderIssues: [],
  allowPlaceholdersEverywhere: true,
  format,
};

describe('SQL JSON formatting', () => {
  it('formats JSON and embedded SQL while preserving a non-SQL multiline string exactly', () => {
    const untouched = '"first line\n       second line"';
    const source = `{\n"description":${untouched},\n"nested":{"trainSql":"select userId,sum(amount) total from sales where dt=$date"}\n}`;
    const result = formatSqlJson(project(source), configuration, { tabSize: 2, insertSpaces: true, eol: '\n' });

    expect(result).toContain(`"description": ${untouched}`);
    expect(result).toContain('"trainSql": "\n  SELECT');
    expect(result).toContain('\n    userId,');
    expect(result).toContain('\n  FROM sales');
    expect(result).toContain('$date"');
  });

  it('supports automatic SQL indentation based on JSON nesting depth', () => {
    const source = '{"outer":{"querySql":"select a from t"}}';
    const result = formatSqlJson(
      project(source),
      { ...configuration, format: { ...format, sqlJsonBaseIndent: 'auto' } },
      { tabSize: 2, insertSpaces: true, eol: '\n' },
    );

    expect(result).toContain('"querySql": "\n      SELECT');
  });

  it('preserves bare JSON placeholders while formatting the surrounding object', () => {
    const source = '{$dynamicKey:prefix_$suffix,"trainSql":"select ${column} from $table"}';
    const result = formatSqlJson(project(source), configuration, { tabSize: 2, insertSpaces: true, eol: '\n' });

    expect(result).toContain('$dynamicKey: prefix_$suffix');
    expect(result).toContain('${column}');
    expect(result).toContain('$table"');
  });

  it('is idempotent', () => {
    const once = formatSqlJson(
      project('{"trainSql":"select a,b from t"}'),
      configuration,
      { tabSize: 2, insertSpaces: true, eol: '\n' },
    );
    const twice = formatSqlJson(project(once), configuration, { tabSize: 2, insertSpaces: true, eol: '\n' });
    expect(twice).toBe(once);
  });

  it('uses CRLF throughout and does not emit raw JSON tab characters', () => {
    const result = formatSqlJson(
      project('{"nested":{"trainSql":"select a,b from t"}}'),
      configuration,
      { tabSize: 4, insertSpaces: false, eol: '\r\n' },
    );

    expect(result).toContain('\r\n');
    expect(result).not.toMatch(/(?<!\r)\n/u);
    const sqlLines = result.split('\r\n').filter((line) => /(?:SELECT|a,|b|FROM t)/u.test(line));
    expect(sqlLines).not.toHaveLength(0);
    expect(sqlLines.every((line) => !line.includes('\t'))).toBe(true);
  });

  it('fails the whole operation when any embedded SQL block is unsafe to format', () => {
    const source = '{"firstSql":"select a from t","brokenSql":"select ("}';

    expect(() => formatSqlJson(
      project(source),
      configuration,
      { tabSize: 2, insertSpaces: true, eol: '\n' },
    )).toThrow(/brokenSql.*line 1/u);
  });

  it('keeps SQL literal newlines and line-comment terminators as JSON escapes', () => {
    const result = formatSqlJson(
      project('{"trainSql":"select \'first\\nsecond\' as value -- note\\nfrom source_table"}'),
      configuration,
      { tabSize: 2, insertSpaces: true, eol: '\n' },
    );
    const formatted = project(result);
    const regions = extractSqlRegions(formatted.projection, formatted.jsonDocument, configuration.keyPatterns);

    expect(result).toContain("'first\\nsecond'");
    expect(result).toContain('-- note\\n\n');
    expect(regions[0]?.decoded.text).toContain("'first\nsecond'");
    expect(regions[0]?.decoded.text).toMatch(/-- note\n\s*FROM source_table/u);
  });
});

function project(source: string): ProjectedJsonDocument {
  const projection = new PlatformProjection(source);
  const placeholders = projectJsonPlaceholders(projection.text, configuration.placeholderPatterns);
  const textDocument = TextDocument.create('file:///format.sql.json', 'json', 1, placeholders.text);
  const service = getLanguageService({});
  return {
    projection,
    textDocument,
    jsonDocument: service.parseJSONDocument(textDocument),
    service,
    placeholders: placeholders.occurrences,
    dynamicKeyObjectOffsets: new Set(),
  };
}
