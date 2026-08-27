import { AnonymousExpr, ColumnExpr, IdentifierExpr, KwargExpr, TokenType, type Expression } from '@hdnax/sqlingo.js';
import { Trino } from '@hdnax/sqlingo.js/trino';

/** Flink's additions to the shared SQL grammar, preserving the original tokens. */
class FlinkTokenizer extends Trino.Tokenizer {
  static override IDENTIFIERS = [...Trino.Tokenizer.IDENTIFIERS, '`'];

  static override get ORIGINAL_KEYWORDS(): Record<string, TokenType> {
    return { ...super.ORIGINAL_KEYWORDS, 'FOR SYSTEM_TIME': TokenType.TIMESTAMP_SNAPSHOT };
  }
}

class FlinkParser extends Trino.Parser {
  override parseBracket(expression?: Expression): Expression | undefined {
    if (expression instanceof ColumnExpr && !expression.args.table
      && expression.args.this instanceof IdentifierExpr && !expression.args.this.args.quoted
      && expression.name.toUpperCase() === 'MAP' && this.match(TokenType.L_BRACKET)) {
      const args = this.parseCsv(() => this.parseBracketKeyValue());
      if (!this.match(TokenType.R_BRACKET)) this.raiseError('Expected ]');
      if (args.length % 2 !== 0) this.raiseError('MAP requires key/value pairs');
      const map = new AnonymousExpr({ this: 'MAP', expressions: args });
      map.updatePositions(expression);
      return super.parseBracket(map);
    }
    return super.parseBracket(expression);
  }

  static override get FUNC_TOKENS(): Set<TokenType> {
    return new Set([...super.FUNC_TOKENS, TokenType.SESSION]);
  }

  override parseFunctionArgs(options: { alias?: boolean } = {}): Expression[] {
    return this.parseCsv(() => {
      if (this.next?.tokenType === TokenType.FARROW) {
        const name = this.parseIdVar();
        this.match(TokenType.FARROW);
        return new KwargExpr({ this: name, expression: this.parseTableArgument(options) });
      }
      return this.parseTableArgument(options);
    });
  }

  private parseTableArgument(options: { alias?: boolean }): Expression | undefined {
    // TABLE name is a relation-valued argument, whereas TABLE(...) is the
    // enclosing table-function call. Let the relation parser own its grammar.
    const parenthesizedQuery = this.next?.tokenType === TokenType.L_PAREN
      && [TokenType.SELECT, TokenType.WITH, TokenType.L_PAREN].includes(this.tokens[this.index + 2]?.tokenType as TokenType);
    if (this.curr?.tokenType !== TokenType.TABLE || (this.next?.tokenType === TokenType.L_PAREN && !parenthesizedQuery)) {
      return this.parseLambda(options);
    }
    this.advance();
    const relation = this.parseTable();
    if (this.match(TokenType.PARTITION_BY)) {
      const columns: Expression[] = [];
      if (this.match(TokenType.L_PAREN, { advance: false })) {
        columns.push(...this.parseWrappedCsv(() => this.parseColumn()));
      } else {
        const column = this.parseColumn();
        if (column) columns.push(column);
        // The next function/keyword argument belongs to the TVF, not the
        // partition key list. This is token-level grammar lookahead.
        while (this.match(TokenType.COMMA, { advance: false })
          && this.tokens[this.index + 2]?.tokenType !== TokenType.L_PAREN
          && this.tokens[this.index + 2]?.tokenType !== TokenType.FARROW) {
          this.advance();
          const next = this.parseColumn();
          if (!next) break;
          columns.push(next);
        }
      }
      if (columns.length === 0) this.raiseError('Expected a partition column');
      relation?.setArgKey('partitionBy', columns);
    }
    return relation;
  }
}

export class FlinkDialect extends Trino {
  static override Tokenizer = FlinkTokenizer;
  static override Parser = FlinkParser;
}
