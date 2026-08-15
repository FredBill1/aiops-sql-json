import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, '../..');
  const extensionTestsPath = path.resolve(__dirname, './suite/index');
  const testWorkspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aiops-sql-json-workspace-'));
  const firstWorkspaceFolder = path.join(testWorkspaceRoot, 'first');
  const secondWorkspaceFolder = path.join(testWorkspaceRoot, 'second');
  const workspaceFile = path.join(testWorkspaceRoot, 'integration.code-workspace');
  await Promise.all([
    fs.mkdir(firstWorkspaceFolder, { recursive: true }),
    fs.mkdir(secondWorkspaceFolder, { recursive: true }),
  ]);
  await fs.writeFile(workspaceFile, JSON.stringify({
    folders: [
      { name: 'First', path: firstWorkspaceFolder },
      { name: 'Second', path: secondWorkspaceFolder },
    ],
  }), 'utf8');

  try {
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [workspaceFile, '--disable-extensions', '--disable-workspace-trust'],
    });
  } finally {
    await fs.rm(testWorkspaceRoot, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
