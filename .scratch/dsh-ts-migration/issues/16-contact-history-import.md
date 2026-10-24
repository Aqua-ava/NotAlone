# 16：导入单联系人历史

Triage: ready-for-agent
State: claimed
Type: task
Blocked by: 04, 10
Spec: ../spec.md

## 交付行为

预览、确认、规范化、来源记录、去重与记忆任务唤醒闭环；混联系人拒绝／拆分、失败重试和删除可验证。

规格：[精简 DSH 与 TS 后端迁移](../spec.md)。前置任务：[04](../issues/04-contact-context.md)、[10](../issues/10-memory-extraction-verification.md)。

## 验收条件

- [x] 完成本票下方 DSH 查证要求，记录版本、官方文档／源码／示例依据与适配理由；无直接接口时记录边界核对结论，未查证不得宣称完成。
- [ ] 已有联系人选择文件后，预览与确认仍属于单联系人；混有多联系人的资料明确拆分或拒绝，不猜测归属。
- [ ] 原始资料、规范消息、来源和导入批次分层保存，重试去重，只有确认后的数据进入后续业务。
- [ ] 导入提交唤醒既有记忆处理而不把消息同步与模型处理混成一个事务；模型不可用时保持可恢复状态。
- [ ] 损坏输入、取消、重复提交、删除和来源追溯贯通，删除使任务／索引／候选依赖失效且不重复回填。

## 验证

使用合成单联系人、混合及损坏文件验证预览确认、去重、派生唤醒与来源删除。 优先经已确认的 HTTP／事件业务入口和桌面控制器检查持久状态及用户可见结果，必要时补充模型／任务接口与宿主生命周期检查，不依赖框架私有内部结构。

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

## Answer

2026-10-25：已从 `65464802f8160082840a050e90ecd16809d3b8f9` 建立隔离分支
`codex/task16-contact-history-import` 实施；共享宿主接线仍待根集成，因此票保持 `claimed`。

- DSH 查证：锁定 `@deepseek-ai/dsh* 0.2.1-rc.2`、官方仓库 commit
  `687f282e8625c6b8d11ff58211a90524be2e4317`，核对了
  [生命周期与 effect](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/docs/cordis-tutorial/02-lifecycle-and-effects.zh.md)、
  [app-boot](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/boot/app-boot/README.zh.md)、
  [cmdline/appReady](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/boot/cmdline/README.zh.md)
  及本地锁定安装包源码。
- 适配结论：JSONL 读取、校验、规范化、PostgreSQL 事务和任务唤醒均为普通 TS 业务，
  不直接调用 DSH API，也不把 DSH 会话当业务状态。宿主只按 profile 公开生命周期装配路由：
  `appReady` 后才发布业务入口，`ctx.effect` 负责关闭服务器与存储；未修改 DSH 核心。
- 实现：新增确定性解析器、业务服务和 HTTP 适配器；只接受已确认的既有联系人，原子保存
  `source_document`、确认、规范消息、微信身份、来源引用、处理批次/回执及原导入任务。
  同 SHA 重放复用原来源/任务；不同文件稳定消息重叠、非 active 来源和多联系人/群聊/损坏
  输入在写入前或事务回滚中拒绝。事务提交后才调用注入的 `wake`，Worker 未就绪时返回
  `processing_deferred=true` 且保留 queued 任务。
- 桌面：`ImportTarget` 与桥接收窄为既有联系人，移除了 `new`/`new_contact_name` 路径；
  既有控制器对取消、轮询、迟到结果和联系人切换的测试保持通过。
- 验证：backend 类型检查通过；`history-import-api`、`extraction-task-store`、
  `contact-context`、`host-storage` 共 51/51 通过；desktop 类型检查通过，
  `import-existing-contact-target` 与 `background-task-polling` 共 10/10 通过；
  `git apply --check` 验证宿主补丁可应用。
- 数据影响：测试只使用随机 `*_test` PostgreSQL、合成 JSONL 和临时目录，每库/目录测试后
  清理；未读取真实聊天、未运行 App/微信、未调用模型、未外发、未打包、未 push。
