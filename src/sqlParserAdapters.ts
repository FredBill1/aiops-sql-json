import {
  BooleanExpr, DataTypeExpr, Expression, IgnoreNullsExpr, RespectNullsExpr, TokenType, WindowExpr,
  type Parser, type Token,
} from '@hdnax/sqlingo.js';
import { Hive } from '@hdnax/sqlingo.js/hive';
import { MySQL } from '@hdnax/sqlingo.js/mysql';
import { Postgres } from '@hdnax/sqlingo.js/postgres';
import { Spark } from '@hdnax/sqlingo.js/spark';
import { Trino } from '@hdnax/sqlingo.js/trino';
import { FlinkDialect } from './sqlFlinkDialect';

export interface SqlSourceCall {
  readonly name: string;
  readonly start: number;
  readonly nameEnd: number;
  readonly arguments: readonly Expression[];
}

/** Source arguments are not the rewritten expression's implementation slots. */
export const sqlSourceCalls = new WeakMap<Expression, SqlSourceCall>();
/** Keep scalar type spellings that the parser otherwise normalizes across dialects. */
export const sqlSourceTypeNames = new WeakMap<Expression, string>();

function sourceAwareParser<P extends typeof Parser>(Base: P, nullTreatmentArgument = false): P {
  const Parent: typeof Parser = Base;
  return class SourceAwareParser extends Parent {
    private readonly calls: { token?: Token; arguments?: Expression[] }[] = [];

    override parseTypes(options: Parameters<Parser['parseTypes']>[0] = {}): Expression | undefined {
      const token = this.curr;
      const index = this.index;
      const result = super.parseTypes(options);
      // A single token is a source type name, not a suffix-modified or nested
      // type (for example INT[], TIMESTAMP WITH TIME ZONE, or STRUCT<...>).
      if (result instanceof DataTypeExpr && token && this.index === index + 1) {
        sqlSourceTypeNames.set(result, token.text);
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
      const args = super.parseFunctionArgs(options);
      const call = this.calls.at(-1);
      if (call) call.arguments = [...args];
      return args;
    }

    override parseFunctionCall(options: Parameters<Parser['parseFunctionCall']>[0] = {}): Expression | undefined {
      const call: { token?: Token; arguments?: Expression[] } = { token: this.curr };
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
        if (result && call.token && call.arguments) {
          let target = result;
          while ((target instanceof WindowExpr || target instanceof IgnoreNullsExpr || target instanceof RespectNullsExpr)
            && target.args.this instanceof Expression) target = target.args.this;
          sqlSourceCalls.set(target, {
            name: call.token.text, start: call.token.start, nameEnd: call.token.end + 1,
            arguments: call.arguments,
          });
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
