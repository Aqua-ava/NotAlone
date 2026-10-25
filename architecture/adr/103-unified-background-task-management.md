# ADR-103：统一业务后台任务的查看、停止与恢复

> 状态：已采纳
> 决策日期：2026-10-25
> 局部修订：[ADR-015](015-background-task-and-memory-index-lifecycle.md)第 3 条“用户暂不提供取消入口”；[ADR-034](034-explicit-failed-task-recovery-selection.md)的原任务恢复规则继续有效。
> 实现边界：Ticket 22 的 TS 任务管理候选与 DSH profile 回归；来源删除执行仍由 Ticket 17 接管，最终切换与真实 App 验收由 Ticket 24／25 把关。

## 背景

导入与观察任务已经有统一的 `background_task`／`background_task_step`、范围租约、心跳和迟到写入复验；L2／L3 与 Skill 学习也复用同一任务身份，但分别有领域管理入口。来源删除仍由独立旧执行方处理。用户无法从统一任务列表看到全部业务类型，也没有跨类型的显式停止动作。

把 Agent 活动、DSH session、Todo、maintenance、进程内线程或 UI 按钮当成任务真相，会混淆临时运行时与可恢复业务事实；只按步骤数量计算聊天进度也会伪造处理量。

## 决策

1. PostgreSQL 的 `background_task`／`background_task_step` 仍是唯一任务真相。DSH session、Agent cancel、`whenIdle()`、`runMaintenance()`、桌面控制器缓存和进程状态都只属于临时执行或展示，不建立模型自治任务板、计划 Tool 或第二套任务表。
2. 统一列表只读同一 `owner_id` 范围；带联系人过滤时只返回该 `contact_id`，`scope=owner` 只返回 `contact_id=NULL`，不把本人任务混入联系人列表。本人停止／恢复同样携带 `scope=owner`，不能凭任务 ID 命中联系人任务。列表回读持久任务、主步骤和真实 `processed_count`／`total_count`；过期租约显示中断，不把队列、线程存在或打开页面当成成功或正在处理。
3. 每类任务只有一个执行方。迁移期矩阵为：
   - `import`、`observation`、`layered_memory`、`skill_learning`：TS 任务模式由唯一的 `ExtractionWorker` 领取固定步骤；Python 任务模式由原 TaskHost 领取，不能双运行。
   - `delete`：Ticket 17 接管前，仅由原 SourceService／删除 Worker 执行；Ticket 17 完成后按功能切换，不改由通用任务面板猜测删除语义。
   - `memory_upgrade`：已退役，只显示历史兼容状态，不创建或重新领取执行。
   - `index`、`verify` 是导入／观察任务的步骤，不是独立任务。
4. 停止是用户明确动作。服务在同一任务事务内取消未成功步骤、清空租约字段并递增 `lease_generation`；仍在执行的本地 Worker 只中止匹配的原任务。迟到 completion、checkpoint、草稿发布或删除收尾必须因原状态、范围或代次失效而拒绝。无法中断的外部模型调用不因此被宣布成功；费用和未知回执继续沿原台账／journal 语义保留。
5. 恢复必须由用户显式触发并保留原任务身份、成功步骤、来源范围、预算、回执和删除决定。导入／观察从原未成功步骤继续；Skill 只走其 receipt-aware 领域恢复；L2／L3 只走其 settings／work revision 与预算领域动作；来源删除由 Ticket 17 的来源入口重试。`model_call_outcome_unknown` 不得由通用恢复清零或盲重放。
6. 列表读取不唤醒 Worker、不重排任务、不打开同步、不扩大来源。任务操作只接受固定闭集字段；联系人改名、重名、低置信度或跨范围读取都不能替代已验证的 `owner_id + contact_id`。
7. 全局 Worker 锁与范围租约仍是两层排他：前者限制迁移期唯一执行宿主的跨任务并发，后者限制同一 owner／contact 的步骤。前台模型调用继续优先于后台；停止或恢复不得移除这些限制。

## 后果

- 用户可以在同一任务面看到导入、观察、删除、Skill 学习、L2／L3 与退役升级任务的真实状态、实际处理量、错误和允许动作。
- 停止先赢得持久状态，再尽力中断执行；这保证晚结果不能提交，但不承诺外部供应商已经停止计费。
- 恢复不是“重新做一切”：各领域必须保留自己的批次回执、授权版本和预算规则。未知调用需要原恢复资格，不允许统一按钮越过。
- Ticket 17 的删除入口仍可独立推进；Ticket 22 不复制其跨域删除实现。Ticket 24 必须在切换前核验旧执行方停止、有效租约、未确认调用和唯一写入方。

## 不做

- 不新增模型可调用的任务创建、停止、重试或计划 Tool。
- 不把 DSH Agent session、Todo、maintenance 状态或前端列表当作业务成功事实。
- 不以步骤权重推算聊天处理比例，不把处理聊天数等同于生成记忆数。
- 不通过重试清零未知物理调用、累计预算、授权修订或删除决定。
