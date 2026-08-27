import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createHash } from 'node:crypto';

const workspace = process.cwd();
const sources = JSON.parse(await readFile(path.join(workspace, 'catalog', 'function-catalog.sources.json'), 'utf8'));
const lock = JSON.parse(await readFile(path.join(workspace, 'catalog', 'function-catalog.lock.json'), 'utf8'));
const generated = await readFile(path.join(workspace, 'src', 'generated', 'sqlFunctionNames.ts'), 'utf8');
const signatures = await readFile(path.join(workspace, 'src', 'sqlFunctionSignatures.ts'), 'utf8');
const contractSource = await readFile(path.join(workspace, 'src', 'generated', 'sqlFunctionContracts.ts'), 'utf8');
const contracts = JSON.parse(contractSource.slice(contractSource.indexOf(' = ') + 3).replace(/;\s*$/u, ''));
const coverage = JSON.parse(await readFile(path.join(workspace, 'catalog', 'function-catalog.coverage.json'), 'utf8'));

for (const [dialect, source] of Object.entries(sources)) {
  const locked = lock[dialect];
  if (!locked || locked.version !== source.version || locked.url !== source.url) {
    throw new Error(`${dialect}: source configuration and lock file differ; run npm run catalog:update`);
  }
  const versionPattern = new RegExp(`${dialect}:\\s*'${escapeRegExp(source.version)}'`, 'u');
  if (!versionPattern.test(signatures)) throw new Error(`${dialect}: runtime catalog version is not ${source.version}`);
  const dialectPattern = new RegExp(`"${dialect}"\\s*:\\s*\\[([\\s\\S]*?)\\]`, 'u');
  const match = dialectPattern.exec(generated);
  if (!match) throw new Error(`${dialect}: generated names are missing`);
  const names = [...match[1].matchAll(/"([A-Z][A-Z0-9_]*)"/gu)].map((entry) => entry[1]);
  if (names.length !== locked.extractedFunctions) throw new Error(`${dialect}: generated count differs from lock file`);
  if (new Set(names).size !== names.length) throw new Error(`${dialect}: duplicate generated function names`);
  const records = contracts[dialect];
  if (!records) throw new Error(`${dialect}: generated contracts are missing`);
  const checksum = createHash('sha256').update(JSON.stringify(records)).digest('hex');
  if (checksum !== locked.contractsSha256) throw new Error(`${dialect}: contract checksum differs from lock file`);
  const pages = new Set(locked.pages?.map((page) => page.url));
  for (const url of [source.url, ...(source.additionalUrls ?? [])]) {
    if (!pages.has(url)) throw new Error(`${dialect}: documentation source ${url} was not indexed`);
  }
  const counts = { complete: 0, partial: 0, 'name-only': names.length - Object.keys(records).length };
  for (const [name, contract] of Object.entries(records)) {
    if (!names.includes(name)) throw new Error(`${dialect}: ${name} has a contract but is not in the name index`);
    if (!Object.hasOwn(counts, contract.completeness)) throw new Error(`${dialect}: invalid completeness for ${name}`);
    counts[contract.completeness]++;
    for (const overload of contract.overloads) {
      if (!pages.has(overload.source.split('#')[0])) throw new Error(`${dialect}: ${name} has an unlocked source`);
      if (overload.name !== name) throw new Error(`${dialect}: mismatched overload name ${name}`);
      validateRule(overload.returns, overload.parameters.length, `${dialect}.${name}`);
    }
  }
  if (JSON.stringify(counts) !== JSON.stringify(locked.contracts)) throw new Error(`${dialect}: contract coverage differs from lock file`);
  if (counts.complete + counts.partial < coverage[dialect].minimumDocumentedReturns) {
    throw new Error(`${dialect}: documented return coverage regressed; inspect the extractor before updating the baseline`);
  }
}

if (/kind:\s*'fixed';\s*readonly type:\s*'UNKNOWN'/u.test(signatures)) {
  throw new Error('Fixed UNKNOWN return types are not allowed in the built-in signature catalog');
}

console.log('Function catalog sources, versions, names, return contracts, and coverage are consistent (offline).');

function validateRule(rule, arity, label) {
  if (!rule) return;
  if (rule.kind === 'fixed' && rule.type === 'UNKNOWN') throw new Error(`${label}: UNKNOWN is not a fixed SQL type`);
  if (typeof rule.index === 'number' && (rule.index < 0 || rule.index >= arity)) throw new Error(`${label}: invalid return argument index`);
  if (rule.indexes?.some((index) => index < 0 || index >= arity)) throw new Error(`${label}: invalid common-type argument index`);
  for (const child of [rule.element, rule.key, rule.value, ...(rule.typeArguments ?? [])]) validateRule(child, arity, label);
  for (const field of rule.fields ?? []) validateRule(field.type, arity, label);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
