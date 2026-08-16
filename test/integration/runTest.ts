import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { runTests, type TestOptions } from '@vscode/test-electron';

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  for (let iteration = 1; iteration <= options.repeat; iteration += 1) {
    await runIteration(iteration, options);
  }
}

interface RunnerOptions {
  readonly repeat: number;
  readonly vscodeVersion?: string;
}

async function runIteration(iteration: number, runnerOptions: RunnerOptions): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, '../..');
  const extensionTestsPath = path.resolve(__dirname, './suite/index');
  const testWorkspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aiops-sql-json-workspace-'));
  const firstWorkspaceFolder = path.join(testWorkspaceRoot, 'first');
  const secondWorkspaceFolder = path.join(testWorkspaceRoot, 'second');
  const userDataDirectory = path.join(testWorkspaceRoot, 'user-data');
  const extensionsDirectory = path.join(testWorkspaceRoot, 'extensions');
  const workspaceFile = path.join(testWorkspaceRoot, 'integration.code-workspace');
  await Promise.all([
    fs.mkdir(firstWorkspaceFolder, { recursive: true }),
    fs.mkdir(secondWorkspaceFolder, { recursive: true }),
    fs.mkdir(userDataDirectory, { recursive: true }),
    fs.mkdir(extensionsDirectory, { recursive: true }),
  ]);
  await fs.writeFile(workspaceFile, JSON.stringify({
    folders: [
      { name: 'First', path: firstWorkspaceFolder },
      { name: 'Second', path: secondWorkspaceFolder },
    ],
  }), 'utf8');

  try {
    console.log(
      `Starting integration test run ${iteration}/${runnerOptions.repeat}`
      + ` with VS Code ${runnerOptions.vscodeVersion ?? 'latest stable'}.`,
    );
    const testOptions: TestOptions = {
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [
        workspaceFile,
        '--disable-extensions',
        `--user-data-dir=${userDataDirectory}`,
        `--extensions-dir=${extensionsDirectory}`,
      ],
    };
    if (runnerOptions.vscodeVersion !== undefined) {
      testOptions.version = runnerOptions.vscodeVersion;
    }
    await runTests(testOptions);
  } finally {
    await fs.rm(testWorkspaceRoot, { recursive: true, force: true });
  }
}

function parseArguments(args: readonly string[]): RunnerOptions {
  let repeat = 1;
  let vscodeVersion: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '--repeat') {
      repeat = parseRepeat(requireValue(args, ++index, '--repeat'));
    } else if (argument.startsWith('--repeat=')) {
      repeat = parseRepeat(argument.slice('--repeat='.length));
    } else if (argument === '--vscode-version') {
      vscodeVersion = requireValue(args, ++index, '--vscode-version');
    } else if (argument.startsWith('--vscode-version=')) {
      vscodeVersion = argument.slice('--vscode-version='.length);
      if (vscodeVersion.length === 0) throw new Error('--vscode-version requires a value.');
    } else {
      throw new Error(`Unknown integration test argument: ${argument}`);
    }
  }
  return { repeat, vscodeVersion };
}

function requireValue(args: readonly string[], index: number, option: string): string {
  const value = args[index];
  if (value === undefined || value.startsWith('--')) throw new Error(`${option} requires a value.`);
  return value;
}

function parseRepeat(value: string): number {
  const repeat = Number(value);
  if (!Number.isSafeInteger(repeat) || repeat < 1) {
    throw new Error(`--repeat must be a positive integer, received: ${value}`);
  }
  return repeat;
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
