import {
  BooleanExpr, BracketExpr, ColumnExpr, DataTypeExpr, Expression, FilterExpr, IdentifierExpr,
  IgnoreNullsExpr, RespectNullsExpr, TokenType, WindowExpr, WithinGroupExpr,
  type Parser, type Token,
} from '@hdnax/sqlingo.js';
import { Hive } from '@hdnax/sqlingo.js/hive';
import { MySQL } from '@hdnax/sqlingo.js/mysql';
import { Postgres } from '@hdnax/sqlingo.js/postgres';
import { Spark } from '@hdnax/sqlingo.js/spark';
import { Trino } from '@hdnax/sqlingo.js/trino';
import { FlinkDialect } from './sqlFlinkDialect';

export interface SqlSourceFunction {
  readonly id: number;
  readonly name: string;
  readonly start: number;
  readonly nameEnd: number;
  /** Absent when a dedicated grammar parsed only part of the source argument list. */
  readonly arguments?: readonly Expression[];
}

const SOURCE_ID = 'aiopsSqlJsonSourceId';
const SOURCE_SESSION = 'aiopsSqlJsonSourceSession';
const SOURCE_TYPE_NAME = 'aiopsSqlJsonSourceTypeName';
let nextSourceId = 1;

/** Parser copies preserve metadata; an external expression WeakMap would lose this provenance. */
export function sqlSourceFunction(expression: Expression): SqlSourceFunction | undefined {
  const id = expression.meta[SOURCE_ID];
  const session = expression.meta[SOURCE_SESSION];
  return typeof id === 'number' && session instanceof Map ? session.get(id) as SqlSourceFunction | undefined : undefined;
}

export function sqlSourceTypeName(expression: Expression): string | undefined {
  const name = expression.meta[SOURCE_TYPE_NAME];
  return typeof name === 'string' ? name : undefined;
}

