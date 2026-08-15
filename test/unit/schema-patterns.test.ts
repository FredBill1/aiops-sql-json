import { describe, expect, it } from 'vitest';

import { resolveSchemaPatterns, type SchemaPatternContext } from '../../src/schemaPatterns';

const windowsContext: SchemaPatternContext = {
  resourceLocation: 'C:\\work\\main\\queries\\job.sql',
  workspaceFolders: [
    { name: 'Main', location: 'C:\\work\\main' },
    { name: 'Shared', location: 'C:\\work\\shared' },
  ],
  resourceWorkspaceName: 'Main',
  userHome: 'C:\\Users\\developer',
  cwd: 'C:\\work\\main',
  execPath: 'C:\\Program Files\\Microsoft VS Code\\Code.exe',
  pathSeparator: '\\',
  env: { SCHEMA_HOME: 'C:\\catalog', RELATIVE_SCHEMA: 'environment-schema' },
};

describe('schema file pattern variables', () => {
  it('resolves the default and relative patterns against the resource workspace', () => {
    expect(resolveSchemaPatterns(['${workspaceFolder}/schema/*.sql', 'schemas/**/*.sql'], windowsContext)).toEqual({
      patterns: [
        { source: '${workspaceFolder}/schema/*.sql', baseLocation: 'C:/work/main/schema', glob: '*.sql' },
        { source: 'schemas/**/*.sql', baseLocation: 'C:/work/main/schemas', glob: '**/*.sql' },
      ],
      issues: [],
    });
  });

  it('supports named workspaces and file-derived variables', () => {
    const result = resolveSchemaPatterns([
      '${workspaceFolder:Shared}/ddl/**/*.sql',
      '${fileDirname}/local/*.sql',
      '${workspaceFolder}/${relativeFileDirname}/${fileBasenameNoExtension}-schema/*.sql',
      '${fileWorkspaceFolder}/${fileDirnameBasename}/${fileExtname}/*.sql',
    ], windowsContext);
    expect(result.issues).toEqual([]);
    expect(result.patterns.map((pattern) => [pattern.baseLocation, pattern.glob])).toEqual([
      ['C:/work/shared/ddl', '**/*.sql'],
      ['C:/work/main/queries/local', '*.sql'],
      ['C:/work/main/queries/job-schema', '*.sql'],
      ['C:/work/main/queries/.sql', '*.sql'],
    ]);
  });

  it('supports home, cwd, executable, environment, and separator variables', () => {
    const result = resolveSchemaPatterns([
      '${userHome}${pathSeparator}ddl${/}*.sql',
      '${cwd}/cwd-schema/*.sql',
      '${env:SCHEMA_HOME}/**/*.sql',
      '${workspaceFolder}/${env:RELATIVE_SCHEMA}/*.sql',
      '${execPath}/../schema/*.sql',
    ], windowsContext);
    expect(result.issues).toEqual([]);
    expect(result.patterns.map((pattern) => pattern.baseLocation)).toEqual([
      'C:/Users/developer/ddl',
      'C:/work/main/cwd-schema',
      'C:/catalog',
      'C:/work/main/environment-schema',
      'C:/Program Files/Microsoft VS Code/Code.exe/../schema',
    ]);
  });

  it('preserves remote workspace URIs and falls back to the file directory without a workspace', () => {
    const remote = resolveSchemaPatterns(['${workspaceFolder}/schema/*.sql'], {
      ...windowsContext,
      resourceLocation: 'vscode-remote://ssh-remote+box/home/me/project/query.sql',
      workspaceFolders: [{ name: 'Remote', location: 'vscode-remote://ssh-remote+box/home/me/project' }],
      resourceWorkspaceName: 'Remote',
      pathSeparator: '/',
    });
    expect(remote.patterns[0]).toMatchObject({
      baseLocation: 'vscode-remote://ssh-remote+box/home/me/project/schema',
      glob: '*.sql',
    });

    const loose = resolveSchemaPatterns(['${workspaceFolder}/schema/*.sql', 'relative/*.sql'], {
      ...windowsContext,
      resourceLocation: '/tmp/project/query.sql',
      workspaceFolders: [],
      resourceWorkspaceName: undefined,
      pathSeparator: '/',
    });
    expect(loose.patterns.map((pattern) => pattern.baseLocation)).toEqual([
      '/tmp/project/schema',
      '/tmp/project/relative',
    ]);

    const looseBesideAnotherWorkspace = resolveSchemaPatterns(['relative/*.sql'], {
      ...windowsContext,
      resourceLocation: 'C:\\loose\\query.sql',
      resourceWorkspaceName: undefined,
    });
    expect(looseBesideAnotherWorkspace.patterns[0]?.baseLocation).toBe('C:/loose/relative');
  });

  it('resolves untitled resources against their selected workspace', () => {
    const result = resolveSchemaPatterns(['${workspaceFolder}/schema/*.sql', 'relative/*.sql'], {
      ...windowsContext,
      resourceLocation: 'untitled:Untitled-1',
      resourceWorkspaceName: 'Main',
    });
    expect(result.patterns.map((pattern) => pattern.baseLocation)).toEqual([
      'C:/work/main/schema',
      'C:/work/main/relative',
    ]);
    expect(result.issues).toEqual([]);
  });

  it('preserves local and URI roots when the wildcard starts directly beneath them', () => {
    const result = resolveSchemaPatterns([
      'C:/*.sql',
      '/**/*.sql',
      'vscode-remote://ssh-remote+box/*.sql',
    ], windowsContext);
    expect(result.patterns.map((pattern) => [pattern.baseLocation, pattern.glob])).toEqual([
      ['C:/', '*.sql'],
      ['/', '**/*.sql'],
      ['vscode-remote://ssh-remote+box/', '*.sql'],
    ]);
  });

  it('ignores entries with unknown, unsupported, missing, or empty variables', () => {
    const result = resolveSchemaPatterns([
      '${workspaceFolder:Missing}/schema/*.sql',
      '${env:EMPTY}/schema/*.sql',
      '${command:pickFolder}/schema/*.sql',
      '${selectedText}/schema/*.sql',
    ], { ...windowsContext, env: { ...windowsContext.env, EMPTY: '' } });
    expect(result.patterns).toEqual([]);
    expect(result.issues).toHaveLength(4);
    expect(result.issues.every((issue) => issue.includes('unknown or empty'))).toBe(true);
  });
});
