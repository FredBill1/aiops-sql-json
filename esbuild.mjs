import * as esbuild from 'esbuild';
import process from 'node:process';

const watch = process.argv.includes('--watch');
const context = await esbuild.context({
  entryPoints: {
    extension: 'src/extension.ts',
    sqlAnalysisWorker: 'src/sqlAnalysisWorker.ts',
    sqlLexicalWorker: 'src/sqlLexicalWorker.ts',
  },
  bundle: true,
  outdir: 'dist',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  mainFields: ['module', 'main'],
  conditions: ['module', 'import', 'default'],
  sourcemap: true,
  logLevel: 'info',
});

if (watch) {
  await context.watch();
} else {
  await context.rebuild();
  await context.dispose();
}
