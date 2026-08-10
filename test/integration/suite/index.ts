import * as path from 'node:path';

import Mocha from 'mocha';

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'tdd', color: true, timeout: 30_000 });
  mocha.addFile(path.resolve(__dirname, 'extension.test.js'));
  return new Promise((resolve, reject) => {
    mocha.run((failures) => failures > 0 ? reject(new Error(`${failures} integration test(s) failed.`)) : resolve());
  });
}
