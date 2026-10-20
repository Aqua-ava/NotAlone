# 事件流背压与HTTP资源约束

Triage: ready-for-agent
State: open
Blocked by: None

## 来源

[统一规格](../spec.md)、统一规格中的两份审计报告及合成复现脚本。

## 职责边界

微信SessionEventStream和后端EventSubscription无界队列、慢消费者、未认证慢正文。职责为backend front_sync事件流适配、server event_bus/app HTTP入口及对应测试；不修改数据库迁移、desktop、native和助手历史分片协议。

## 完成条件

溢出不静默丢规范消息或推进可靠游标；停止/重连/补齐/去重可证明。UI状态可合并或断连后权威重读但不能用最后一条task事件代替全部任务状态。认证提前仍保留畸形长度/413/400语义，验证已认证慢读、未完成头部、SSE和退出不退化。仅本机隔离假流/HTTP服务，清理资源。

必须先核当前main、读对应架构与仓库工程规范；先复现再实现，完成目标而非只写计划。每个聊天开始先调用create_goal，不设预算；本issue改claimed，实际完成并写Answer后改resolved。结果写本目录../03-stream-http-result.md。不直接修改共享root产品代码，不push、不打包、不迁移业务库、不发外部消息。

## Comments

