# 运行记录与互斥元命令

这四个命令只处理显式计划、本地文件散列、运行记录和同机锁，不选表、不算近期、不访问淘宝或数据库。
通过实时 `capabilities --all --json` 检查存在，缺失时报 CONTRACT_UNSUPPORTED。只检查模式不启动运行。

## 稳定运行目录

`maintenance run-status --json` 返回默认 stateDir，不创建文件；默认在当前用户稳定状态目录下，独立于插件升级。
初次部署将它与业务文件目录约定记入维护机器的私有任务配置，不能写入分发 Skill。
需要把 Excel 保存在项目数据子目录时，可由用户选择 Git/插件目录之外的 state-dir；手动和定时必须保持同一目录。
目录下为 active.json、runs/运行ID/manifest.json、events、artifacts、result.json。文件只新增，不覆盖历史记录。

同一 state-dir 全局互斥，不能用不同 warehouseKey 或不同 Agent 规避。仓库迁移/多机调度前必须先解决分布式互斥，本版本不支持。
运行ID用于定位日志，不是账号凭证；不要把密码、Token、Cookie、连接串、原始HTTP错误或业务行写进计划/事件。

## 开始与查询

由 Agent 在 N2 确定计划，用当前宿主的安全文件写入能力创建一个新 JSON，先检查路径不存在：

```json
{
  "schemaVersion": 1,
  "timezone": "Asia/Shanghai",
  "warehouseKey": "company-commerce",
  "policyDigest": "<清单+日常手册+本协议原文的64位小写SHA-256>",
  "mode": "fill-missing",
  "targets": [
    {"dataset": "item-overall", "startDate": "<实际检查开始日>", "endDate": "<实际检查结束日>", "grain": "day"}
  ]
}
```

示例占位符必须换成真实值；不传任意额外字段。warehouseKey 是维护配置中的非秘密标识，与实际 DB 配置预检绑定，不在这里填写 host/password。
targets 是经过预检的明确检查范围，不是 CLI 选择出的业务范围。不能把未预检的表遗忘：这类表在总任务报告中列为失败，整体不能报 success。

```text
tbcli maintenance run-status --json
tbcli maintenance run-start --input '<新计划.json>' --json
tbcli maintenance run-status --run-id '<返回的runId>' --json
```

自定义目录时四个命令都传同一个 `--state-dir`。所有调用均参数化传 argv，正确引用中文和空格路径；不能执行下载文件中的命令。

## 记录分片与回执

每个事件先创建新 JSON，再用 `run-record --run-id '<ID>' --input '<新事件.json>' --json`。

允许字段：dataset、startDate、endDate、stage、artifact、sha256、rows、errorCode。

- downloaded：artifact 为下载文件绝对路径，sha256 为真实文件散列，rows 可选。
- verified：同一分片必须先有相同文件散列的 downloaded；只有 Agent 执行 Excel/口径/清理 QA 后才能提交。
- imported：必须先有相同散列 verified；先核对真实 db import 回执，再记日志。artifact 仍是源 Excel，另将原始导入回执保存在 artifacts 中。此元命令不验证数据库提交。
- coverage：artifact 为真实 `db coverage --json` 输出文件，sha256 为该回执文件的真实散列；元命令校验文件散列以及 datasetKey、requestedPeriod、complete、expectedPeriods、coveredPeriods 与 missingPeriods。整表完成时提交目标整个检查区间的回执，不能只提交最后一个小分片。
- failed：errorCode 使用 AUTH_REQUIRED、DATABASE_UNAVAILABLE 等标准代码，不把原始错误正文写入记录。

CLI 验证文件散列和回执结构，但不能证明一份手工构造 JSON 来自数据库。Agent 必须保存实际命令输出，不能编造 complete 回执。
文件是本次用户授权的数据或 CLI 回执，禁止传入凭证文件充当 artifact。
日期分片可以在固定目标区间内继续二分，不改 manifest；截断父片记 failed，后续子片分别验证，最后整表 coverage 闭合。

## 结束与恢复

```text
tbcli maintenance run-finish --run-id '<ID>' --status success --json
```

status 可为 success / partial / blocked / cancelled。success 要求每个目标最后一个事件是整个检查范围的完整 coverage；日志不代替真实入库验收。
finish 只关闭该 runId 的本地任务记录并释放锁，不终止其他进程、不回滚数据库。
`ok:false` 的 partial/blocked 是已记录的失败结果，不因为命令退出码0就当业务成功。

遇到 RUN_ACTIVE：查询当前 active runId，禁止自动解锁。只在用户确认旧 Agent/CLI 已停止、没有写操作在途后，显式 finish 旧 runId 为 cancelled/blocked，保留旧文件，再重新检查数据库并启动新计划。
若进程恰好中断在 result 已写而锁尚未释放，用户确认后用相同 runId 和相同终态重试 finish，只补解锁，不改旧结果。
STATE_BUSY 表示瞬时记录操作或异常留下的 operation.lock；允许短间隔再次检查，禁止按锁年龄自动删除。持续存在由管理员核实并通过单独修复处理，普通 Skill 不直接删锁。
