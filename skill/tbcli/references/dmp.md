# 竞品独立查询入口

指定单个竞品的经营、推广、关键词和新老人群分析统一走 `dmp catalog → dmp snapshot → 覆盖核对`，仅输入目标商品。先读取下文“单周期竞品独立分析快照”。完整分析所需的独立路径缺口应如实报告，不增加选品步骤。

以下旧 `dmp report` 是另行明确调用的历史双商品协议，保留兼容性；不作为竞品报告应用的恢复或替代路线。

# 达摩盘指定商品数据

适用于指定商品的经营指标、逐日推广数值和成长阶段。入口为 `dmp catalog → dmp items（需要选锚点时）→ dmp report → 覆盖核对`。这是只读取数能力；商品选择、竞品关系判断、分析和经营建议由调用者负责。

## 使用入口

可以直接向当前 Agent 提供以下任务；查询推广时需提供本店锚点，尚未选择时先让 Agent 列出本店商品。

> 用 tbcli 获取商品【商品ID】最近30天的达摩盘成交与点击数据。

> 用 tbcli 列出达摩盘本店商品，供我选择推广查询的锚点。

> 用 tbcli 获取商品【商品ID】在【开始日期】至【结束日期】的经营与推广数据，本店锚点是【锚点ID】。

## 主流程与参数

1. 先运行 `tbcli dmp catalog --json`，核对当前版本的字段、入参和已验证范围。
2. 仅成交、笔单价和点击：使用 `--modules metrics`，无需锚点。推广或全部模块：由调用者明确选择 `--anchor-id`。可用 `dmp items` 分页发现本店候选及其类目。优先匹配业务上相同类目；跨类目覆盖未经完整验证，最终以服务返回为准。本店商品列表的一页及其 `gmv` 字段不能证明全店30天销量排行。
3. 日期成对传入，或使用 `--days N`；缺省为上海时区截至昨天的30个完整自然日。保持用户选择的日期，不能因空数据自动改期。命令允许1–366天，是客户端操作上限，平台的真实保留范围仍需响应验证。
4. 选择新的 `.json` 输出路径，运行取数。`--item-id` 与 `--item-ids` 二选一；批量支持最多20个不同 ID，逐商品、逐模块串行采集。
5. 核对 `period`、`anchorId`、`account` 以及每个商品的模块状态、推广日期覆盖和经营指标的 `rangeDesc/periodMatches`。完整结果才使用跨模块推导；部分结果交付已有模块并列明缺口。

```bash
tbcli dmp catalog --json
tbcli dmp items --page 1 --page-size 20 --json
tbcli dmp report --item-id <ID> --modules metrics --days 30 --out <NEW.json> --json
tbcli dmp report --item-ids <ID1,ID2> --anchor-id <OWNED_ID> \
  --start-date <YYYY-MM-DD> --end-date <YYYY-MM-DD> --out <NEW.json> --json
tbcli dmp report --item-id <ID> --anchor-id <OWNED_ID> --modules costs \
  --days 7 --out <NEW.json> --json
```

`dmp items` 仅返回指定一页：`--page` 默认1，`--page-size` 默认20、上限100；结合 `pager` 决定后续页，不默认遍历全部商品。`catalog` 为本地合同，无需登录；`items/report` 使用 tbcli 的登录检查及当前达摩盘身份。会话参数沿用主 Skill 的 `--session-mode`、`--cdp-url`、`--profile-dir`、`--chrome-path`。`--timeout-ms` 为每次请求超时，默认30000、范围1000–120000。共享请求延迟默认1000–2000毫秒，沿用 `--min-delay-ms/--max-delay-ms`。每次请求及等待前后检查验证状态。

## 结果与解释

文件为 `schemaVersion: 1`，含请求日期、锚点、账户、采集时间、各商品的 `costs/metrics/computed`。每个模块的 `source` 保存 HTTP 状态、脱敏原始响应和时间；报告模块的 `source.request` 记录无凭证的业务查询参数和请求体。响应没有回显目标ID，商品归属证据是该次请求的筛选条件。原始业务字段和成长阶段的 `actionText` 保留。

- 模块 `complete`：当前合同所需字段和日期覆盖均通过；不等于经济口径已独立核实。
- `partial`：有返回但日期、字段或范围不完整。
- `empty`：业务成功返回空列表。
- `unavailable`：空对象、业务失败、权限不足、非 JSON 或结构变化；查看 `error` 与原始 `info`。
- `not-requested`：本次未选择的模块。
- 总状态 `stopped`：登录、验证码、访问限制、连接或执行异常终止。已成功模块保留，下一商品不会继续请求。

`costs.daily` 中保留五类原值及其合计、日期和归一化 `gmv`；归一化 GMV 不能当成人民币成交额。只有完整日期且五类值均有效时，`costs.totals` 才给出总计。`observedTotals` 仅是已返回的有效数值小计，必须连同覆盖缺口使用。空缺、空字符串、不可解析值保留未知，不能补零。真实0值保留0。

