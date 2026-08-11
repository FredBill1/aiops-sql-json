import { getLanguageService } from 'vscode-json-languageservice';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { describe, expect, it } from 'vitest';

import { projectJsonPlaceholders } from '../../src/jsonProjection';
import { compilePlaceholderPatterns } from '../../src/patterns';

const placeholders = compilePlaceholderPatterns(['\\$\\{[^}]+\\}', '\\$\\w+']).patterns;

describe('JSON placeholder projection', () => {
  it('projects values, keys, embedded bare tokens, and root tokens without changing offsets', async () => {
    const source = '{"key1": $value, "key2": ${value2}, $key: foo_$suffix, "text": "hello $name"}';
    const projection = projectJsonPlaceholders(source, placeholders);

    expect(projection.text).toHaveLength(source.length);
    expect(projection.occurrences.map((occurrence) => occurrence.kind)).toEqual([
      'value', 'value', 'key', 'value', 'string',
    ]);
    expect(projection.text).toContain('""  : 0');
    expect(projection.text).toContain('"text": "hello $name"');

    const service = getLanguageService({});
    const document = TextDocument.create('file:///job.sql.json', 'json', 1, projection.text);
    const diagnostics = await service.doValidation(document, service.parseJSONDocument(document));
    expect(diagnostics).toEqual([]);

    const root = projectJsonPlaceholders('$value', placeholders);
    expect(root.text).toBe('0     ');
    expect(root.text).toHaveLength('$value'.length);
  });

  it('keeps matches inside escaped JSON strings intact', () => {
    const source = '{"text":"say \\"$name\\""}';
    const projection = projectJsonPlaceholders(source, placeholders);
    expect(projection.text).toBe(source);
    expect(projection.occurrences).toHaveLength(1);
    expect(projection.occurrences[0]?.kind).toBe('string');
  });
});
