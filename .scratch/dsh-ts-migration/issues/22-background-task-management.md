# 22：管理全部业务后台任务

Triage: ready-for-agent
State: resolved
Type: task
Blocked by: 10, 13, 14, 15, 20
Spec: ../spec.md

## 交付行为

任务列表、进度、停止、重试／恢复、失效租约及各任务类型闭合，确保不双领取。

规格：[精简 DSH 与 TS 后端迁移](../spec.md)。前置任务：[10](../issues/10-memory-extraction-verification.md)、[13](../issues/13-l2-scenario-organization.md)、[14](../issues/14-l3-profile-overview.md)、[15](../issues/15-skill-learning-review.md)、[20](../issues/20-history-gap-recovery.md)。

## 验收条件

- [x] 完成本票下方 DSH 查证要求，记录版本、官方文档／源码／示例依据与适配理由；无直接接口时记录边界核对结论，未查证不得宣称完成。
- [x] 按01具名任务清单接管全部业务任务，界面能看到真实状态、处理量、失败原因、停止和允许的重试／恢复。
- [x] 原子领取、租约、幂等、并发及前台优先保持；进程崩溃和租约过期不双领取、不自动宣布业务成功。
- [x] 逐一核验已迁移及剩余任务类型的 handler 和唯一执行方，不留隐蔽 Python Worker；不新增模型自治任务板或计划工具。
- [x] 停止、删除和撤销后晚结果不可提交，复用已有资料版本与删除规则，恢复不扩大授权。

## 验证

经任务管理入口检查每类任务状态与恢复，验证新旧租约和并发／删除竞争；不重复运行全量无关模型。 优先经已确认的 HTTP／事件业务入口和桌面控制器检查持久状态及用户可见结果，必要时补充模型／任务接口与宿主生命周期检查，不依赖框架私有内部结构。

## 执行前必须核对 DSH

- 先阅读本票涉及的**锁定版本** DSH 官方文档、相关源码和示例，核对现有 NotAlone 实现；不能凭印象猜 API、配置、依赖或生命周期。尚未锁定版本的01／02先记录候选版本并由02固化。
- 在本票记录版本／commit、具体来源链接或源码位置、核验结论及本次适配理由。官方说明只证明约定，仍需实际测试；不得用可变 master 文档冒充锁定版本证据。
- 优先官方插件、公开接口和已有机制；不胡乱重写框架能力、绕过官方 profile、臆造配置或擅改 DSH 核心。能力缺口须有最小复现或源码依据，影响已确认方案时先报告冲突，不自行换路线。
- 纯业务改动也先判断与 DSH 的交互和生命周期影响；确实无直接依赖时明确记录“不涉及直接接口”及依据，不为完成阅读要求无关重构。

## 工作边界

- 当前仅发布任务，尚未开始实现。执行前核对前置票的实际验收和现有代码，按已确认[规格](../spec.md)及[规划索引](../planning.md)推进，未通过前置不能开始依赖实现。
- 业务始终按 owner_id + contact_id 隔离，来源、权限、预算及删除随本票一起验证；确定性流程由业务代码控制，模型没有外部聊天发送能力。
- 新旧实现每项业务只有一个执行和写入责任方；回退先核验结构和在途任务，保留新增／编辑／删除决定，不恢复旧库或自动逐请求兜底。
- 日常开发先核验并复用 npm run dev 实例，不打包、不运行打包版；本票不授权发送外部消息或扩大真实资料范围。合成验证、真实模型及实际 App／微信证据分开记录。
- 先运行最小相关验证；仅提交本票变更的本地提交，不 push。若范围超过一上下文，先记录完整行为切片与依赖调整，不降低验收要求或任意扩大本票。

## Comments

2026-10-23：用户已认可任务拆分、依赖和验收入口并要求逐张发布；补充明确要求实施前必须看 DSH，不凭猜测乱改。任务保持 open。

2026-10-25：Ticket 10／13／14／15／20 已 resolved，开始本票实现。只新增统一任务管理候选、把停止能力接到现有唯一 Worker，并更新控制器和界面；未操作实际 App／微信、未使用真实资料、未发送外部消息。来源删除的跨域闭包继续留给 Ticket 17。

## Answer

已完成统一业务后台任务管理候选，详见[实施与 DSH 边界证据](../task22-implementation/evidence.md)和[只读合同](../task22-readonly-preparation/contract.md)。