五个字段原名为“消耗占比”。所提供取数方法将它们解释为人民币元，但独立账单和官方计费口径尚未交叉核验。因此 `unit: unverified`、`assumedUnit: CNY`，含花费的推导位于 `computed.assumingCostsAreCny`，不能直接称为精确实际花费。某些日值重复或等于固定数也不能自行认定为预算、上限或实际账单。

`metrics.values` 包括成交笔数、笔单价、IPV、推广点击和自然点击。IPV为详情页访问次数，非去重访客人数。`estimatedGmv` 用完整精度的成交笔数×笔单价计算，再保留两位小数；`transactionsPerIpvPercent` 为成交笔数/IPV，属于计算值；不能直接替代平台的去重访客支付转化率。综合CPC用五类推广值合计/推广点击，数值单位建立在人民币假设上；分母为0时输出null。

CLI 退出码：0=合同完整成功；2=有用但不完整的报告；1=执行停止或参数/输出错误。退出码2后仍读取并交付成功模块。输出文件独占新建、权限0600；每完成一个模块保存检查点。恢复时选择新的输出文件，仅重查缺失目标/模块；没有自动重试或自动续跑参数。

## 失败分支与返回点

- `DMP_AUTH_REQUIRED` / `TAOBAO_VERIFICATION_REQUIRED`：停止全部请求，保持同一浏览器会话，由用户完成达摩盘登录或验证，再回到主流程第3步。不自动刷新或绕过验证。
- `DMP_PERMISSION_DENIED`：保留权限证据；推广需要当前商家有权查询的锚点，经营模块可以独立读取。由调用者选择有效锚点后回到第3步。
- `DMP_EMPTY_RESPONSE` / `DMP_PROVIDER_FAILURE` / `DMP_REQUEST_TIMEOUT`：本模块未知，读取其他独立模块；无自动重试。需要再查时使用新的输出文件，日期和目标保持明确。
- `DMP_SCHEMA_CHANGED`：保留已取得证据并报告不兼容；维护 CLI 解析合同后再回到第1步，普通运行不改代码或自行补造字段。
- `OUTPUT_EXISTS`：保留原文件，换新路径后回到第4步。

## 开发参考：实际请求合同

下述合同来自所提供方法和平台只读实测，维护者可据此开发；普通 Agent 通过 CLI 调用，不自行重放请求。主机：`dmp.taobao.com`（登录身份）、`dmp.advgateway.taobao.com`（业务数据）。Cookie 和 CSRF 仅驻留 Chrome 内存，不作为 CLI 入参、文件、日志或错误内容。

### 通用鉴权与锚点发现

| 步骤 | 方法与路径 | 查询参数 | 返回 |
|---|---|---|---|
| DMP 身份 | GET `/api_2/login/loginuserinfo` | `bizCode=dmp`, `_tb_token_` | `data.csrfId`, `data.loginUser.nickname` |
| 本店商品 | GET `/api/goods/item/list` | 通用鉴权、`page`, `pageSize` | `data.list`, `data.pager` |

业务请求通用查询参数为 `bizCode=dmp`、`_tb_token_`、`_csrf` 和 `csrfId`；后两者使用登录响应的同一个 `csrfId`。CLI 只返回账户昵称和业务数据。当前实现保留已验证的双 CSRF 参数组合，未做删除鉴权参数的绕过测试。

### 推广路径明细

GET `/api/goods/grow/define/line/data`。

| 参数 | 类型 | 含义与证据 |
|---|---|---|
| `itemId` | 数字字符串 | 本店锚点；省略提示“当前宝贝ID不能为空”；其他商家锚点曾返回无权查询 |
| `successItemId` | 数字字符串 | 一个目标商品；CLI批量逐个请求，不传ID数组 |
| `startDate` | YYYY-MM-DD | 包含开始日；省略提示“开始日期不能为空” |
| `endDate` | YYYY-MM-DD | 包含结束日；与开始日成对传入 |
| 通用鉴权参数 | 字符串 | 由会话自动提供 |

返回 `info.ok` 才表示业务成功；HTTP 200 本身不代表成功。`data.lineInfo` 每行含 `date`（常为yyyyMMdd）、`gmv` 和五类原字段。五类映射：`关键词推广消耗占比 → keyword`、`货品全站推消耗占比 → wholeSite`、`人群推广消耗占比 → audience`、`内容运营消耗占比 → content`、`线索推广消耗占比 → leads`。`data.stages` 包括 `title/rangeTime/stage/metricText/actionText`，不丢弃动作明细。

前端映射：货品 → 货品洞察 → 打爆路径，路由 `/items/growup-path`，自定义成功品的“成功品路径”与“路径趋势/成长阶段”；`success-cases-custom.js` 调用该接口，`success-cases-result.js` 展示趋势和阶段。前端截止日最晚昨天，日期选择下界为昨天往前90天；`startDate=endDate-30天`，闭区间可能是31天。这是前端规则，不能推断接口一定支持全部日期。CLI没有调用设置成功品的POST，也不打开会自动写入成功品的参数化页面。页面像素和实际花费单位尚未完成视觉/账单核验。

