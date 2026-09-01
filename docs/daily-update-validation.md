# 日常更新 Skill 模块实现与验证

日期：2026-09-01。本轮为用户已确认方案的发布候选验证；提交与 npm 发布在本记录之后执行并通过远端回执单独确认。

## 交付与边界

- 内置于现有 `skill/tbcli`，不新增第二份独立安装 Skill；通过现有递归链接/复制安装和统一更新分发。
- 唯一表格注册表仍为 report-maintenance.md；19张表增加“日常启用”列，既有粒度/筛选保留。
- 补缺策略归 Agent/Skill，coverage/fetch/import 保持元命令；没有 all-in-one sync 命令。
- 新增4个 maintenance 技术命令：显式运行计划、本机互斥、不可覆盖事件、来源散列与覆盖回执校验、终态记录。
- 默认只补当前自然年平台可取的缺失周期；不默认重拉已有日期。跨年未完成和不可取缺口需单独披露。
- 同机同用户同状态目录互斥，不是跨机器锁。旧进程终止需人工确认，绝不按锁年龄自动抢占。
- 文档采用 portable-skill-creator 组合当前基础 skill-creator；知识为 hybrid，来源 partial；宿主适配声明 implemented，不把静态契约当 Windows/SealSeek 实测。

## 已执行验证

- `npm test`：155项通过，无失败。
- 新增8项测试：计划/状态只读、并发和所有权、阶段/散列/覆盖门槛、无变化跳过、存储路径保护、真实CLI入口、19表注册表、托管安装和旧副本更新。
- Skill 基础格式校验通过。
- internal 可移植性扫描：0 errors / 0 warnings。
- hybrid 知识导航校验：0 errors / 0 warnings。
- 能力契约和适配缺口检查：0 errors / 0 warnings；不等同于生产运行成功。
- npm pack dry-run：包含全部15个Skill文件和新元命令；未包含凭证或运行状态；未执行发布。
- 当前 Codex 托管链接指向插件唯一源，状态 current。测试只使用临时目录/模拟回执，无生产数据库操作。
- Codex/macOS 真实 main-run 已处理清单全部19张启用表：逐表实时目录与覆盖检查、非空 Excel 身份/字段/日期 QA、缺失范围原子导入及整表 coverage 回执全部完成；平台尚未出齐的日期按 partial 披露。
- 网络中断后的恢复验证通过：新运行重查覆盖，只补仍缺片段，没有重写已完整范围。

## 未执行与下一步

- main-run-pass：Codex/macOS 真实维护链路已完成；静态测试不再是唯一证据。
- clean-regression-not-run：本轮未收到新的干净回归授权。
- Windows/SealSeek 新模块实跑未执行；调度器和外发通知未配置；备份恢复未验证。
- 发布后仍需在 Windows/SealSeek 上验证相同日常模块；跨机器互斥和数据库备份恢复不属于本版本已验证能力。