- DSH：固定 `@deepseek-ai/dsh@0.2.1-rc.2`／commit `687f282e8625c6b8d11ff58211a90524be2e4317`。核对官方 profile、Agent create／dispose／cancel／whenIdle／runMaintenance 文档和源码后确认：DSH 不提供业务任务表、原子领取、租约、崩溃恢复或用户任务板；本票不新增直接 DSH API、模型 Task Tool、自治计划或长期 session。任务仍完全由 PostgreSQL 控制，经现有官方 profile 薄插件装配。
- 后端：新增 [`background-task-management.ts`](../../../backend-ts/src/background-task-management.ts)，提供 owner 隔离的 `/api/tasks`、`/api/tasks/stop`、`/api/tasks/recover`。列表先选最多 101 个任务再展开全部步骤，显示真实步骤计数、稳定性错误码、本人／联系人范围与允许动作；纯读取不 notify、不重排、不启动模型。`total_count=NULL` 保留为未知，不用 0 或 `message_count` 伪造。
- 停止：任务事务按 contact→owner 锁序取范围锁，取消未成功步骤、清空 `worker_id`／租约、推进 `lease_generation`；统一 Worker 只中止匹配的当前 task，不影响其他联系人或其他任务。旧 claim 的 completion／checkpoint 因租约代次和任务状态失败；外部调用未结算仍保留未知，不宣布成功。
- 恢复：导入／观察只重排原任务并保留成功步骤、来源、目标与消息身份；`model_call_outcome_unknown`、失效来源／绑定、错误动作和跨 contact／owner 均失败关闭。Skill 走 receipt-aware 领域恢复；L2／L3 走 settings generation、work revision 与累计预算入口；来源删除恢复继续由 Ticket 17 的来源面板发起，通用面板不猜测删除闭包。
- 执行责任矩阵：TS 任务模式下 `import`、`observation`、`layered_memory`、`skill_learning` 由同一个 `ExtractionWorker` 领取各自固定 Runner；Python 模式由原 TaskHost 独占，两模式互斥。`delete` 目前由 Ticket 17 接管前的原 SourceService／删除 Worker 独占；`memory_upgrade` 按 ADR-070 退役，只显示历史状态；`index`／`verify` 不是独立任务。没有新增隐蔽 Worker。
- 桌面：新增 [`BackgroundTasksPanel.tsx`](../../../desktop/src/renderer/BackgroundTasksPanel.tsx)、独立控制器／preload／bridge。面板显示类型、状态、实际处理量、步骤、重试次数和失败原因，提供停止及相应恢复入口；联系人视图读取当前联系人任务，“我”视图读取 `contact_id=NULL` 的本人任务，两类范围不混用。控制器严格校验闭集、范围 `scopeRevision` 和连接代次，切换范围、旧连接或迟到读取不能写；本人停止／恢复显式携带 `scope=owner`，不能命中联系人任务。
- 架构：新增 [ADR-103](../../../architecture/adr/103-unified-background-task-management.md)，局部修订 ADR-015 的“无用户取消入口”；同步现行 core flow 与 domain-data。
- 数据影响：没有 schema 迁移、正文读写、模型调用、授权扩大、外部发送或生产库写入。测试只用随机合成 PostgreSQL 库、合成任务和合成 HTTP 数据；任务记录仍只含元数据与业务引用。
- 验证：TS 任务管理／任务存储／控制 27/27；真实 DSH profile host HTTP 11/11；桌面任务控制器、面板、导入／删除轮询及记忆 UI 30/30；后端与桌面 TypeScript 类型检查均 0 错误。来源删除无模型五步 1/1；Python 原失败任务恢复与 Skill 已保存草稿恢复各 1/1。本人／联系人范围互斥、本人动作不能命中联系人任务已由存储、公开 HTTP、桌面控制器及记忆页接线回归覆盖。命令与边界详见证据文件。
- 清理：先前 3 个无连接的合成测试残留库已核对后删除；并发宿主测试持续创建／清理新库时未删除仍在变化的数据库。未打包、push 或 PR。
- 未覆盖：实际 App／微信验收由根会话独占，本执行方未执行，也未操作微信或实际联系人资料。根线程仍需在唯一归属实例核对真实任务面板、桌面进程重启、旧宿主退出、在途模型调用和删除竞争。L2/L3 Python 集成单例因未设置 `NOTALONE_TEST_DATABASE_URL` 未运行；其 TS Worker／L2 既有回归已通过。TS 模式下删除仍受原全局 Worker 锁与 Ticket 17 未完成影响，切换前必须由 Ticket 17／24 解决并验证，不能把本票任务管理候选当成删除执行已迁移。
