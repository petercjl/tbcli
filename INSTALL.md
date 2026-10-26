# @petercjl/tbcli 安装说明

发给当前使用的Agent：

> 请为当前Agent安装 @petercjl/tbcli，完成配套Skill同步并验证可用。

当前Agent识别自己的Skill目录和注册/刷新机制。包名不限制调用宿主；Node、服务账户、Python等运行前提由doctor核对。安装成功包含CLI与Skill两部分，仅npm成功仍是不完整。

Agent执行合同：先读取 `tbcli skill source --json`，用显式 `--target-dir`（Skill父目录）或 `--skill-directory`（精确目录）调用包管理入口。具名或任意合法Agent名称使用generic能力适配，不代入其他宿主目录。安装为完整实体副本，包含自有.runtime；不创建共享链接。更新先检查本地修改与所有权，保留备份，再同步选定目标，同版本仍修复缺失/陈旧副本。`skill status`必须current且SHA-256验证通过；宿主刷新发现需由当前Agent实际验证。源码工作区通过Git流程维护。

离线或更新失败保留现有安装；CLI成功而Skill失败时检查选定目标的operation状态与备份，不重复安装。自动检查只通知；安装更新须有明确授权。其他Agent的安装不在本次操作范围。
