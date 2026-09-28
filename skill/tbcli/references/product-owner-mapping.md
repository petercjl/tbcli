# 商品负责人映射核对与补充

适用：用户提供或指定一份“商品 ID—运营负责人”关系，要求核对公司电商数据仓库、补充缺失关系，或明确以该来源同步当前负责人。

1. 将来源整理为 JSON 数组，或 `{ "sourceMetadata": {...}, "rows": [...] }`。每行使用 `platformProductId`、`ownerName`，可附带 `productName`、`sourceRecordId`。
2. 商品 ID 必须是纯数字；负责人必须是来源中已确认的真实姓名；一个商品 ID 在同一输入中只能出现一次。
3. 先执行：

```bash
tbcli profit owners reconcile --input <FILE.json> --shop-key <KEY> \
  --effective-from <YYYY-MM-DD> --source-revision <TEXT> --json
```

4. 报告 `matchedCount`、`missingCount`、`conflictCount`。冲突表示数据库现负责人和来源负责人不同，不自动选择任一方。
5. 用户明确要求仅补充缺失关系后执行：

```bash
tbcli profit owners import --input <FILE.json> --shop-key <KEY> \
  --effective-from <YYYY-MM-DD> --source-revision <TEXT> --json
```

6. 导入只写 `missing`：一致项不重复写，冲突项不覆盖。必须核对 `inserted`、`batch`、`verification.ok`，并再次运行 reconcile，要求 `missingCount=0`；冲突仍按原样报告。

7. 用户明确指定来源为准、要求数据库当前负责人保持一致时，执行：

```bash
tbcli profit owners sync --input <FILE.json> --shop-key <KEY> \
  --effective-from <YYYY-MM-DD> --source-revision <TEXT> --json
```

`sync` 在店铺级事务锁内补入缺失关系并对冲突建立新批准版本：旧版本早于生效日时截至前一日，同日版本则退役；历史行保留。要求返回 `verification.ok=true`、`matched` 等于有效来源行数，再次运行 reconcile 并要求 `missingCount=0` 且 `conflictCount=0`。空 ID、未分配、重复或来源中不确定的负责人不得放入同步输入。

输入文件摘要进入 `meta.master_data_batches`，新关系进入 `master.product_owner_versions`，状态为 `approved`。命令使用店铺级事务锁，重复来源文件返回既有批次，不重放成功写入。
