# 竞品行为人群画像

`tbcli dmp audience --item-id ID --out NEW.json --json`：默认最近30天购买人群，依次读取性别、年龄、购买力、城市等级、大快消策略人群。

可选 `--days 7|15|30|90`；`--audience-type purchase|browse|favorite|cart|search`。每次只取一种行为。使用商家会话，可传角色会话参数；不需要本店商品或类目ID。输出必须是新JSON文件。任意ID的可用性由账号权限与平台响应决定。

POST `/api/dmp/insight/tag/chart`，JSON体。筛选标签283736，商品/行为/周期选项组303279/303280/303281；维度标签见实时 `dmp catalog` 的audience.dimensions。认证仅留浏览器内存，每次请求走共享节流和验证保护，无自动重试。登录、验证、限制、业务失败或结构改变时保存已有维度并停止。

输出 `audienceVersion=1`，itemId、audienceType、period、dimensions；各维度包含status、rows、countSum及source完整脱敏响应。rows含label、optionValue、count、platformRate及normalizedShare。status区分returned、empty和unavailable；空列表不伪造0。平台rate保留原值，normalizedShare是分类人数/返回分类之和，分母0时为null。

这是当前滚动7/15/30/90天，不接受任意起止日期，实际数据日期未回显。人数不是成交笔数；各行为重叠，不相加去重，不直接计算转化漏斗。策略标签可能一人多标，countSum不是去重人数，平台rate合计可能超过1；其normalizedShare仅是标签计数归一化占比，不替代平台覆盖率。其他维度保留未知分类并计入分母，各维度人数也不相加。

完成后返回调用方的数据核对与交付节点；应用分析和图表选择由应用Skill负责。
