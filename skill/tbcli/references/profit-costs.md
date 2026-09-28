# 旺店通当前子件成本同步

适用：维护者要求把旺店通系统货品规格的最新 `refCostPrice` 同步到利润仓库。该字段是系统规格固定成本价，不是订单导入时的 `raw.wdt_order_lines.source_ref_unit_cost` 快照，也不是组合装本身的售价或成本。

## 主线

1. 发现 `profit costs fetch|reconcile|sync` 的实时能力，检查旺店通采集入口、数据库连接与维护者写入身份。选择一个新的 JSON 输出路径并预检不存在。
2. `tbcli profit costs fetch --out '<新文件.json>' --json` 完整取得旺店通系统货品规格。核对 `goodsCount`、`specCount`、文件存在、非空及来源时间。
3. `tbcli profit costs reconcile --input '<文件.json>' --shop-key '<店铺键>' --effective-from '<YYYY-MM-DD>' --json`。以订单和当前 SKU 身份中出现的 ERP 规格为店铺同步范围，优先用系统货品编码加规格编码定位。检查待更新、保持不变、来源零值、未匹配和歧义。只有获得完整来源与唯一可用正成本的规格才进入同步。
4. 用户明确授权本次成本入库后，运行 `tbcli profit costs sync`，参数与第 3 步相同。命令以事务写入新成本版本并回读 `master.current_sku_costs`；已有历史版本保留可追溯。再次运行 `reconcile`，要求 `changedCount=0`。报告新增/接续数量、批次、来源时间与未解决项。
5. 返回实际利润主线。重新运行利润计算时，默认政策读取当前审核成本；订单成本快照仍用于对照审计。

## 边界

- `master.current_sku_costs.unit_cost` 是当前已批准 SKU 成本；底层版本表是 `master.sku_cost_versions`。同步只更新目标店铺用到的 ERP 规格，不把整个旺店通货品库错误归给目标店铺。
- 旺店通来源成本为零或空、货品/规格身份歧义、编码无法匹配时不覆盖已有正成本，也不凭订单 `goodsCost` 推断成本。输出逐项待核查清单。明确确认的零成本业务对象由利润政策单独登记为 `explicit_zero`。
- 采集依赖已配置的 `wdtcli`；凭据留在其受保护的用户环境，不进入 npm 包或 Skill。采集不可用时返回依赖错误，不改仓库。
- 同步成本主数据需要数据库维护权限和明确用户授权；查询、核对与利润计算保持只读。
