这组文件用于复现 Spark schema 检查把合法的 DOUBLE 输出误判成 STRING 的问题，未修改扩展实现。它们是根据 CTE、UNION ALL、两处 CAST 的记忆找到的两个候选，不能据此确定哪一个就是原来遇到的语句。

用当前扩展打开本目录的 `repro.code-workspace`，设置已经开启 Spark 方言、普通 SQL 文件支持和 schema 检查，DDL 位于 `schema/tables.sql`。如 schema 尚未加载，可执行 `AIOps SQL JSON: Force Rebuild Schema Index`。

- `baseline.sql`：只有两处分支的 `CAST AS DOUBLE`。当前没有诊断，最后的 `value` 是 DOUBLE，跳转定义返回两处 CAST 投影。
- `ansi-union.sql`：CTE 中保留两个 CAST，外层再 UNION ALL 一个字符串默认值 `'0'`。当前报 `Cannot assign string value to value (DOUBLE).`。第 12 行 `SELECT value` 上跳转定义仍返回两处 CAST，第 4、7 行。ANSI 模式下 STRING 和 DOUBLE 的 UNION 输出应为 DOUBLE；文件显式设置 ANSI 模式以排除 Spark 默认配置差异。将 `'0'` 改成 `0.0`，误报消失。
- `star-except.sql`：两个分支用 `* EXCEPT (raw_value)` 排除原始 STRING 列，再输出 CAST 结果，最终 SELECT * 写入。当前报 `INSERT writes 2 value(s) into 1 target column(s).` 以及 `Cannot assign string value to value (DOUBLE).`。第 10 行 `WHERE value` 上跳转定义返回第 2、5 行的两处 CAST，类型仍是 DOUBLE。扩展的 CTE 列却包含 `[raw_value STRING, value DOUBLE]`。Spark 4.0.1 支持该 EXCEPT 语法，正确输出只有 `[value DOUBLE]`。将最终 `SELECT *` 改成 `SELECT value`，误报消失。

已用独立 VS Code 1.138.0 扩展宿主加载当前 0.0.24 构建，确认两个候选在真正的编辑器诊断、Hover 和 Go to Definition 中都出现上述现象；baseline 没有诊断。结果保存在 `extension-host-evidence.json`。

自动验证命令：

```powershell
npm run test:unit -- test/unit/sql-schema-spark-cast-union-repro.test.ts
```

测试检查了语法、具体诊断、类型及两处投影定义，并使用 `it.fails` 保留两个应无诊断的验收断言。预期失败表示当前误报仍可复现，不是修复已完成。

合法性依据：[Spark 4.0.1 ANSI 类型转换文档](https://spark.apache.org/docs/4.0.1/sql-ref-ansi-compliance.html)、[ANSI UNION 类型合并源码](https://github.com/apache/spark/blob/v4.0.1/sql/catalyst/src/main/scala/org/apache/spark/sql/catalyst/analysis/AnsiTypeCoercion.scala)、[STRING 与小数类型合并为 DOUBLE 的源码](https://github.com/apache/spark/blob/v4.0.1/sql/catalyst/src/main/scala/org/apache/spark/sql/catalyst/analysis/AnsiStringPromotionTypeCoercion.scala)、[Spark 4.0.1 星号 EXCEPT 文档](https://spark.apache.org/docs/4.0.1/sql-ref-syntax-qry-star.html)。已验证扩展分析结果；本机没有 Spark/Java，未执行 Spark 数据库语句。
