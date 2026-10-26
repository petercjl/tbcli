# 单商品资料采集

输入商品 ID，通过 `item detail` 读取当前登录可见的商品资料，输出新的 JSON。CLI 负责采集与结构化，竞品选择、分析、HTML 核查、确认及台账由调用 Skill 负责。

```bash
tbcli auth status --browser-role buyer --json
tbcli item detail --item-id '<商品ID>' --out '<新文件.json>' [--review-pages N | --review-limit N] [--questions first|all] --json
```

先做登录检查和输出路径预检。使用现有淘宝买家浏览器商品标签页；每个页面操作通过共享延迟与验证检查。遇到登录、风控、接口错误停止，不自动刷新重试；已完成模块保留在输出文件。

## 字段与来源

- `detail.mainImages`：主图链接。
- `detail.skus[]`：字符串 skuId、完整属性组合名称、选项及关联图片、展示价格、优惠前价格、价格标签与库存展示值。`priceMoney` 单位分，`priceText` 保持原文；优惠标签属于当时会话，不保证所有账号的最终支付价。
- `description.images`：商品图文详情组件图片链接，保持出现顺序。
- `reviews.records`：已返回评价正文、时间、SKU 等业务字段；不导出评价者账号和头像。
- `questions.records`：问题、答案、时间、SKU 和回答数量；不导出提问者/回答者账号。
- `sources`：实际来源类型、接口路径或首屏字段路径、采集时间、目标 ID、页码及规范化数据哈希。请求签名、Cookie、用户收货地址和交易参数均不保存。
- `coverage`：六类资料分别标记 captured / partial / unavailable、数量、停止原因。

当前实现采用首屏结构化数据读取主图/SKU，监听 `getdesc/7.0`、`rate.detaillist.get/6.0`、`wdj.list.merge.search/1.0` 的页面自身响应。首屏来源明确标为 `page-hydration`，独立响应标为 `page-api-response`。读取身份必须匹配目标商品；未知结构报错或显式缺失。

## 评价与问大家范围参数

- 默认省略参数：保留当前首响应批次行为，问大家返回其中可见答案。
- `--review-pages N`：包含首批在内获取最多N页评价；当前排序与筛选沿用页面请求。与条数参数二选一。
- `--review-limit N`：获取最多N条按平台记录ID唯一化的原始评价，达到额度或有末页证据时停止。默认模板、空文本与具体评价均保留；有效评价筛选由调用Skill负责。最后一页超出额度的记录完整保留在pages中。
- `--questions first|all`：默认first。all翻取全部可访问问题，并逐问题分页获取回答。折叠或合并隐藏答案、计数未匹配或未知分页状态保留partial及原因；不能绕过平台访问范围。
- 数字参数支持1–10000整数；不合法或两个评价参数同时使用时在进入会话前报错。

评价和问答保留 `pages`、`pagination`，逐问题还保留 `answerPages`、`answerPagination`。记录pagesFetched、stopReason与complete。评价 `target_reached` / `page_limit_reached` 表示调用范围达成，`exhausted`才表示当前可见列表末页；foldedAvailable单独记录折叠缺口。问大家只有问题列表与全部逐问题回答均具备结束证据、无已知隐藏范围时才记complete。重复页无法推进记pagination_stalled，未知下一页标记pagination_unknown。`hasNext`、折叠数量、总数和统计窗原值保留；零条不等于全站无评价。

采集过程中逐页保存检查点，平台登录/验证或接口失败立即停止，保存已成功资料；不自动重试。请求上下文只驻留当前进程内存，结果中只保存规范化业务记录和来源摘要。

```bash
tbcli item detail --item-id '<商品ID>' --review-pages 5 --out '<新文件.json>' --json
tbcli item detail --item-id '<商品ID>' --review-limit 100 --questions all --out '<新文件.json>' --json
```

要求100条有效主动评价时，调用者须根据返回原始记录自行剔除模板并核对数量，原始100条不等于有效100条。

来源兼容性：真实单商品 Codex/macOS 验证；其他页面结构、Agent 和系统需分别验收。只读取用户授权可访问的信息，不绕过平台校验。

问大家的明确空响应：身份匹配，total、questionTotal、foldingCount 均为零，hasNext 与 foldingHasNext 为 false 时，缺省 questionList 规范化为空列表；字段未知或数量非零时仍报告结构异常。

图文详情支持 desc_richtext_pc、desc_richtext 富文本与 desc_single_image 图片组件。图片组件严格按 components.layout 顺序读取，校验商品身份，排除平台价格说明组件。
