import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { SqlFormatConfiguration } from '../../src/config';
import { SqlService, type SqlDocumentSnapshot } from '../../src/sqlService';

let directory: string;
const services: SqlService[] = [];
beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'sql-service-worker-tests-'));
  const result = await build({
    entryPoints: { sqlAnalysisWorker: 'src/sqlAnalysisWorker.ts', sqlLexicalWorker: 'src/sqlLexicalWorker.ts' },
    outdir: directory, bundle: true, format: 'cjs', platform: 'node', target: 'node18',
    mainFields: ['module', 'main'], conditions: ['module', 'import', 'default'], metafile: true,
  });
  expect(Object.keys(result.metafile!.inputs).some((input) => /src\/(config|jsonService|extension)\.ts$/u.test(input))).toBe(false);
});
afterEach(() => { for (const service of services.splice(0)) service.dispose(); });
afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true, maxRetries: 5 }); });

function runtime(options: Partial<ConstructorParameters<typeof SqlService>[0]> = {}): SqlService {
  const service = new SqlService({
    analysisWorkerPath: path.join(directory, 'sqlAnalysisWorker.js'),
    lexicalWorkerPath: path.join(directory, 'sqlLexicalWorker.js'),
    ...options,
  });
  services.push(service);
  return service;
}

function snapshot(text: string, uri = 'query.sql'): SqlDocumentSnapshot {
  return { uri, version: 1, region: 'plain', text, dialect: 'spark', placeholderSources: [] };
}

const format: SqlFormatConfiguration = {
  maxLineWidth: 120, maxInlineExpressionDepth: 4, maxInlineItems: 4, layoutMode: 'compact',
  structuralParenthesisPosition: 'sameLine', sqlJsonBaseIndent: 1,
  keywordCase: 'upper', functionCase: 'upper', dataTypeCase: 'upper', commaPosition: 'trailing',
  logicalOperatorPosition: 'before', semicolonPosition: 'sameLine', blankLinesBetweenStatements: 1,
};
const editor = { tabSize: 2, insertSpaces: true, eol: '\n' };

describe('bundled SQL workers', () => {
  it('keeps SQL parser runtimes out of the extension host and lexical bundle', async () => {
    const options = {
      bundle: true, format: 'cjs' as const, platform: 'node' as const, target: 'node18',
      mainFields: ['module', 'main'], conditions: ['module', 'import', 'default'],
      metafile: true, write: false,
    };
    const host = await build({ ...options, entryPoints: ['src/extension.ts'], external: ['vscode'] });
    expect(Object.keys(host.metafile!.inputs).filter((input) => (
      /(?:dt-sql-parser|sqlingo|src\/(?:sqlAst|sqlSchemaCore|sqlFormatting|sqlParserFactory)\.ts)/u.test(input)
    ))).toEqual([]);
    const lexical = await build({ ...options, entryPoints: ['src/sqlLexicalWorker.ts'] });
    expect(Object.keys(lexical.metafile!.inputs).filter((input) => (
      /(?:sqlingo|src\/(?:sqlAst|sqlSchemaCore|sqlFormatting)\.ts)/u.test(input)
    ))).toEqual([]);
  });

  it('returns full UTF-16 token spans for generated long literals and syntax diagnostics', async () => {
    const service = runtime();
    const literal = `'${'🦉,SELECT; '.repeat(100_000)}'`;
    const sql = `SELECT ${literal} AS payload`;
    const tokens = await service.tokens(snapshot(sql));
    expect(tokens.find((token) => token.type === 'string')).toEqual({ start: 7, end: 7 + literal.length, type: 'string' });
    expect((await service.analyze(snapshot('SELECT 1', 'valid.sql'))).sql.issues).toEqual([]);
    expect((await service.analyze(snapshot('SELECT 1,', 'invalid.sql'))).sql.issues.length).toBeGreaterThan(0);
  });

  it('keeps Schema navigation, completion catalogs and formatted display types inside the worker', async () => {
    const service = runtime();
    const schema = await service.buildSchema('schema', [{
      source: 'file:///schema.sql',
      text: 'CREATE TABLE source (id INT, label STRING); CREATE VIEW derived AS SELECT id, label FROM source;',
    }], 'spark');
    expect(schema.tables.map((table) => table.name)).toEqual(['source', 'derived']);
    const query = snapshot('SELECT id FROM derived');
    expect((await service.analyze(query, { schemaKey: 'schema', validateSchema: true })).semantics).toEqual([]);
    const symbol = await service.symbol(query, query.text.indexOf('id'), { schemaKey: 'schema' });
    expect(symbol?.type).toBe('INT');
    expect(symbol?.definitions[0]?.location.source).toBe('file:///schema.sql');
    const completionQuery = snapshot('SELECT d.la FROM derived d', 'completion.sql');
    const completion = await service.completion(completionQuery, 'SELECT d.la'.length, { schemaKey: 'schema' });
    expect(completion.context).toMatchObject({ prefix: 'la', qualifier: 'd', expressionContext: true });
    expect(completion.scope.relations[0]?.columns.map((column) => column.name)).toEqual(['id', 'label']);
    expect(completion.catalog.functions).toContain('UPPER');
    expect(completion.catalog.functionDefinitions.some((definition) => definition.name.toLowerCase() === 'upper')).toBe(true);
  });

  it('formats ordinary and embedded SQL without passing VS Code objects to a worker', async () => {
    const service = runtime();
    expect(await service.format(snapshot('select 1'), format, editor)).toBe('SELECT 1');
    const result = await service.formatJson({
      uri: 'query.sql.json', version: 1, text: '{"trainSql":"select 1","other":"untouched"}',
    }, {
      dialect: 'spark', keyPatternSources: ['*Sql'], placeholderSources: [],
      allowAllMultilineStrings: true, allowPlaceholdersEverywhere: true, format,
    }, editor);
    expect(result).toContain('SELECT 1');
    expect(result).toContain('untouched');
  });

  it('bounds a pathological user placeholder regexp in the lexical lane and recovers for a normal file', async () => {
    const service = runtime({ lexicalTimeoutMs: 100 });
    await expect(service.tokens({
      ...snapshot(`${'a'.repeat(60)}!`), placeholderSources: ['^(a+)+$'],
    })).rejects.toMatchObject({ code: 'timeout' });
    expect(await service.tokens(snapshot('SELECT 1', 'healthy.sql'))).toEqual(expect.arrayContaining([
      { start: 0, end: 6, type: 'keyword' },
    ]));
    expect((await service.analyze(snapshot('SELECT 1', 'analysis.sql'))).sql.issues).toEqual([]);
  });
});
