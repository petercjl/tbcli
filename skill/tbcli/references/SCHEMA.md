# tbcli 维护知识导航

日常更新采用 hybrid：主 Skill 负责路由和硬边界，本目录负责表格规则、日期判断和失败恢复。
先读 index 与近期 log，再按 queries 选择页面。其他普通下载、查询仍用原主流程。
唯一表格清单是 report-maintenance.md；daily-update.md 不复制表格定义。
预估利润属于按需应用层，路由在 queries/profit-estimate.md，口径在 profit-estimate.md；它读取维护事实但不加入每日采集动作。
月度实际利润属于独立的按需应用层，路由在 queries/profit-actual.md，口径在 profit-actual.md。计算与数据缺口检查是两个独立分支；二者都不加入每日采集动作，也不允许缺口反向改写公式。
商品主图映射属于按需主数据维护，规则在 product-images.md；以商品 ID 为唯一键，定期重导通过 upsert 修正变化的图片链接，不加入每日采集动作。
来源等级 W=正式知识库，U=用户确认，E=代码/执行证据，A=待验证建议。
source-manifest.md 用于维护溯源，不是每次运行必读。测试和标准答案不随运行加载。
