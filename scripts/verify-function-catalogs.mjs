import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const workspace = process.cwd();
const sources = JSON.parse(await readFile(path.join(workspace, 'catalog', 'function-catalog.sources.json'), 'utf8'));
const lock = JSON.parse(await readFile(path.join(workspace, 'catalog', 'function-catalog.lock.json'), 'utf8'));
const generated = await readFile(path.join(workspace, 'src', 'generated', 'sqlFunctionNames.ts'), 'utf8');
const signatures = await readFile(path.join(workspace, 'src', 'sqlFunctionSignatures.ts'), 'utf8');

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
}

if (/kind:\s*'fixed';\s*readonly type:\s*'UNKNOWN'/u.test(signatures)) {
  throw new Error('Fixed UNKNOWN return types are not allowed in the built-in signature catalog');
}

console.log('Function catalog sources, versions, and generated names are consistent.');

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
