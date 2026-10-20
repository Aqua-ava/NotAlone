# 桌面草稿与可见性轮询

Triage: ready-for-agent
State: open
Blocked by: None

## 来源

[统一规格](../spec.md)、统一规格中的两份审计报告及合成复现脚本。

## 职责边界

草稿每键全量联系人状态与双窗口广播、MemoryPage离页仍轮询、Skill不变状态发布。职责为desktop contacts/session与bridge、memory controller/renderer/preload/共享协议、skill-learning；不修改assistant-sessions历史分片、native、backend、package.json默认测试清单。

## 完成条件

身份/删除/断连/迟到响应/切联系人及编辑草稿保持；初读/重入必须权威刷新；不能靠降低资格/失效检查频率优化。对照请求/发布次数与数据量；合并后由05做实际dev App验收。

必须先核当前main、读对应架构与仓库工程规范；先复现再实现，完成目标而非只写计划。每个聊天开始先调用create_goal，不设预算；本issue改claimed，实际完成并写Answer后改resolved。结果写本目录../02-desktop-state-result.md。不直接修改共享root产品代码，不push、不打包、不迁移业务库、不发外部消息。

## Comments

