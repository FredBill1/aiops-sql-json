import * as vscode from 'vscode';
import {
  getLanguageService,
  type ASTNode,
  type JSONDocument,
  type JSONSchema,
  type LanguageService,
  type SchemaConfiguration,
} from 'vscode-json-languageservice';
import { TextDocument as LspTextDocument } from 'vscode-languageserver-textdocument';

import type { ExtensionConfiguration } from './config';
import {
  projectJsonPlaceholders,
  type JsonPlaceholderOccurrence,
} from './jsonProjection';
import { PlatformProjection } from './projection';

interface JsonSchemaSetting {
  fileMatch?: string | string[];
  url?: string;
  schema?: JSONSchema;
}

interface JsonValidationContribution {
  fileMatch?: string | string[];
  url?: string;
}

export interface ProjectedJsonDocument {
  projection: PlatformProjection;
  textDocument: LspTextDocument;
  jsonDocument: JSONDocument;
  service: LanguageService;
  placeholders: readonly JsonPlaceholderOccurrence[];
  dynamicKeyObjectOffsets: ReadonlySet<number>;
}

export class JsonServiceManager {
  private readonly services = new Map<string, LanguageService>();

  createDocument(
    document: vscode.TextDocument,
    configuration: ExtensionConfiguration,
  ): ProjectedJsonDocument {
    const projection = new PlatformProjection(document.getText());
    const placeholders = configuration.allowPlaceholdersEverywhere
      ? projectJsonPlaceholders(projection.text, configuration.placeholderPatterns)
      : { text: projection.text, occurrences: [] };
    const textDocument = LspTextDocument.create(
      document.uri.toString(true),
      'json',
      document.version,
      placeholders.text,
    );
    const service = this.getService(document.uri);
    const jsonDocument = service.parseJSONDocument(textDocument);
    return {
      projection,
      textDocument,
      jsonDocument,
      service,
      placeholders: placeholders.occurrences,
      dynamicKeyObjectOffsets: findDynamicKeyObjectOffsets(jsonDocument, placeholders.occurrences),
    };
  }

  clear(): void {
    this.services.clear();
  }

  private getService(resource: vscode.Uri): LanguageService {
    const schemas = collectSchemaConfigurations(resource);
    const allowDownload = vscode.workspace.getConfiguration('json', resource).get<boolean>('schemaDownload.enable', true);
    const cacheKey = JSON.stringify({ schemas, allowDownload, trusted: vscode.workspace.isTrusted });
    const existing = this.services.get(cacheKey);
    if (existing) {
      return existing;
    }

    const service = getLanguageService({
      schemaRequestService: (uri) => requestSchema(uri, resource, allowDownload),
      workspaceContext: {
        resolveRelativePath: (relativePath, baseResource) => resolveRelativeUri(relativePath, baseResource),
      },
      clientCapabilities: {
        textDocument: {
          completion: {
            completionItem: {
              documentationFormat: ['markdown', 'plaintext'],
            },
          },
        },
      },
    });
    service.configure({ validate: true, allowComments: false, schemas });
    this.services.set(cacheKey, service);
    return service;
  }
}

function findDynamicKeyObjectOffsets(
  jsonDocument: JSONDocument,
  placeholders: readonly JsonPlaceholderOccurrence[],
): ReadonlySet<number> {
  const offsets = new Set<number>();
  walkAst(jsonDocument.root, (node) => {
    if (node.type !== 'property' || node.parent?.type !== 'object') {
      return;
    }
    const keyStart = node.keyNode.offset;
    const keyEnd = keyStart + node.keyNode.length;
    const isDynamic = placeholders.some((placeholder) => (
      placeholder.kind === 'key'
        ? overlaps(keyStart, keyEnd, placeholder.token.start, placeholder.token.end)
        : overlaps(keyStart, keyEnd, placeholder.match.start, placeholder.match.end)
    ));
    if (isDynamic) {
      offsets.add(node.parent.offset);
    }
  });
  return offsets;
}

function walkAst(node: ASTNode | undefined, visitor: (node: ASTNode) => void): void {
  if (!node) {
    return;
  }
  visitor(node);
  for (const child of node.children ?? []) {
    walkAst(child, visitor);
  }
}

