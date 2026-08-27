// Pure, offline extractors. Unrecognized prose is deliberately not a type rule.
import { URL } from 'node:url';
const scalarTypes = /^(?:bigint|int(?:eger)?|smallint|tinyint|long|short|byte|double(?: precision)?|float|real|decimal|numeric|number|boolean|bool|string|text|varchar|char|binary|varbinary|bytea|date|time|timestamp|datetime|jsonb?|xml|uuid|regtype|interval|geometry|geography)(?:\s*\([^)]*\))?(?:\s+(?:with|without) time zone)?$/iu;
const variableTypes = /^(?:[tkev]|anyelement|anycompatible|anynonarray|anyenum)$/iu;

export function htmlText(html) {
  return html.replace(/<(?:script|style)\b[^>]*>[\s\S]*?<\/(?:script|style)>/giu, '')
    .replace(/<br\s*\/?\s*>/giu, '\n').replace(/<[^>]*>/gu, '')
    .replace(/&#(?:x([\da-f]+)|(\d+));/giu, (_match, hex, decimal) => String.fromCodePoint(parseInt(hex ?? decimal, hex ? 16 : 10)))
    .replace(/&(lt|gt|amp|nbsp|hellip|rarr|quot|apos|rsquo|lsquo);/gu, (_match, name) => ({
      lt: '<', gt: '>', amp: '&', nbsp: ' ', hellip: '...', rarr: '→', quot: '"', apos: "'", rsquo: "'", lsquo: "'",
    })[name]).replace(/[\t\r\n ]+/gu, ' ').trim();
}

function splitArguments(text) {
  const result = [];
  let depth = 0, optional = 0, current = '', currentOptional = false;
  const append = () => {
    if (current.trim()) result.push({ text: current.trim(), optional: currentOptional });
    current = ''; currentOptional = optional > 0;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '[' && text[i + 1] === ']') { current += '[]'; i++; continue; }
    if (c === '[' && depth === 0) { optional++; if (!current.trim()) currentOptional = true; continue; }
    if (c === ']' && depth === 0) { optional--; continue; }
    if (c === '(' || c === '<') depth++;
    if (c === ')' || c === '>') depth--;
    if (c === ',' && depth === 0) append(); else current += c;
  }
  append();
  return result;
}

function parameterType(text) {
  const lower = text.toLowerCase().trim().replace(/^variadic\s+/u, '');
  if (/^(?:array\b|any(?:compatible)?array\b)/u.test(lower) || /\[\]/u.test(lower)) return 'ARRAY';
  if (/^map\b/u.test(lower)) return 'MAP';
  if (/^function\s*\(/u.test(lower)) return 'LAMBDA';
  if (/^(?:tinyint|smallint|bigint|int(?:eger)?|long|short|byte|double|float|real|decimal|numeric|number)\b/u.test(lower)) return 'NUMBER';
  if (/^(?:binary|varbinary|bytea)\b/u.test(lower)) return 'BINARY';
  if (/^(?:boolean|bool)\b/u.test(lower)) return 'BOOLEAN';
  if (/^(?:string|text|varchar|char)\b/u.test(lower)) return 'STRING';
  if (/^date\b/u.test(lower)) return 'DATE';
  if (/^(?:time|timestamp|datetime)\b/u.test(lower)) return 'TIME';
  return 'ANY';
}

function parameterDeclaration(text) {
  const clean = text.replace(/\s+(?:DEFAULT|=)\s+.*$/iu, '').replace(/\.{2,}/gu, '').trim();
  // PostgreSQL puts argument names before types; Hive/Impala use type first.
  const withoutName = clean.replace(/^[a-z_][\w]*\s+(?=(?:any\w+|bigint|integer|int|double|numeric|text|boolean|timestamp|date|jsonb?|bytea)\b)/iu, '');
  if (scalarTypes.test(withoutName) || variableTypes.test(withoutName)) return withoutName;
  const typeFirst = withoutName.replace(/\s+[a-z_]\w*$/iu, '');
  return scalarTypes.test(typeFirst) || variableTypes.test(typeFirst)
    || /^(?:array|map|function)[<(].+[>)]$/iu.test(typeFirst) ? typeFirst : withoutName;
}

function parseReturnType(text, parameters) {
  const raw = text.trim().replace(/^setof\s+/iu, '').replace(/\s+/gu, ' ');
  const lower = raw.toLowerCase();
  if (scalarTypes.test(raw)) {
    const normalized = ({ long: 'BIGINT', short: 'SMALLINT', byte: 'TINYINT', bool: 'BOOLEAN' })[lower] ?? raw.toUpperCase();
    return { kind: 'fixed', type: normalized };
  }
  if (/^(?:anyarray|anycompatiblearray)$/u.test(lower)) {
    const index = parameters.findIndex((parameter) => /^(?:anyarray|anycompatiblearray)\b/iu.test(parameter.declaredType));
    return index < 0 ? undefined : { kind: 'argument', index };
  }
  if (variableTypes.test(raw)) {
    const indexes = parameters.flatMap((parameter, index) => parameter.declaredType.toLowerCase() === lower ? [index] : []);
    if (indexes.length === 1) return { kind: 'argument', index: indexes[0] };
    if (indexes.length > 1) return indexes.length === parameters.length && parameters.at(-1)?.variadic
      ? { kind: 'common' } : { kind: 'common', indexes };
    for (const [i, parameter] of parameters.entries()) {
      const type = parameter.declaredType.toLowerCase().replace(/\s/gu, '');
      if ((/^any/u.test(lower) && /^any(?:compatible)?array$/u.test(type))
        || type === `array<${lower}>` || type === `array(${lower})` || type === `${lower}[]`) return { kind: 'array-element', index: i };
      const map = /^map[<(]([^,>.]+)[,.]([^>)]+)[>)]$/u.exec(type);
      if (map?.[1] === lower) return { kind: 'map-key', index: i };
      if (map?.[2] === lower) return { kind: 'map-value', index: i };
    }
    return undefined;
  }
  const array = /^(?:array[<(](.+)[>)]|(.+)\[\])$/iu.exec(raw);
  if (array) {
    const element = parseReturnType(array[1] ?? array[2], parameters);
    return element ? { kind: 'array', element } : undefined;
  }
  const map = /^map[<(]([^,>.]+)[,.](.+)[>)]$/iu.exec(raw);
  if (map) {
    const key = parseReturnType(map[1], parameters), value = parseReturnType(map[2], parameters);
    return key && value ? { kind: 'map', key, value } : undefined;
  }
  if (lower === 'array') return { kind: 'array', element: { kind: 'unknown' } };
  if (lower === 'map') return { kind: 'map', key: { kind: 'unknown' }, value: { kind: 'unknown' } };
  return undefined;
}

