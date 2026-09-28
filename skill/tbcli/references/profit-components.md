# 平台 SKU 与组合子件映射

## 适用与数据口径

此流程维护 `master.platform_sku_component_versions`，用于从订单平台 SKU 还原旺店通系统子件及每售出一件平台 SKU 对应的子件数量。平台 SKU 是业务标识；组合装的子件数量以旺店通当前组合装配置为准。该表是当前配置，不自动代表历史订单发生时的配置；采集日期与生效日期应如实记录。

输入为店铺键、旺店通店铺 ID、待替换的旧批次 ID、生效日期与新文件路径。需要可发现的 `tbcli`、`wdtcli`、旺店通已授权会话、数据仓库读取权限；同步还需要数据库维护权限与用户明确授权。输出为采集快照、差异和缺口、旧行备份、新批次及写后核验。所有原始快照和备份都可能包含经营数据，应保存在授权位置，不放入 npm 包或公开 Skill。

## 主流程

1. 运行 `tbcli --version`、`tbcli capabilities --json`、`tbcli db status --json`，确认实时命令和权限。查询待替换批次的店铺、行数和来源；准确识别旧批次，不用模糊时间范围代替批次 ID。检查每个指定输出路径的存在性，已有文件不覆盖。
2. 采集旺店通的在售平台 SKU、旧批次涉及的平台商品 SKU 与全量组合装：

   ```bash
   tbcli profit components fetch --shop-key '<KEY>' --shop-id '<ID>' --replace-batch-id '<OLD_BATCH_UUID>' --out '<NEW_SNAPSHOT.json>' --json
   ```

   `tbcli` 委托当前 `wdtcli` 采集；发现 `wdtcli` 缺失、登录失效、分页不完整或旺店通限流时，保留已有文件状态并停止，恢复后重新采集到新文件。不得用订单中观察到的比率猜测组合装配置。
3. 核对来源快照和现行主数据：

   ```bash
   tbcli profit components reconcile --input '<SNAPSHOT.json>' --shop-key '<KEY>' --effective-from '<YYYY-MM-DD>' --replace-batch-id '<OLD_BATCH_UUID>' --out '<NEW_RECONCILIATION.json>' --json
   ```

   检查来源 SKU 数、已覆盖 SKU 数、数量变化、新增、旧映射移除和未解决项。组合装必须唯一指向一个有效套装，子件编码与数量必须有效；直接映射必须唯一指向一条系统规格。无法确认的 SKU 只列为缺口，不写批准映射。确认关键差异符合旺店通配置后进入同步；发现来源与店铺不符或分页不完整则返回采集步骤。
4. 获得用户对精确旧批次替换的授权后，用核对得到的旧行数作为 `--expected-old-count`，先运行 `tbcli db write-check --json`，再执行：

   ```bash
   tbcli profit components sync --input '<SNAPSHOT.json>' --shop-key '<KEY>' --effective-from '<YYYY-MM-DD>' --replace-batch-id '<OLD_BATCH_UUID>' --expected-old-count '<N>' --backup-out '<NEW_BACKUP.json>' --yes --json
   ```

   命令先备份旧主数据与旧来源子件行，再在单个事务中精确替换该批次，写入来源哈希、生效日期与缺口数量，并核验当前视图；行数或来源发生变化时回滚。备份文件保留以便审计与恢复，不能复用已有路径。
5. 用只读查询复核目标平台 SKU 的系统规格和 `component_qty`、新旧批次行数、缺口及备份文件大小和权限。回到调用方主流程。需要用于历史利润计算时，另行核实该订单时点组合装配置；当前批次不可自动倒填过去月份。

## 质量与演进

- 报告源快照时间、旧/新批次、旧/新行数、变化数、缺口数与示例；不把“当前已映射”写成“历史已验证”。
- 定期刷新时，重新采集并精确核对当前批准批次；高风险变更保留人工复核。旧批次备份可用于追溯，未核准行由后续旺店通映射补齐。
- 来源、数量、输出或权限校验失败时停止写入，返回对应节点修复，不使用临时 SQL 或一次性脚本绕过 CLI。
