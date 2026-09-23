# 入口：月度实际利润与数据缺口

适用：计算或导出一个完整自然月的实际经营利润，或独立检查该月达到实际月结所缺的数据。

先读取 [月度实际利润口径](../profit-actual.md)，然后只进入用户请求的分支。计算、导出与数据缺口检查相互独立；完成分支后返回主 Skill 的 Company Warehouse Flow 交付 QA。

## 共同预检

1. 运行 `tbcli --help` 与 `tbcli capabilities --json --all`，检查请求分支所需的 `profit actual` 命令。缺失时返回 `CAPABILITY_UNAVAILABLE`，列出命令、输入和预期输出；不得使用估算利润、通用 `db query`、原始 SQL 或临时脚本替代。
2. 运行 `tbcli db access-check --json`。员工读取实际利润使用只读身份；数据导入和政策维护仍需管理员单独授权。
3. 运行 `tbcli profit orders identity --json` 发现店铺键。用户给出店铺名称时使用唯一匹配；零匹配或多匹配时停止请用户确认。
4. 将自然语言月份解析为唯一 `YYYY-MM`。实际利润只接受完整自然月，不把最近 N 天或任意日期段改称月结。
5. 默认使用已确认的 `operating-profit-v1`：订单头实付为收入总额，商品明细金额仅作为订单内归一化分配权重；平台费6%、税费2%、未匹配运单每单估算2元，缺失成本逐项列出等待确认。商品 `641773251256` 按补差价链接处理，负责人非必填且成本为 `explicit_zero`；政策中已确认的下架商品保留实际收入与成本，但负责人非必填。显式政策版本只接受实时能力清单支持的版本。

## A. 计算分支

执行：

```bash
tbcli profit actual query \
  --shop-key '<店铺键>' \
  --month '<YYYY-MM>' \
  [--policy-version 'operating-profit-v1'] \
  --group-by '<shop|owner|product|day|report>' \
  [--owner '<姓名>' | --owners '<姓名1,姓名2>'] \
  --json
```

- 全店用 `shop`，负责人用 `owner`，商品用 `product`，日趋势用 `day`。生成综合分析报告时优先用 `report`，一次取得 `sections.shop`、`sections.owners` 和 `sections.products`，避免重复计算与跨次结果漂移。
- 负责人从未筛选结果发现；未分配和无法归属项单独披露并保留在店铺总计中。
- 保留 CLI 返回的利润月、退款截止、政策版本、运行状态、来源状态、质量摘要、金额拆分和行数。
- `provisional` 结果可以用于经营判断，但必须披露参考/估算金额及占比；`incomplete` 只报告已知部分与缺口，不称为实际利润。

完成后返回交付 QA，不自动运行 coverage，也不补数据。

## B. Excel 导出分支

先对明确输出路径做只读存在性检查，然后执行：

```bash
tbcli profit actual export \
  --shop-key '<店铺键>' \
  --month '<YYYY-MM>' \
  [--policy-version 'operating-profit-v1'] \
  [--owner '<姓名>' | --owners '<姓名1,姓名2>'] \
  --out '<新文件.xlsx>' \
  --json
```

要求文件存在、非空、可打开，并包含：摘要、负责人汇总、商品汇总、SKU汇总、订单商品明细、退款回挂、物流对账、数据质量、计算规则。核对 JSON 与工作簿中的店铺、月份、退款截止、政策版本、运行状态和总额。

完成后返回交付 QA，不自动运行 coverage 或导入。

## C. 数据缺口分支

执行：

```bash
tbcli profit actual coverage \
  --shop-key '<店铺键>' \
  --month '<YYYY-MM>' \
  [--policy-version '<版本>'] \
  --json
```

按来源分别报告订单与商品行、退款观察窗与回挂、承运商账单与运单匹配、推广费、成本、重量、负责人和政策版本。对每项保留：需要范围、当前覆盖、actual/reference/estimated/explicit_zero/missing 状态、缺失对象或金额、是否阻断 `actual/reconciled`。

输出中的 `calculationPerformed` 必须为 `false`。订单头与商品行原始权重差额、退款头与明细差额、未匹配运单、缺成本行、推广缺日分别判断，不用单一“已导入”状态代替质量检查。订单头实付是选择后的收入金额，商品明细金额标记为分配权重；未匹配运单按每单2元归为 `estimated` 并披露数量与金额；缺失成本返回逐项清单；无法归属退款返回退款单号、旺店通订单号和平台订单号；未分配负责人返回商品ID、商品名称、SKU、ERP编码、订单数、金额和源数据可用的图片链接。

coverage 只报告缺口与已确认政策产生的估算金额。未经用户授权不下载、不导入、不改政策、不写主数据，也不选择新的回退方法。用户补齐一项后重新运行相同月份的 coverage，再继续下一项。

## D. 商品成本审计分支

当用户要核实旺店通订单行 `goodsCost` 是否等于 SKU 单位成本乘销售数量时，执行：

```bash
tbcli profit actual audit-cost \
  --shop-key '<店铺键>' \
  --month '<YYYY-MM>' \
  --product-id '<商品ID>' \
  --json
```

该命令逐订单商品行比较三套数字：旺店通订单行总成本 `goodsCost`、旺店通参考单位成本 `refCostPrice × skuNum`、支付日生效且已批准的 `master.sku_cost_versions.unit_cost × skuNum`。比较容差固定为 0.01 元，必须分别保留可比较、相符、不相符和数据缺失的行数；不能只比较合计，因为逐行差异可能互相抵消。

审计只验证成本来源的一致性，不执行利润计算、不改变成本优先级、不修改数据库，也不讨论负责人或物流分摊。输出逐行订单号、商品/SKU/ERP规格标识、数量、三套成本、两两差额和汇总覆盖。零行表示所选月份内该商品没有符合正式利润订单范围的明细，不能表述为商品不存在。

## 交付 QA

- 明确说明本次进入计算、导出或缺口检查中的哪一个分支。
- 结果明确区分经营实际利润与平台结算时间口径财务利润。
- 报告店铺、月份、退款截止、政策版本和运行状态。
- 利润率用汇总利润除以汇总净销售额，不平均明细利润率。
- 负利润、负净销售、负向快递调整和无法归属退款不得删除或改成零。
- 命令缺失、权限失败、超时或质量门失败时停止并返回真实错误，不反复运行重查询。
- 成本审计必须同时报告逐行差异和三套成本的数据覆盖；`allComparableCostsMatch:true` 只有在所有可比较行都相符时成立，`fullyComparable:true` 才表示三套数据每行都齐全。
