# 预策类目月数据入库

## 输入与边界

接受预策导出的一级、二级、三级类目**月数据** `.xlsx`，每份文件只有相应的
`一级类目月数据`、`二级类目月数据` 或 `三级类目月数据` 一张数据工作表。
单独的元数据工作表、混合级别和重复的“月份＋完整类目路径”均拒绝。
从 Excel 的完整一级/二级/三级名称构建类目键；三级名称即使包含 `>`，也按
源字段的完整字符串保存，不额外拆分。来源缺少平台类目 ID，名称或层级调整时
应先核实是否同一类目，不自动合并历史。

## 主线

1. 从 `tbcli --help`、`tbcli capabilities --json` 确认 `db yuce` 命令。对每个输入先运行
   `tbcli db yuce validate --input '<文件.xlsx>' --json`；核对级别、月份、行数、唯一类目数。
2. 导入前要求维护者身份。执行 `tbcli db access-check --json` 和
   `tbcli db write-check --json`，写入检查必须 `ok: true`、`probe.rolledBack: true`、
   `probe.residueCount: 0`。`db yuce init` 仅创建预策专用表；勿修改已有业务表。
3. 依次导入一级、二级、三级文件：

   ```bash
   tbcli db yuce init --json
   tbcli db yuce import --input '<一级.xlsx>' --mode append --json
   tbcli db yuce import --input '<二级.xlsx>' --mode append --json
   tbcli db yuce import --input '<三级.xlsx>' --mode append --json
   ```

   `append` 拒绝不同文件对已存在类目月份的覆盖；相同文件摘要重跑会跳过。
   经确认的源数据修订才使用 `--mode upsert`。每个文件在事务内完整导入或回滚。
   二级必须已有一级父类目，三级必须已有二级父类目。
4. 运行 `tbcli db yuce status --json` 核对分级类目数、月数据行数、覆盖月份、
   批次数、父子成交额差异和排行表行数。若只有部分子类目文件已导入，父子
   成交额可能暂不相等；全部相关文件完成后才作为最终对账结果。

## 数据语义与排行预留

类目月数据以“类目＋月份”为唯一键，金额使用原始数值，不用展示文本反算。
环比保存源值，不对月度环比求和。一级成交量为零而成交额为正时保留源值并标记
`suspect_missing`，分析时不能解读为真实零销量；二、三级未提供成交量，标记
`not_collected`。原始行与来源文件摘要留在库中供审计。

`market.yuce_ranking_snapshots`、`market.yuce_product_rank_rows` 和
`market.yuce_shop_rank_rows` 仅为将来选中叶子类目后的按需采集预留；目前
`db yuce import` 只处理类目月数据，不声称能够导入排行。等拿到真实排行文件，
再按其周期、排行口径和字段扩展对应 CLI 命令。