### 经营汇总 dataset156

POST `/dataplatform/dataset/report/query.json`，`Content-Type: application/json`。顶层 JSON 包含 `datasetId:156`、`type:"INDEX_CARD"`，以及**作为JSON字符串**传入的 `conf`、`filterCondition`。

`conf` 结构：

```json
{
  "columnList": [],
  "conditionList": [{"fieldId":6794},{"fieldId":6797}],
  "indexList": [
    {"aggr":"SUM","fieldId":6986},
    {"aggr":"SUM","fieldId":6895},
    {"aggr":"SUM","fieldId":6813},
    {"aggr":"SUM","fieldId":8291},
    {"aggr":"SUM","fieldId":8290}
  ],
  "rowList": [],
  "userPageSize": 10
}
```

日期过滤对象：`id/fieldId=6794, name/expression=thedate, type=dim, dataType=date, displayType=DATE_RANGE, dataFormat=yyyyMMdd, status=1, datasetId=156, values=[开始日,结束日]`；values实际使用带横线的 YYYY-MM-DD。

商品过滤对象：`id/fieldId=6797, name=宝贝ID, expression=item_id, type=dim, dataType=number, displayType=MULTI_SELECTOR, status=1, datasetId=156, values=[目标ID字符串]`。

| fieldId | 输出键 | 含义 |
|---:|---|---|
| 6986 | transactionCount | 成交笔数 |
| 6895 | avgOrderValue | 笔单价，平台说明为成交金额/成交笔数 |
| 6813 | ipv | 所有渠道商品详情页访问次数 |
| 8291 | paidClicks | 营销推广渠道累计点击 |
| 8290 | freeClicks | 非推广渠道累计点击 |

返回 `data.INDEX_CARD.fields` 和 `values` 按位置对应；解析时通过 `fields[].id` 映射，不能假定字段顺序。`data.rangeDesc` 校验单日或区间。请求中 `aggr=SUM` 沿用已验证的服务合同；笔单价使用服务返回的比值，不能在本地把各日笔单价求和。当前仅封装上述五个指标和区间汇总，分日经营报表、任意字段发现及其他 type 未经验证。

## 验证边界与维护

2026-10-24 实测：推广7、30、31个自然日返回对应行数；经营单日及30日返回；缺锚点、缺开始日、无权锚点、空对象以及系统繁忙均有独立证据。单日推广与更早的7天推广曾返回系统繁忙，不作为硬日期限制。任意商品覆盖、跨类目规则、最早保留日、币种/计费归因与精确消耗仍待独立验证。

每次维护按请求参数、原始业务响应、日期覆盖和真实CLI输出核对。新的字段或重复失败先形成解析/请求策略测试，再更新此参考及 `dmp catalog`；本模块不承担推广策略选择或付费操作。


## 单周期竞品独立分析快照

`tbcli dmp snapshot --item-id ID --start-date YYYY-MM-DD --end-date YYYY-MM-DD --out NEW.json --json` 接受唯一目标商品，保存snapshotVersion=2、subject.mode=target-only与5个所需模块状态。应用负责四周期与自然周规划、解读及HTML。

经营表dataset156的商品筛选为6797；人群数值表dataset175的商品筛选为7460，日期7463，分组7459，指标7469/7468/7465/7464。两者已有目标ID独立筛选的保存请求证据。授权仍取决于当前商家会话及服务响应。

推广场景、目标关键词及人群区间采用已验证comparison接口：itemId为当前账户自动发现的本店商品，succItemIds为用户的目标商品。快照内部通过已认证且受节流和验证保护的items请求读取第一页，选择首个有效商品ID并在同周期三个来源间复用。executionContext保存自动选取方式和原始业务证据；subject仍只有目标商品。分析使用succItemValue/关键词succItem，不能把本店itemValue当成目标值。

当前列表未返回有效商品时，三个模块明确标记context-unavailable及DMP_OWNED_CONTEXT_UNAVAILABLE，保留经营与人群数值数据；登录、验证或访问限制立即停止。自动准备不写入平台成功品设置，不让用户额外选品，也不使用历史固定ID。
HTTP/业务失败、空结果、缺值、权限和验证保持各自状态。真正发出的请求保存脱敏request/response；每模块保存检查点。验证码或访问限制立即停止。旧snapshot v1不满足新采集合同；历史文件可由应用离线读取，不能作为新独立取数的证明。

## 商品资料

`tbcli dmp item-info --item-id ID --out NEW.json --json` 使用当前DMP店铺会话，调用 `/api/goods/item/info`。不需要本店锚点或日期。输出目标ID、名称、主图URL、商品链接和可得的店铺ID/名称/链接；严格核对响应ID，缺失保留未知。店铺标准链接仅在已返回shopId时构造并标注来源。此命令不打开商品前台、不切换普通买家账号；资料不可用时保留业务状态，不转商品前台补采。
