import type * as vscode from 'vscode';

import { configurationSignature, getExtensionConfiguration, type ExtensionConfiguration } from './config';
import { analyzeSqlEditingStructure, type SqlEditingStructure } from './editingCore';
import type { JsonServiceManager } from './jsonService';
import { extractSqlRegions, type SqlJsonRegion } from './regions';

export interface SqlEditingRegion {
  region: SqlJsonRegion;
  structure: SqlEditingStructure;
  contentStart: number;
  contentEnd: number;
}

export interface SqlDocumentEditingAnalysis {
  configuration: ExtensionConfiguration;
  regions: readonly SqlEditingRegion[];
}

interface CachedAnalysis {
  version: number;
  signature: string;
  analysis: SqlDocumentEditingAnalysis;
}

export class SqlEditingContextService {
  private readonly cache = new Map<string, CachedAnalysis>();

  constructor(private readonly jsonServices: JsonServiceManager) {}

  get(document: vscode.TextDocument): SqlDocumentEditingAnalysis {
    const configuration = getExtensionConfiguration(document.uri);
    const signature = configurationSignature(configuration);
    const key = document.uri.toString();
    const existing = this.cache.get(key);
    if (existing?.version === document.version && existing.signature === signature) {
      return existing.analysis;
    }

    const projected = this.jsonServices.createDocument(document, configuration);
    const regions = extractSqlRegions(
      projected.projection,
      projected.jsonDocument,
      configuration.keyPatterns,
    ).map((region): SqlEditingRegion => {
      const firstSpan = region.decoded.spans[0];
      const lastSpan = region.decoded.spans.at(-1);
      return {
        region,
        structure: analyzeSqlEditingStructure(region.decoded.text),
        contentStart: firstSpan?.start ?? Math.min(region.originalRange.start + 1, region.originalRange.end),
        contentEnd: lastSpan?.end ?? Math.max(region.originalRange.end - 1, region.originalRange.start),
      };
    });
    const analysis = { configuration, regions };
    this.cache.set(key, { version: document.version, signature, analysis });
    return analysis;
  }

  findRegionAtOffset(
    document: vscode.TextDocument,
    originalOffset: number,
  ): SqlEditingRegion | undefined {
    return this.get(document).regions.find((candidate) => (
      originalOffset >= candidate.contentStart && originalOffset <= candidate.contentEnd
    ));
  }

  findRegionContainingRange(
    document: vscode.TextDocument,
    startOffset: number,
    endOffset: number,
  ): SqlEditingRegion | undefined {
    return this.get(document).regions.find((candidate) => (
      startOffset >= candidate.contentStart && endOffset <= candidate.contentEnd
    ));
  }

  clear(document?: vscode.TextDocument): void {
    if (document) {
      this.cache.delete(document.uri.toString());
    } else {
      this.cache.clear();
    }
  }
}
