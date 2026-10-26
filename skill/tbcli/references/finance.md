# 财务能力契约 v1

发现：`tbcli finance identity --json`、`tbcli finance catalog --source taobao|alipay|aggregate|deposit --json`。

采集：`tbcli finance fetch --source SOURCE --dataset ID --shop-key KEY --account-id ID --start-date YYYY-MM-DD --end-date YYYY-MM-DD --out NEW_DIR --json`。日期为上海时区含首尾日；月粒度要求完整自然月。淘宝明细 ID 来自实时目录，不跨店硬编码。聚合支持 ledger/withdrawals/freezes/months；保证金 cash/insurance；支付宝 ledger（现金流水）与 trades（按创建时间的交易订单状态）。

余额：`tbcli finance balances --source SOURCE --shop-key KEY --account-id ID --at TIME --out NEW.json --json`。TIME 为 now（支付宝、聚合、保证金），或 `YYYY-MM-01T00:00:00+08:00`（聚合、支付宝已结束月份）。支付宝实时余额核对指定账户，合计可用和冻结资金；另列保证金放在 relatedAccounts，includedInTotal=false。历史保证金余额暂不可用；返回 unavailable/null，不推算。总额、可用、冻结、提现中分别保留。

身份仅证明当前会话中平台返回的账户；店铺键和账户 ID 为调用者明确指定的范围标签，`bindingStatus` 尚待应用确认，不代表已核实绑定。支付宝可能混合个人或其他店铺收支。

输出 v1：run.json 固定范围；不可变 shard-*.json 保存业务响应、分页、窗口和 SHA-256；manifest-*.json 声明 complete/partial、分页停止证据和覆盖范围。字段金额维持源格式；保证金 amount 为整数分，其他来源金额为元；ID 保留字符串，应用归一化时处理单位。冻结与解冻需组合 ID、类型、时间、金额区分。

恢复：在同一 --out 上添加 `--resume RUN_ID`，来源、账单、账户、店铺和日期必须相同；验证已成功分片哈希，仅请求缺失页。不覆盖旧 manifest。并发锁冲突立即停止；异常中断遗留锁需要人工确认无采集进程后清理。

所有请求串行经过共享等待与登录/验证守卫；验证立即停止并保存 partial，不自动重试。输出不保存请求 URL、Cookie、Token、签名或头。原始业务响应含私有账务数据，目录700/文件600，应留在用户数据区域。

`complete` 只表示指定范围分页结束，不证明历史无遗漏或经营分类正确。可用历史日期边界未提供时保持 null，跨来源时间更新不同。收入、费用、月日汇总和资金流水可能重复描述同一事件；能力层不做业务去重、转账抵销或利润计算。

支付宝 trades 保留订单金额、支付金额、实收金额、退款金额、待收款、创建/支付时间和平台原始状态；与 ledger 分开采集，状态为采集时点快照。交易订单不是现金流水，不按订单金额增加账户收入。ALL 为当前账号可访问交易，应用按平台及订单身份确认店铺范围；微信订单不保证出现在支付宝交易查询中。
