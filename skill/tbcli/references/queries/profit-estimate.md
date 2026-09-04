# 入口：查询或导出预估利润

适用：“帮我看看某旗舰店过去7天的预估利润”“帮我看看某负责人过去30天的预估利润，帮我生成 Excel 表格”“生成三位运营7月份的利润情况表”。

按顺序完整读取：

1. [每日预估利润口径](../profit-estimate.md)。
2. [维护清单](../report-maintenance.md) 中旺店通订单、退款和无界商品主体三行；只读取事实范围，不自动运行全清单。

执行：

1. `db status`、`profit orders identity`，取得唯一店铺键。查看订单、退款明确区间 coverage，并用 `db coverage --dataset 无界-商品主体` 确认推广费最新日期。
2. 按口径页把“最近 N 天、过去 N 天、YYYY 年 M 月、M 月份、本月、上月或明确日期”解析为唯一显式区间。“最近 N 天”以推广费最新完整日为结束日；无年份月份取不晚于该日的最近一次该月份。若订单或退款事实缺失，先请求或执行用户已授权的数据维护；不要直接计算。
3. 运行 `profit estimate run` 创建快照。要求 `created:true`，保存 `runId` 和 `eligibleDates`；若 `AD_DATA_NOT_AVAILABLE`，报告尚不可计算。
4. 店铺请求运行 `profit estimate query --group-by shop`，并补充 `day` 或 `owner` 汇总解释波动。单个负责人请求用精确姓名执行 `--group-by day --owner '<姓名>'`，同时用 `owner` 汇总核对姓名存在；无精确命中不猜同音或相似姓名。全部运营或多位运营请求先查询负责人清单，排除“未分配负责人”后，把真实姓名作为显式 `--owners`；未分配金额另行报告。
5. 用户要求 Excel 时选择新路径，执行 `profit estimate export --run-id ... --owner ... --out ...` 或 `--owners ...`；全店请求省略负责人参数。验证五张工作表、全中文字段、金额和百分比格式、负责人筛选及汇总对账。
6. 返回实际计算日期、未出推广费而跳过的日期、核心利润拆分、fallback 金额、未分配负责人金额、runId，以及 Excel 路径（如有）。明确标注“经营预估，不是次月 15 日正式月结”。

完成后返回主 Skill 的 Company Warehouse Flow 交付结果。
