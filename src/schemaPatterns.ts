export interface SchemaPatternWorkspace {
  name: string;
  location: string;
}

export interface SchemaPatternContext {
  resourceLocation: string;
  workspaceFolders: readonly SchemaPatternWorkspace[];
  resourceWorkspaceName?: string;
  userHome: string;
  cwd: string;
  execPath: string;
  pathSeparator: string;
  env: Readonly<Record<string, string | undefined>>;
}

export interface ResolvedSchemaPattern {
  source: string;
  baseLocation: string;
  glob: string;
}

export interface ResolvedSchemaPatterns {
  patterns: ResolvedSchemaPattern[];
  issues: string[];
}

const VARIABLE_PATTERN = /\$\{([^}]+)\}/gu;
const URI_PATTERN = /^[A-Za-z][A-Za-z\d+.-]*:\/\//u;
const WINDOWS_ABSOLUTE_PATTERN = /^(?:[A-Za-z]:[\\/]|\\\\)/u;
const GLOB_CHARACTER_PATTERN = /[*?[{]/u;

export function resolveSchemaPatterns(
  sources: readonly string[],
  context: SchemaPatternContext,
): ResolvedSchemaPatterns {
  const patterns: ResolvedSchemaPattern[] = [];
  const issues: string[] = [];
  for (const source of sources) {
    const expanded = expandVariables(source.trim(), context);
    if (expanded.issue) {
      issues.push(`Ignoring schemaFiles entry "${source}": ${expanded.issue}`);
      continue;
    }
    const resolved = splitSchemaPattern(expanded.value, defaultBaseLocation(context));
    if (!resolved) {
      issues.push(`Ignoring schemaFiles entry "${source}": it does not resolve to a file pattern.`);
      continue;
    }
    patterns.push({ source, ...resolved });
  }
  return { patterns: deduplicatePatterns(patterns), issues };
}

function expandVariables(
  source: string,
  context: SchemaPatternContext,
): { value: string; issue?: string } {
  let issue: string | undefined;
  const value = source.replace(VARIABLE_PATTERN, (_match, rawName: string) => {
    const replacement = resolveVariable(rawName, context);
    if (replacement === undefined || replacement.length === 0) {
      issue ??= `variable \${${rawName}} is unknown or empty.`;
      return '';
    }
    return replacement;
  });
  return { value, issue };
}

function resolveVariable(name: string, context: SchemaPatternContext): string | undefined {
  if (name.startsWith('env:')) {
    return context.env[name.slice(4)];
  }
  if (name.startsWith('workspaceFolder:')) {
    return context.workspaceFolders.find((folder) => folder.name === name.slice('workspaceFolder:'.length))?.location;
  }
  const workspace = resourceWorkspace(context);
  const fileDirectory = dirnameLocation(context.resourceLocation);
  const workspaceLocation = workspace?.location ?? fileDirectory;
  const relativeFile = workspace
    ? relativeLocation(context.resourceLocation, workspace.location)
    : basenameLocation(context.resourceLocation);
  switch (name) {
    case 'workspaceFolder': return workspaceLocation;
    case 'workspaceFolderBasename': return basenameLocation(workspaceLocation);
    case 'userHome': return context.userHome;
    case 'file': return context.resourceLocation;
    case 'fileWorkspaceFolder': return workspaceLocation;
    case 'relativeFile': return relativeFile;
    case 'relativeFileDirname': return dirnameRelative(relativeFile);
    case 'fileBasename': return basenameLocation(context.resourceLocation);
    case 'fileBasenameNoExtension': return removeExtension(basenameLocation(context.resourceLocation));
    case 'fileExtname': return extensionName(basenameLocation(context.resourceLocation));
    case 'fileDirname': return fileDirectory;
    case 'fileDirnameBasename': return basenameLocation(fileDirectory);
    case 'cwd': return context.cwd;
    case 'execPath': return context.execPath;
    case 'pathSeparator':
    case '/': return context.pathSeparator;
    default: return undefined;
  }
}

function splitSchemaPattern(
  expanded: string,
  defaultBase: string,
): { baseLocation: string; glob: string } | undefined {
  const normalized = normalizeSeparators(expanded.trim());
  if (!normalized) return undefined;
  const absolute = isAbsoluteLocation(normalized) ? normalized : joinLocation(defaultBase, normalized);
  const wildcardIndex = absolute.search(GLOB_CHARACTER_PATTERN);
  const separatorIndex = wildcardIndex >= 0
    ? absolute.lastIndexOf('/', wildcardIndex)
    : absolute.lastIndexOf('/');
  const rootLength = locationRootLength(absolute);
  if (separatorIndex < rootLength) {
    return undefined;
  }
  const baseLocation = trimTrailingSeparator(absolute.slice(
    0,
    separatorIndex === rootLength ? separatorIndex + 1 : separatorIndex,
  ));
  const glob = absolute.slice(separatorIndex + 1);
  return baseLocation && glob ? { baseLocation, glob } : undefined;
}

function resourceWorkspace(context: SchemaPatternContext): SchemaPatternWorkspace | undefined {
  return context.workspaceFolders.find((folder) => folder.name === context.resourceWorkspaceName)
    ?? context.workspaceFolders.find((folder) => isLocationWithin(context.resourceLocation, folder.location));
}

function defaultBaseLocation(context: SchemaPatternContext): string {
  return resourceWorkspace(context)?.location ?? dirnameLocation(context.resourceLocation);
}

function isLocationWithin(location: string, parent: string): boolean {
  const normalizedLocation = normalizeForComparison(location);
  const normalizedParent = trimTrailingSeparator(normalizeForComparison(parent));
  return normalizedLocation === normalizedParent || normalizedLocation.startsWith(`${normalizedParent}/`);
}

function relativeLocation(location: string, parent: string): string {
  const normalizedLocation = normalizeSeparators(location);
  const normalizedParent = trimTrailingSeparator(normalizeSeparators(parent));
  return isLocationWithin(normalizedLocation, normalizedParent)
    ? normalizedLocation.slice(normalizedParent.length).replace(/^\//u, '')
    : basenameLocation(normalizedLocation);
}

function dirnameLocation(location: string): string {
  const normalized = trimTrailingSeparator(normalizeSeparators(location));
  const rootLength = locationRootLength(normalized);
  const separator = normalized.lastIndexOf('/');
  if (separator < rootLength) return normalized.slice(0, rootLength);
  return normalized.slice(0, separator === rootLength ? separator + 1 : separator);
}

function basenameLocation(location: string): string {
  const normalized = trimTrailingSeparator(stripQueryAndFragment(normalizeSeparators(location)));
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}

function dirnameRelative(location: string): string {
  const normalized = normalizeSeparators(location);
  const separator = normalized.lastIndexOf('/');
  return separator >= 0 ? normalized.slice(0, separator) : '.';
}

function joinLocation(base: string, relative: string): string {
  return `${trimTrailingSeparator(normalizeSeparators(base))}/${relative.replace(/^\/+/, '')}`;
}

function normalizeSeparators(value: string): string {
  if (value.startsWith('\\\\')) {
    return `//${value.slice(2).replace(/\\/gu, '/')}`;
  }
  return value.replace(/\\/gu, '/');
}

function normalizeForComparison(value: string): string {
  const normalized = normalizeSeparators(value);
  return /^(?:[A-Za-z]:\/|\/\/)/u.test(normalized) || /^file:\/\//iu.test(normalized)
    ? normalized.toLocaleLowerCase()
    : normalized;
}

function isAbsoluteLocation(value: string): boolean {
  return URI_PATTERN.test(value) || WINDOWS_ABSOLUTE_PATTERN.test(value) || value.startsWith('/');
}

function locationRootLength(value: string): number {
  const uri = /^([A-Za-z][A-Za-z\d+.-]*:\/\/[^/]*)(?:\/|$)/u.exec(value);
  if (uri?.[1]) return uri[1].length;
  if (/^[A-Za-z]:\//u.test(value)) return 2;
  if (value.startsWith('//')) {
    const shareEnd = value.indexOf('/', value.indexOf('/', 2) + 1);
    return shareEnd >= 0 ? shareEnd : value.length;
  }
  return value.startsWith('/') ? 0 : -1;
}

function trimTrailingSeparator(value: string): string {
  const rootLength = locationRootLength(value);
  let end = value.length;
  while (end > rootLength + 1 && value[end - 1] === '/') end -= 1;
  return value.slice(0, end);
}

function stripQueryAndFragment(value: string): string {
  const query = value.search(/[?#]/u);
  return query >= 0 ? value.slice(0, query) : value;
}

function extensionName(basename: string): string {
  const dot = basename.lastIndexOf('.');
  return dot > 0 ? basename.slice(dot) : '';
}

function removeExtension(basename: string): string {
  const extension = extensionName(basename);
  return extension ? basename.slice(0, -extension.length) : basename;
}

function deduplicatePatterns(patterns: readonly ResolvedSchemaPattern[]): ResolvedSchemaPattern[] {
  const seen = new Set<string>();
  return patterns.filter((pattern) => {
    const key = `${normalizeForComparison(pattern.baseLocation)}\n${pattern.glob}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
