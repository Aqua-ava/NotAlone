# 事件流背压与HTTP资源约束

Triage: ready-for-agent
State: resolved
Blocked by: None

## 来源

[统一规格](../spec.md)、统一规格中的两份审计报告及合成复现脚本。

## 职责边界

微信SessionEventStream和后端EventSubscription无界队列、慢消费者、未认证慢正文。职责为backend front_sync事件流适配、server event_bus/app HTTP入口及对应测试；不修改数据库迁移、desktop、native和助手历史分片协议。

## 完成条件

溢出不静默丢规范消息或推进可靠游标；停止/重连/补齐/去重可证明。UI状态可合并或断连后权威重读但不能用最后一条task事件代替全部任务状态。认证提前仍保留畸形长度/413/400语义，验证已认证慢读、未完成头部、SSE和退出不退化。仅本机隔离假流/HTTP服务，清理资源。

必须先核当前main、读对应架构与仓库工程规范；先复现再实现，完成目标而非只写计划。每个聊天开始先调用create_goal，不设预算；本issue改claimed，实际完成并写Answer后改resolved。结果写本目录../03-stream-http-result.md。不直接修改共享root产品代码，不push、不打包、不迁移业务库、不发外部消息。

## Comments

## Answer

已在独立工作树分支 `codex/optimize-stream-http` 实现并本地提交 `98fdea55`、`317ec9d5`。CLI 256 项可取消背压、EOF 排空与消费水位重连；SSE 实时队列和每 owner 恢复提示分别限制 256 项，溢出明确断连，按 task_id 分键并通过原 HTTP 权威读取恢复；HTTP 保持长度 400/413 优先级后提前认证，增加头部/正文总截止、连接额度及活动 socket 收尾。

446 项相关合成回归通过（含临时 PostgreSQL 双联系人持久化去重），两轴独立审查无遗留发现。两轮压力实验中，10 万 CLI 事件队列 100001→256、Python 保留堆 14.70813→0.04389 MiB；慢 SSE 积压 100000→断连释放；12 个未认证半截正文请求线程 12→0。无 tracemalloc 的交错计时同时记录了健康路径小幅耗时增加，没有把堆分配当 RSS 或将超时观察当延迟。数据影响、原始数字、实际命令、清理和未覆盖行为见 [完整结果](../03-stream-http-result.md)。

本票已运行真实 PostgreSQL 临时合成库的游标与重放去重回归，未运行真实 App/微信；05 负责统一集成、默认验证入口及 dev App 验收。未 push、打包、迁移业务库、调用模型或发送外部消息。

