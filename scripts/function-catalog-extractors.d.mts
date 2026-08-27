import type { DocumentedFunctionContract, DocumentedFunctionOverload } from '../src/sqlFunctionCatalogTypes';

export interface DocumentationPage { url: string; html: string }
export function htmlText(html: string): string;
export function parseDocumentationSignature(text: string, returnType?: string, source?: string): DocumentedFunctionOverload | undefined;
export function extractDocumentationContracts(dialect: string, pages: readonly DocumentationPage[]): Record<string, DocumentedFunctionContract>;
export function documentationPageUrls(source: { url: string; extractor: string; additionalUrls?: readonly string[] }, html: string): string[];
