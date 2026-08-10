import { getLanguageService } from 'vscode-json-languageservice';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { describe, expect, it } from 'vitest';

import { compileGlobs } from '../../src/patterns';
import { PlatformProjection } from '../../src/projection';
import {
  extractSqlRegions,
  findIllegalStringLineBreaks,
  findWordJoinLineBreaks,
  mapDecodedRange,
} from '../../src/regions';

function parse(source: string) {
  const projection = new PlatformProjection(source);
  const service = getLanguageService({});
  const text = TextDocument.create('file:///job.sql.json', 'json', 1, projection.text);
  return { projection, json: service.parseJSONDocument(text) };
}

describe('SQL JSON regions', () => {
  it('extracts nested matching string properties and decodes escapes', () => {
    const source = '{\n  "job": {\n    "trainSql": "SELECT\\u0020*\n      FROM t",\n    "testSQL": "SELECT 2"\n  }\n}';
    const { projection, json } = parse(source);
    const regions = extractSqlRegions(projection, json, compileGlobs(['*Sql']));

    expect(regions).toHaveLength(1);
    expect(regions[0]?.key).toBe('trainSql');
    expect(regions[0]?.decoded.text).toBe('SELECT *      FROM t');
    const selectSpan = mapDecodedRange(regions[0]!.decoded, 0, 6);
    expect(source.slice(selectSpan[0]!.start, selectSpan[0]!.end)).toBe('SELECT');
  });

  it('allows line breaks only in matching direct string values', () => {
    const source = '{\n  "trainSql": "SELECT\n    1",\n  "name": "a\n    b",\n  "otherSql": ["SELECT\n    2"]\n}';
    const { projection, json } = parse(source);
    const regions = extractSqlRegions(projection, json, compileGlobs(['*Sql']));
    const illegal = findIllegalStringLineBreaks(projection, json, regions);

    expect(regions).toHaveLength(1);
    expect(illegal).toHaveLength(2);
  });

  it('warns when a removed line break joins word characters', () => {
    const source = '{"trainSql":"SELECT\nFROM t"}';
    const { projection, json } = parse(source);
    const regions = extractSqlRegions(projection, json, compileGlobs(['*Sql']));
    expect(findWordJoinLineBreaks(projection, regions)).toHaveLength(1);
  });
});
