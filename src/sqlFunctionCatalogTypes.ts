import type { SqlFunctionParameter, SqlFunctionReturnRule } from './sqlFunctionSignatures';

export interface DocumentedFunctionOverload {
  readonly name: string;
  readonly parameters: readonly (SqlFunctionParameter & { readonly declaredType: string })[];
  readonly returns?: SqlFunctionReturnRule;
  readonly signature: string;
  readonly source: string;
}

export interface DocumentedFunctionContract {
  readonly completeness: 'complete' | 'partial' | 'name-only';
  readonly overloads: readonly DocumentedFunctionOverload[];
}
