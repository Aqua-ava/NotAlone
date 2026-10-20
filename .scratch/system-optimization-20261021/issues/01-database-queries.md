# 数据库分页与进度查询

Triage: ready-for-agent
State: open
Blocked by: None

## 来源

[统一规格](../spec.md)、统一规格中的两份审计报告及合成复现脚本。

## 职责边界

消息分页两个匹配索引、记忆进度N+1读取；先确认当前main仍有热点。职责为backend/persistence、memory处理进度服务和新增迁移/对应测试，不修改desktop及server/app.py。

## 完成条件

完整SQL前后结果同序相等；NULL/同时间/引用/跨联系人隔离；保留旧索引、报告额外存储/WAL/新导入及重复导入代价；进度查询批量化保留每项来源拒绝、排序、limit和删除语义，先证明查询数减少，再量化PG真实耗时。

必须先核当前main、读对应架构与仓库工程规范；先复现再实现，完成目标而非只写计划。每个聊天开始先调用create_goal，不设预算；本issue改claimed，实际完成并写Answer后改resolved。结果写本目录../01-database-queries-result.md。不直接修改共享root产品代码，不push、不打包、不迁移业务库、不发外部消息。

## Comments