export function parseDocumentationSignature(text, returnType, source) {
  const head = /^\s*([a-z_][\w]*)\s*\(/iu.exec(text);
  if (!head) return undefined;
  let depth = 1, end = head[0].length;
  for (; end < text.length; end++) {
    if (text[end] === '(') depth++;
    if (text[end] === ')' && --depth === 0) break;
  }
  if (depth !== 0) return undefined;
  const rawArguments = text.slice(head[0].length, end);
  // SQL syntax forms cannot safely be represented as comma-separated overloads.
  if (/\b(?:FROM|FOR|AS|PLACING|WITHIN|ORDER BY)\b/u.test(rawArguments)) return undefined;
  const parameters = splitArguments(rawArguments).map(({ text: parameter, optional }) => ({
    type: parameterType(parameterDeclaration(parameter)), declaredType: parameterDeclaration(parameter),
    ...(optional || /\s(?:DEFAULT|=)\s/iu.test(parameter) ? { optional: true } : {}),
    ...(/\.{2,}|^variadic\b/iu.test(parameter) ? { variadic: true } : {}),
  }));
  const result = returnType ?? /^(?:\s*→|\s*->)\s*(.+?)(?:\s*#)?$/u.exec(text.slice(end + 1))?.[1];
  const returns = result ? parseReturnType(result, parameters) : undefined;
  return {
    name: head[1].toUpperCase(), parameters, ...(returns ? { returns } : {}),
    signature: text.trim(), source,
  };
}

function proseReturnType(description) {
  const text = description.trim();
  // Do not infer a whole function's result from examples, error handling, or a
  // later conditional sentence. Only an unambiguous opening return declaration.
  const first = /^(?:Returns?|Computes?)\s+(.+?)(?:\.(?:\s|$)|$)/iu.exec(text)?.[1] ?? '';
  if (/^(?:true|false|a boolean)\b/iu.test(first)) return 'BOOLEAN';
  if (/^(?:an?|the)\s+(?:UTF-?8\s+|JSON\s+|binary\s+)?(?:string|text)\b/iu.test(first)) return 'STRING';
  if (/^(?:an?|the)\s+(?:sorted\s+|resulting\s+)?array\b/iu.test(first)) return 'ARRAY';
  if (/^(?:an?|the)\s+map\b/iu.test(first)) return 'MAP';
  if (/^(?:an?|the)\s+(?:[a-z-]+\s+){0,2}(?:numeric|integer|floating-point|decimal)\s+(?:value|representation|number)\b/iu.test(first)) return 'NUMBER';
  if (/^(?:an?|the)\s+(?:current\s+)?timestamp\b/iu.test(first)) return 'TIMESTAMP';
  if (/^(?:an?|the)\s+(?:current\s+)?date\b/iu.test(first)) return 'DATE';
  return undefined;
}

export function extractDocumentationContracts(dialect, pages) {
  const entries = new Map();
  const add = (signature, returnType, page, anchor = '') => {
    const entry = parseDocumentationSignature(signature, returnType, `${page.url}${anchor ? `#${anchor}` : ''}`);
    if (!entry) return;
    const previous = entries.get(entry.name) ?? [];
    if (!previous.some((other) => JSON.stringify([other.parameters, other.returns]) === JSON.stringify([entry.parameters, entry.returns]))) {
      previous.push(entry); entries.set(entry.name, previous);
    }
  };
  for (const page of pages) {
    const html = page.html;
    if (['spark', 'hive', 'flink'].includes(dialect)) {
      for (const row of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/giu)) {
        const cells = [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/giu)].map((cell) => htmlText(cell[1]));
        if (dialect === 'hive' && cells.length >= 3) add(cells[1], cells[0], page);
        else if (cells.length >= 2) add(cells[0], proseReturnType(cells.at(-1)), page);
      }
    } else if (dialect === 'postgresql') {
      for (const match of html.matchAll(/<p\b[^>]*class="func_signature"[^>]*>([\s\S]*?)<\/p>/giu)) {
        const anchor = /\bid="([^"]+)"/u.exec(match[1])?.[1];
        add(htmlText(match[1]), undefined, page, anchor);
      }
    } else if (dialect === 'trino') {
      for (const match of html.matchAll(/<dt\b[^>]*class="sig [^"]*"[^>]*>([\s\S]*?)<\/dt>/giu)) {
        const anchor = /\bid="([^"]+)"/u.exec(match[0])?.[1];
        add(htmlText(match[1]).replace(/#$/u, ''), undefined, page, anchor);
      }
    } else if (dialect === 'impala') {
      for (const match of html.matchAll(/<dt\b([^>]*)>([\s\S]*?)<\/dt>([\s\S]*?)(?=<dt\b|<\/dl>)/giu)) {
        const returnType = /Return type:\s*<\/strong>\s*<code[^>]*>([\s\S]*?)<\/code>/iu.exec(match[3]);
        const anchor = /\bid="([^"]+)"/u.exec(match[1])?.[1];
        add(htmlText(match[2]), returnType ? htmlText(returnType[1]) : undefined, page, anchor);
      }
    } else if (dialect === 'mysql') {
      const anchors = [...html.matchAll(/<a\s+name="(function_[^"]+)"[^>]*><\/a>/gu)];
      anchors.forEach((anchor, index) => {
        const section = html.slice(anchor.index + anchor[0].length, anchors[index + 1]?.index ?? html.length);
        const paragraphs = [...section.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/giu)].map((match) => htmlText(match[1]));
        if (paragraphs.length > 1) add(paragraphs[0], proseReturnType(paragraphs[1]), page, anchor[1]);
      });
    }
  }
  return Object.fromEntries([...entries].sort(([a], [b]) => a.localeCompare(b)).map(([name, overloads]) => {
    const known = overloads.filter((overload) => overload.returns);
    // Missing return information on any documented overload prevents treating
    // a partial overload list as exhaustive evidence for the whole function.
    return [name, {
      completeness: known.length === overloads.length && known.every((entry) => entry.parameters.every((parameter) => parameter.type !== 'ANY'))
        ? 'complete' : known.length > 0 ? 'partial' : 'name-only',
      overloads,
    }];
  }));
}

export function documentationPageUrls(source, html) {
  const urls = new Set([source.url, ...(source.additionalUrls ?? [])]);
  for (const match of html.matchAll(/href\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/giu)) {
    const target = new URL(match[1] ?? match[2] ?? match[3], source.url);
    if (target.origin !== new URL(source.url).origin) continue;
    const file = target.pathname.split('/').at(-1);
    const eligible = source.extractor === 'postgresql' ? /^functions-[a-z0-9-]+\.html$/u.test(file)
      : source.extractor === 'trino' ? target.pathname.includes('/functions/') && /\.html$/u.test(file)
        : source.extractor === 'impala' ? /^impala_.*functions\.html$/u.test(file)
          : source.extractor === 'mysql' ? target.hash.startsWith('#function_') && !/internal|loadable|gatekeeper/u.test(file)
            : false;
    if (eligible) { target.hash = ''; urls.add(target.toString()); }
  }
  return [...urls].sort();
}
