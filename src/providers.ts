import * as vscode from 'vscode';

import { getExtensionConfiguration } from './config';
import { rangeContainsOffset } from './jsonProjection';
import type { JsonServiceManager } from './jsonService';
import { originalPositionToLsp, toVscodeCompletionItem, toVscodeHover } from './lspConverters';
import { extractSqlRegions, findSqlRegionAtProjectedOffset } from './regions';

export class JsonCompletionProvider implements vscode.CompletionItemProvider {
  constructor(private readonly jsonServices: JsonServiceManager) {}

  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.CompletionList | undefined> {
    const configuration = getExtensionConfiguration(document.uri);
    const projected = this.jsonServices.createDocument(document, configuration);
    const projectedOffset = projected.projection.toProjectedOffset(document.offsetAt(position));
    if (projected.placeholders.some((placeholder) => rangeContainsOffset(placeholder.token, projectedOffset))) {
      return undefined;
    }
    const regions = extractSqlRegions(projected.projection, projected.jsonDocument, configuration.keyPatterns);
    if (findSqlRegionAtProjectedOffset(regions, projectedOffset)) {
      return undefined;
    }

    const result = await projected.service.doComplete(
      projected.textDocument,
      originalPositionToLsp(document, position, projected.textDocument, projected.projection),
      projected.jsonDocument,
    );
    if (!result || token.isCancellationRequested) {
      return undefined;
    }
    return new vscode.CompletionList(
      result.items.map((item) => toVscodeCompletionItem(
        document,
        projected.textDocument,
        projected.projection,
        item,
      )),
      result.isIncomplete,
    );
  }
}

export class JsonHoverProvider implements vscode.HoverProvider {
  constructor(private readonly jsonServices: JsonServiceManager) {}

  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.Hover | undefined> {
    const configuration = getExtensionConfiguration(document.uri);
    const projected = this.jsonServices.createDocument(document, configuration);
    const projectedOffset = projected.projection.toProjectedOffset(document.offsetAt(position));
    if (projected.placeholders.some((placeholder) => rangeContainsOffset(placeholder.token, projectedOffset))) {
      return undefined;
    }
    const regions = extractSqlRegions(projected.projection, projected.jsonDocument, configuration.keyPatterns);
    if (findSqlRegionAtProjectedOffset(regions, projectedOffset)) {
      return undefined;
    }

    const hover = await projected.service.doHover(
      projected.textDocument,
      originalPositionToLsp(document, position, projected.textDocument, projected.projection),
      projected.jsonDocument,
    );
    if (!hover || token.isCancellationRequested) {
      return undefined;
    }
    return toVscodeHover(document, projected.textDocument, projected.projection, hover);
  }
}
