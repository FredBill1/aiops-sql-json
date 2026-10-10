import { compilePlaceholderPatterns } from './patterns';
import { tokenizeSql } from './sqlLexing';
import { runSqlWorker } from './sqlWorkerRuntime';

runSqlWorker((request) => {
  if (request.operation === 'clear' || request.operation === 'clearDocument') return undefined;
  if (request.operation !== 'tokens') throw new Error('Unsupported lexical worker operation.');
  const { snapshot } = request;
  return tokenizeSql(snapshot.text, snapshot.dialect, compilePlaceholderPatterns(snapshot.placeholderSources).patterns);
});