- 根集成：应用 [宿主集成交接](16-history-import-host-integration.patch)，将
  `/api/imports/preview|commit` 从 Python 路由切到 TS，并注入唯一 ExtractionWorker 的
  `wake`；同时迁移桌面仍读取的 `/api/tasks/status|run|retry`。完整来源删除及索引/候选
  闭包仍由票 17/根统一验收；实际 HTTP、App、500k 上限与真实既有联系人未在本票验证。

2026-10-25（宿主任务适配续作）：

- 根已完成 `/api/imports` 交接；本切片没有重复添加导入路由。新增 TS
  `/api/tasks/status|run|retry`：`status` 直接按 `owner_id + contact_id + task_id`
  读取原 PostgreSQL 任务与步骤，错联系人返回 404；`run/retry` 只接受该原导入任务，
  写控制前复核来源仍为 active，失效时 409 且不调用 Worker。
- 当前 Python `TaskHost` 仍是唯一生产领取者，TS Worker 未启用。任务控制通过显式
  `PythonTaskControlGateway` 固定映射到 `/api/tasks/run|retry` 和本机
  `/internal/tasks/wake`，没有通用 URL 代理、联系人扫描或新任务创建。`retry` 继续走
  Python，因为模型可用性、固定运行配置、失败步骤恢复和来源复检仍只在 Python 内完整；
  TS 只做原身份与 active 来源预检，不能安全替代这些门禁。
- 同一 gateway 在导入事务提交后唤醒原任务。Worker/模型不可用分别保留
  `worker_unavailable`、`model_configuration_unavailable`，响应仍为
  `processing_deferred=true`；宿主关闭先拒绝新控制并排空已登记的控制回执，再停止
  增量、模型/Python 与数据库。
- 验证：backend-ts 相关 65/65 通过，覆盖真实 DSH HTTP 的同任务身份、错联系人 404、
  queued 状态、无模型 run/retry 不重排且零模型调用、来源失效冲突、导入提交后固定
  wake、关闭并发请求及删除任务状态读取；Python `test_import_task_api` 13/13 通过；
  backend-ts 与 desktop 类型检查通过。测试仅使用随机 `*_test` PostgreSQL、合成身份/
  JSONL 和临时目录，测试后清理；未运行 App/微信、未使用真实资料或模型、未外发、
  未打包、未 push。
- 未覆盖并保持 `claimed`：B 段采纳/trace/watermark/index/verify 仍不完整，本次没有
  启动第二领取者，也没有以 started/busy 伪造任务成功；完整来源删除、索引与候选失效
  仍由票 17 和根统一验收，真实 Worker 执行、实际 App/微信与真实模型质量未验证。

2026-10-25（TS Worker 宿主接线）：

- `host-reply` 在模型、提取许可、来源 trace 与采纳宿主就绪后只启动一个 TS `ExtractionWorker`；
  `host-plugin` 的导入 wake 与 `/api/tasks/run|retry` 共用该 Worker，运行时状态公开
  `ownership.tasks=typescript` 和真实 worker 状态。
- `ExtractionTaskRunner` 从原任务目标读取有界来源，执行 A、B、trace、逐消息处理回执和
  水位提交；模型失败、B 采纳失败和取消分别保留稳定错误码，只收尾一次 trace 且不推进
  失败批次水位。批次来源变更或删除仍在领取、冻结与提交门禁下拒绝。
- Python 仅在 `NOTALONE_TASK_WORKER_RUNTIME=typescript` 且提取/B 已切 TS 时停止装配
  `TaskHost`；其余配置保持原 Python 责任。
- 验证：backend-ts 类型检查及相关定向套件通过；全量 1124/1125，唯一失败的增量重连清理
  单例已在 `50306523` 基点复现。Python command/reply/route 相关 56 项通过。仅使用随机
  合成 `_test` PostgreSQL、临时目录和 loopback 模型；未操作 App/微信、真实资料或模型，
  未打包、push 或 PR。
- 未覆盖：TS Worker 当前只处理 `parse|normalize|extract_memory`，`index|verify`、来源删除
  任务、L2 `organization` 领取与完整 App 验收仍由后续票／根处理，因此本票保持 `claimed`。
