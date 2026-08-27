import { describe, expect, it } from 'vitest';
import {
  documentationPageUrls, extractDocumentationContracts, parseDocumentationSignature,
} from '../../scripts/function-catalog-extractors.mjs';

const page = (html: string) => ({ url: 'https://example.test/docs/functions.html', html });

describe('offline official-documentation contract extraction', () => {
  it('extracts Spark optional arguments without turning prose into guessed returns', () => {
    const result = extractDocumentationContracts('spark', [page(`<table>
      <tr><td>array_repeat(element, count)</td><td>Returns the array containing element count times.</td></tr>
      <tr><td>sort_array(array[, ascendingOrder])</td><td>Sorts the input.</td></tr>
    </table>`)]);
    expect(result.ARRAY_REPEAT?.overloads[0]?.returns).toEqual({ kind: 'array', element: { kind: 'unknown' } });
    expect(result.SORT_ARRAY?.overloads[0]?.parameters).toEqual([
      { type: 'ARRAY', declaredType: 'array' }, { type: 'ANY', declaredType: 'ascendingOrder', optional: true },
    ]);
    expect(result.SORT_ARRAY?.completeness).toBe('name-only');
  });

  it('binds Hive type variables to map keys and preserves overloads', () => {
    const result = extractDocumentationContracts('hive', [page(`<table>
      <tr><td>array&lt;K&gt;</td><td>map_keys(Map&lt;K.V&gt;)</td><td>Keys.</td></tr>
      <tr><td>int</td><td>size(Array&lt;T&gt;)</td><td>Array size.</td></tr>
      <tr><td>int</td><td>size(Map&lt;K.V&gt;)</td><td>Map size.</td></tr>
    </table>`)]);
    expect(result.MAP_KEYS?.overloads[0]?.returns).toEqual({ kind: 'array', element: { kind: 'map-key', index: 0 } });
    expect(result.SIZE?.overloads).toHaveLength(2);
  });

  it('reads the Flink SQL column, not its Table API method', () => {
    const result = extractDocumentationContracts('flink', [page(`<table><tr>
      <td>ARRAY_SORT(array[, ascending_order[, null_first]])</td>
      <td>array.arraySort([ascendingOrder[, nullFirst]])</td><td>Returns the array in sorted order.</td>
    </tr></table>`)]);
    expect(Object.keys(result)).toEqual(['ARRAY_SORT']);
    expect(result.ARRAY_SORT?.overloads[0]?.parameters.map((parameter) => Boolean(parameter.optional))).toEqual([false, true, true]);
  });

  it('reads PostgreSQL polymorphic returns and set-returning scalar values', () => {
    const result = extractDocumentationContracts('postgresql', [page(`
      <p class="func_signature"><a id="array-prepend"></a><code class="function">array_prepend</code> (anycompatible, anycompatiblearray) → anycompatiblearray</p>
      <p class="func_signature">generate_series(integer, integer) → setof integer</p>
    `)]);
    expect(result.ARRAY_PREPEND?.overloads[0]?.returns).toEqual({ kind: 'argument', index: 1 });
    expect(result.GENERATE_SERIES?.overloads[0]?.returns).toEqual({ kind: 'fixed', type: 'INTEGER' });
    expect(result.ARRAY_PREPEND?.overloads[0]?.source).toContain('#array-prepend');
  });

  it('retains Trino lambda signatures and nested generic types', () => {
    const result = extractDocumentationContracts('trino', [page(`
      <dt class="sig sig-object py" id="array_sort">array_sort(array(T), function(T, T, int)) -&gt; array(T)<a>#</a></dt>
    `)]);
    expect(result.ARRAY_SORT?.overloads[0]?.parameters.map((parameter) => parameter.type)).toEqual(['ARRAY', 'LAMBDA']);
    expect(result.ARRAY_SORT?.overloads[0]?.returns).toEqual({ kind: 'array', element: { kind: 'array-element', index: 0 } });
  });

  it('uses MySQL definition anchors rather than zero-argument index labels', () => {
    const result = extractDocumentationContracts('mysql', [page(`
      <a href="#function_ascii">ASCII()</a>
      <a name="function_ascii"></a><p>ASCII(str)</p><p>Returns the numeric value of a character.</p>
      <a name="function_bin"></a><p>BIN(N)</p><p>Returns a string representation of the value.</p>
    `)]);
    expect(result.ASCII?.overloads[0]?.parameters).toHaveLength(1);
    expect(result.ASCII?.overloads[0]?.returns).toEqual({ kind: 'fixed', type: 'NUMBER' });
    expect(result.BIN?.overloads[0]?.returns).toEqual({ kind: 'fixed', type: 'STRING' });
  });

  it('reads Impala typed parameters and the explicit return type', () => {
    const result = extractDocumentationContracts('impala', [page(`<dl>
      <dt class="dt dlterm" id="ascii">ASCII(STRING str)</dt>
      <dd><p><strong>Return type:</strong> <code>INT</code></p></dd>
    </dl>`)]);
    expect(result.ASCII?.overloads[0]?.parameters[0]?.type).toBe('STRING');
    expect(result.ASCII?.overloads[0]?.returns).toEqual({ kind: 'fixed', type: 'INT' });
  });

  it('marks incomplete overload information instead of inventing a contract', () => {
    const result = extractDocumentationContracts('hive', [page(`<table>
      <tr><td>string</td><td>example(string value)</td><td>Known overload.</td></tr>
      <tr><td>varies</td><td>example(T value, T other)</td><td>Dynamic overload.</td></tr>
    </table>`)]);
    expect(result.EXAMPLE?.completeness).toBe('partial');
    expect(result.EXAMPLE?.overloads[1]?.returns).toBeUndefined();
    expect(parseDocumentationSignature('substring(value FROM start FOR length)', 'string', '')).toBeUndefined();
    expect(parseDocumentationSignature('broken(value', 'string', '')).toBeUndefined();
  });

  it('keeps optional/default/variadic parameters and decimal commas separate', () => {
    const signature = parseDocumentationSignature('example(decimal(10, 2) value, integer n DEFAULT 1, string...)', 'string', 'source');
    expect(signature?.parameters).toHaveLength(3);
    expect(signature?.parameters[1]?.optional).toBe(true);
    expect(signature?.parameters[2]?.variadic).toBe(true);
  });

  it('traverses only same-origin function detail pages and sorts deterministically', () => {
    const source = { url: 'https://example.test/docs/functions.html', extractor: 'postgresql' };
    const urls = documentationPageUrls(source, `<a href="functions-z.html#part">Z</a>
      <a href="functions-a.html">A</a><a href="functions-z.html#other">Z</a>
      <a href="https://other.test/functions-x.html">external</a><a href="tutorial.html">tutorial</a>`);
    expect(urls).toEqual(['https://example.test/docs/functions-a.html', 'https://example.test/docs/functions-z.html', source.url]);
    const fixture = page('<tr><td>z(x)</td><td>Returns a string.</td></tr><tr><td>a(x)</td><td>Returns true if present.</td></tr>');
    expect(extractDocumentationContracts('spark', [fixture])).toEqual(extractDocumentationContracts('spark', [fixture, fixture]));
    expect(Object.keys(extractDocumentationContracts('spark', [fixture]))).toEqual(['A', 'Z']);
  });
});