function overlaps(leftStart: number, leftEnd: number, rightStart: number, rightEnd: number): boolean {
  return leftStart < rightEnd && rightStart < leftEnd;
}

function collectSchemaConfigurations(resource: vscode.Uri): SchemaConfiguration[] {
  const schemas: SchemaConfiguration[] = [];
  const folder = vscode.workspace.getWorkspaceFolder(resource);
  const configured = vscode.workspace.getConfiguration('json', resource).get<JsonSchemaSetting[]>('schemas', []);
  configured.forEach((setting, index) => {
    const uri = setting.url
      ? resolveConfiguredSchemaUri(setting.url, folder?.uri ?? documentDirectory(resource))
      : `vscode://schemas/aiops-sql-json/inline/${index}`;
    schemas.push({
      uri,
      fileMatch: normalizeFileMatch(setting.fileMatch),
      schema: setting.schema,
      folderUri: folder?.uri.toString(true),
    });
  });

  for (const extension of vscode.extensions.all) {
    const contributions = extension.packageJSON?.contributes?.jsonValidation as JsonValidationContribution[] | undefined;
    for (const contribution of contributions ?? []) {
      if (!contribution.url) {
        continue;
      }
      schemas.push({
        uri: resolveExtensionSchemaUri(contribution.url, extension.extensionUri),
        fileMatch: normalizeFileMatch(contribution.fileMatch),
      });
    }
  }
  return deduplicateSchemas(schemas);
}

async function requestSchema(uriText: string, resource: vscode.Uri, allowDownload: boolean): Promise<string> {
  const uri = vscode.Uri.parse(uriText);
  if (uri.scheme === 'http' || uri.scheme === 'https') {
    if (!allowDownload) {
      throw new Error('Remote JSON Schema downloads are disabled by json.schemaDownload.enable.');
    }
    if (!vscode.workspace.isTrusted) {
      throw new Error('Remote JSON Schema downloads are not allowed in an untrusted workspace.');
    }
    const response = await fetch(uriText, { headers: { Accept: 'application/schema+json, application/json' } });
    if (!response.ok) {
      throw new Error(`Failed to download JSON Schema: HTTP ${response.status} ${response.statusText}`);
    }
    return response.text();
  }

  if (uri.scheme === 'untitled') {
    throw new Error(`Cannot load a JSON Schema from an unsaved URI: ${uriText}`);
  }
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return new TextDecoder().decode(bytes);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot load JSON Schema ${uriText} for document ${resource.toString(true)}: ${message}`);
  }
}

function resolveConfiguredSchemaUri(value: string, folder: vscode.Uri | undefined): string {
  if (hasUriScheme(value) || !folder) {
    return value;
  }
  return vscode.Uri.joinPath(folder, value).toString(true);
}

function documentDirectory(resource: vscode.Uri): vscode.Uri | undefined {
  if (resource.scheme === 'untitled') {
    return undefined;
  }
  const slash = resource.path.lastIndexOf('/');
  return resource.with({ path: slash >= 0 ? resource.path.slice(0, slash + 1) : resource.path });
}

function resolveExtensionSchemaUri(value: string, extensionUri: vscode.Uri): string {
  if (hasUriScheme(value)) {
    return value;
  }
  return vscode.Uri.joinPath(extensionUri, value).toString(true);
}

function resolveRelativeUri(relativePath: string, baseResource: string): string {
  if (hasUriScheme(relativePath)) {
    return relativePath;
  }
  const base = vscode.Uri.parse(baseResource);
  const slash = base.path.lastIndexOf('/');
  const directory = base.with({ path: slash >= 0 ? base.path.slice(0, slash + 1) : base.path });
  return vscode.Uri.joinPath(directory, relativePath).toString(true);
}

function normalizeFileMatch(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  return Array.isArray(value) ? value : [value];
}

function deduplicateSchemas(schemas: readonly SchemaConfiguration[]): SchemaConfiguration[] {
  const seen = new Set<string>();
  return schemas.filter((schema) => {
    const key = JSON.stringify(schema);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function hasUriScheme(value: string): boolean {
  return /^[a-z][a-z\d+.-]*:/iu.test(value);
}
