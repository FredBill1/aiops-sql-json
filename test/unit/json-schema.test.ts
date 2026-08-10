import { getLanguageService } from 'vscode-json-languageservice';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { describe, expect, it } from 'vitest';

import { PlatformProjection } from '../../src/projection';

describe('projected JSON Schema support', () => {
  it('validates and completes projected JSON against an inline schema', async () => {
    const service = getLanguageService({});
    service.configure({
      validate: true,
      allowComments: false,
      schemas: [{
        uri: 'vscode://schemas/test',
        fileMatch: ['*.sql.json'],
        schema: {
          type: 'object',
          required: ['trainSql', 'mode'],
          properties: {
            trainSql: { type: 'string' },
            mode: { enum: ['train', 'test'], description: 'Execution mode' },
          },
        },
      }],
    });

    const projection = new PlatformProjection('{\n  "trainSql": "SELECT\n    1"\n}');
    const document = TextDocument.create('file:///job.sql.json', 'json', 1, projection.text);
    const json = service.parseJSONDocument(document);
    const diagnostics = await service.doValidation(document, json);
    expect(diagnostics.some((diagnostic) => diagnostic.message.toString().includes('mode'))).toBe(true);

    const completionProjection = new PlatformProjection('{\n  "trainSql": "SELECT\n    1",\n  "mode": ""\n}');
    const completionDocument = TextDocument.create('file:///job.sql.json', 'json', 1, completionProjection.text);
    const completionJson = service.parseJSONDocument(completionDocument);
    const cursor = completionDocument.positionAt(completionProjection.text.indexOf('"mode": "') + 9);
    const completions = await service.doComplete(completionDocument, cursor, completionJson);
    expect(completions?.items.map((item) => item.label)).toEqual(expect.arrayContaining(['"train"', '"test"']));
  });
});
