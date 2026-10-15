# 千牛订单主账 v1

`tbcli orders list --all-history --shop-key KEY --out NEW_DIR --json` 获取当前店铺全部可查询“已卖出宝贝”。输出不含买家姓名、账号、电话或地址。

近期与历史分区均包含全部状态。近期按实际页数和总数核验；历史接口的 totalNumber 可能只表示当页数量，必须携带 lastStartRow 游标连续查询到空页，记录终止证据。历史检索边界以平台当时可访问范围为准；结合已知最早业务日期核对覆盖。

响应为 GBK，按声明字符集解码；JSON 数字型长订单号按原始词法转字符串，避免 JavaScript 精度丢失。状态为采集时点快照，采集中订单总数变化、分页重复、游标停滞、验证或结构变化时停止并保存 partial。成功分页不可变保存；恢复使用同一目录添加 --resume RUN_ID，验证已存分片哈希和店铺身份，只请求缺失页。

scope、identity、shards、manifest schemaVersion 1。每条包含 id、createdAt、status、actualFee、currency、items（子单、标题、规格、数量和价格），以及状态注记。actualFee 是页面“实收款”展示字段；待付款和已关闭订单也可能显示金额，不能直接累计为已到账收入。source=taobao、dataset=orders 为订单状态事实，不是现金账本。

对账以平台订单主账为订单全集，供应商表为发货和退货事实，收入账单为结算事实，支付宝/聚合/保证金为资金事实；主子订单组、日期和状态分别关联。物流查证可用 `logistics get --trade-id ID --seller-id SELLER_ID --json`，SELLER_ID 来自本次店铺身份。