function sourceAwareParser<P extends typeof Parser>(Base: P, nullTreatmentArgument = false): P {
  const Parent: typeof Parser = Base;
  return class SourceAwareParser extends Parent {
    private readonly sourceSession = new Map<number, SqlSourceFunction>();
    private readonly calls: {
      token?: Token;
      openingParenthesis?: Token;
      arguments?: Expression[];
    }[] = [];

    override parseTypes(options: Parameters<Parser['parseTypes']>[0] = {}): Expression | undefined {
      const token = this.curr;
      const index = this.index;
      const result = super.parseTypes(options);
      // A single token is a source type name, not a suffix-modified or nested
      // type (for example INT[], TIMESTAMP WITH TIME ZONE, or STRUCT<...>).
      if (result instanceof DataTypeExpr && token && this.index === index + 1) {
        result.meta[SOURCE_TYPE_NAME] = token.text;
      }
      return result;
    }

    static override get PRIMARY_PARSERS(): typeof Parser.PRIMARY_PARSERS {
      return Object.fromEntries(Object.entries(super.PRIMARY_PARSERS).map(([key, parse]) => [
        key,
        function (this: Parser, token: Token): Expression | undefined {
          return parse?.call(this, token)?.updatePositions(token);
        },
      ]));
    }

    override parseFunctionArgs(options: Parameters<Parser['parseFunctionArgs']>[0] = {}): Expression[] {
      const call = this.calls.at(-1);
      // Dialect-specific parsers may consume a leading argument themselves and
      // invoke parseFunctionArgs only for the tail after a comma. Such a tail is
      // not a complete source argument list; let the normalized AST expose the
      // parser's dedicated slots instead.
      const completeSourceList = call?.openingParenthesis === this.prev;
      const args = super.parseFunctionArgs(options);
      if (call && completeSourceList) call.arguments = [...args];
      return args;
    }

    protected recordSourceConstructor(expression: Expression, token: Token, args: readonly Expression[]): void {
      this.recordSource(expression, token, args);
    }

    private recordSource(expression: Expression, token: Token, args?: readonly Expression[]): void {
      const id = nextSourceId++;
      this.sourceSession.set(id, {
        id, name: token.text, start: token.start, nameEnd: token.end + 1,
        ...(args ? { arguments: [...args] } : {}),
      });
      expression.meta[SOURCE_ID] = id;
      expression.meta[SOURCE_SESSION] = this.sourceSession;
    }

    override parseUnnest(options: Parameters<Parser['parseUnnest']>[0] = {}): ReturnType<Parser['parseUnnest']> {
      const token = this.curr;
      const result = super.parseUnnest(options);
      if (result && token) this.recordSource(result, token, result.args.expressions?.filter(
        (argument): argument is Expression => argument instanceof Expression,
      ));
      return result;
    }

    override parseBracket(expression?: Expression): Expression | undefined {
      const constructor = expression instanceof ColumnExpr && !expression.args.table
        && expression.args.this instanceof IdentifierExpr && !expression.args.this.args.quoted
        && this.curr?.tokenType === TokenType.L_BRACKET ? Base.ARRAY_CONSTRUCTORS[expression.name.toUpperCase()] : undefined;
      const token = constructor ? this.prev : undefined;
      const result = super.parseBracket(expression);
      if (constructor && token && result) {
        let target = result;
        while (target instanceof BracketExpr && target.args.this instanceof Expression) target = target.args.this;
        if (target instanceof constructor && !sqlSourceFunction(target)) {
          this.recordSource(target, token, target.args.expressions as Expression[] | undefined);
        }
      }
      return result;
    }

    override parseFunctionCall(options: Parameters<Parser['parseFunctionCall']>[0] = {}): Expression | undefined {
      const call: {
        token?: Token;
        openingParenthesis?: Token;
        arguments?: Expression[];
      } = {
        token: this.curr,
        openingParenthesis: this.next?.tokenType === TokenType.L_PAREN ? this.next : undefined,
      };
      this.calls.push(call);
      try {
        const name = this.curr?.text.toUpperCase();
        if (nullTreatmentArgument && name && ['FIRST', 'LAST', 'FIRST_VALUE', 'LAST_VALUE'].includes(name)
          && this.next?.tokenType === TokenType.L_PAREN && !options.anonymous) {
          const functions = { ...Base.FUNCTIONS, ...options.functions };
          const builder = Base.FUNCTIONS[name]!;
          functions[name] = (args: Expression[]) => {
            if (args.length < 1 || args.length > 2) this.raiseError(`${name} expects one or two arguments`);
            const value = builder(args.slice(0, 1), { dialect: this.dialect });
            if (args[1] instanceof BooleanExpr) {
              return args[1].args.this
                ? new IgnoreNullsExpr({ this: value })
                : new RespectNullsExpr({ this: value });
            }
            return builder(args, { dialect: this.dialect });
          };
          options = { ...options, functions };
        }
        const result = super.parseFunctionCall(options);
        if (result && call.token) {
          let target = result;
          while ((target instanceof WindowExpr || target instanceof IgnoreNullsExpr || target instanceof RespectNullsExpr
            || target instanceof FilterExpr || target instanceof WithinGroupExpr)
            && target.args.this instanceof Expression) target = target.args.this;
          this.recordSource(target, call.token, call.arguments);
        }
        return result;
      } finally {
        this.calls.pop();
      }
    }
  } as unknown as P;
}

class SourceSpark extends Spark { static override Parser = sourceAwareParser(Spark.Parser, true); }
class SourceHive extends Hive { static override Parser = sourceAwareParser(Hive.Parser, true); }
class SourceMySQL extends MySQL { static override Parser = sourceAwareParser(MySQL.Parser); }
class SourcePostgres extends Postgres { static override Parser = sourceAwareParser(Postgres.Parser); }
class SourceTrino extends Trino { static override Parser = sourceAwareParser(Trino.Parser); }
class SourceFlink extends FlinkDialect { static override Parser = sourceAwareParser(FlinkDialect.Parser); }

export const SQL_AST_DIALECTS = {
  spark: SourceSpark, hive: SourceHive, mysql: SourceMySQL,
  postgres: SourcePostgres, trino: SourceTrino, flink: SourceFlink,
};
