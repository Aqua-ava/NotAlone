# 16：导入单联系人历史

Triage: ready-for-agent
State: resolved
Type: task
Blocked by: 04, 10
Spec: ../spec.md

## 交付行为

预览、确认、规范化、来源记录、去重与记忆任务唤醒闭环；混联系人拒绝／拆分、失败重试和删除可验证。

规格：[精简 DSH 与 TS 后端迁移](../spec.md)。前置任务：[04](../issues/04-contact-context.md)、[10](../issues/10-memory-extraction-verification.md)。

## 验收条件

- [x] 完成本票下方 DSH 查证要求，记录版本、官方文档／源码／示例依据与适配理由；无直接接口时记录边界核对结论，未查证不得宣称完成。
- [x] 已有联系人选择文件后，预览与确认仍属于单联系人；混有多联系人的资料明确拆分或拒绝，不猜测归属。
- [x] 原始资料、规范消息、来源和导入批次分层保存，重试去重，只有确认后的数据进入后续业务。
- [x] 导入提交唤醒既有记忆处理而不把消息同步与模型处理混成一个事务；模型不可用时保持可恢复状态。
- [x] 损坏输入、取消、重复提交、删除和来源追溯贯通，删除使任务／索引／候选依赖失效且不重复回填。

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

2026-10-25（根主线集成复核）：

- 已把隔离提交 `f90545aa` 无冲突合入主树，主线提交为 `21564070`；用户原有三处未提交
  桌面夹具修改未暂存、未覆盖。
- 主树重新通过 backend-ts 严格类型检查；真实宿主、唯一 Worker、A/B、trace、处理回执、
  水位失败/取消、导入和任务接口共 19 项通过；导入/任务/Gateway/任务存储 29 项通过；
  Python 任务运行与 TS Worker 门禁 23 项通过。
- 只读核对真实开发库：`ran` 的原观察任务仍为同一 task UUID，`extract_memory` 和后续
  `index|verify` 均未推进；当前没有因本次集成产生重复任务、trace 或真实资料写入。
- 当前开发宿主仍由 Python 任务执行者领取存量任务，TS Worker 尚未开启；票 16 仍保持
  `claimed`，待票 13 补齐 L2 唯一领取链后，由根切换并完成 `ran` 的实际 App、资料、
  来源与水位验收。

2026-10-25（TS `index|verify` 唯一 Worker 切片）：

- 从主树 `d5cd0e677071070f595726c97994ff1e65f0e2cc` 建立独立 worktree 实施；
  未修改主工作树或主 Git index。票 16 继续保持 `claimed`。
- DSH 查证：锁定依赖为 `@deepseek-ai/dsh* 0.2.1-rc.2`。官方 release commit
  [`687f282e8625c6b8d11ff58211a90524be2e4317`](https://github.com/deepseek-ai/deepseek-harness/commit/687f282e8625c6b8d11ff58211a90524be2e4317)
  的提交说明明确为 `dsh@0.2.1-rc.2`；同 commit 的
  [`packages/bundle/sdk-minimal/package.json`](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/bundle/sdk-minimal/package.json)
  `version` 同为 `0.2.1-rc.2`。核对了同 commit 的
  [`ctx.effect` 生命周期文档](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/docs/cordis-tutorial/02-lifecycle-and-effects.zh.md)
  与 [`appReady` cmdline 文档及源码](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/boot/cmdline/README.zh.md)：
  effect disposer 随插件卸载，`appReady` 是 Loader 成功后的启动信号。本切片没有调用
  DSH 私有 API，只在既有 `host-reply` 生命周期内给原唯一 `ExtractionWorker` 注入确定性
  Runner；没有新增 Worker、计时循环、DSH 任务或持久会话。
- 实现：在原任务 `index|verify` 步骤内复用同一租约、心跳、取消和 `store.fenced`
  事务；在 `contact_memory_state` 行锁下读取 `memory_revision`，只投影当前范围、
  active、有效期内且至少一个有效来源的 `confirmed_memory`。主题按条目数降序、
  category/topic 与 memory UUID 稳定升序，最多 20 个；目录只含分类、主题提示和 UUID。
  写入前重复构建，写入后回读并再次核对 revision、主题和有效来源；失败由原事务回滚，
  旧目录保留。`verify` 保持 `index_missing|index_not_active|index_stale|
  index_reference_invalid`，数据库故障可重试。Worker 扫描、过期租约恢复与分派已覆盖
  `index|verify`，未接管删除任务族或全任务管理。
- 验证：新增 11 项随机 `_test` PostgreSQL 合同测试；组合任务 Store/Runner/Worker
  控制 30/30、导入与真实 DSH 宿主接线 28/28、backend-ts 严格类型检查均通过。覆盖空目录、
  过期及来源失效、20 主题上限、稳定排序与 revision、owner/contact/本人记忆隔离、
  写入后失败回滚、verify 连续失败与显式恢复、来源删除拒绝领取、旧租约晚到、关闭取消、
  无 wake 的过期 verify 恢复，以及同 Worker 完成 `index|verify`。提交前
  `check_public_history --ref HEAD --working-tree` 扫描 15,367 个历史 blob、
  2,275 个历史提交和 4,549 个当前文件，问题数为 0。
- 数据影响：仅创建并清理随机 `notalone_ts_host_*_test` 数据库与临时目录，使用合成
  owner/contact/source/memory；未读取真实资料或 `ran`，未启动 App/微信、未调用模型/
  embedding、未外发、未打包、未 push。真实 App/资料/来源与水位验收仍由根会话独占；
  票 17 的删除闭环、票 22 的任务管理及真实模型质量不在本切片。

2026-10-25（根签收）：

- 在全新 112 迁移 schema 上重跑导入、任务、来源处理与删除合同，Python 104/104、
  backend-ts 59/59、桌面导入/轮询 10/10 通过；backend-ts 严格类型检查通过，改动文件
  `py_compile` 与 `git diff --check` 通过。测试使用随机 `_test` 数据库和合成 JSONL，
  数据库及临时目录均在结束后清理。
- 修复根验收获证的三个回归：自动导入模型夹具补齐独立关系及关系核验协议；旧排队任务
  断言改为规格要求的“只处理本次原任务，旧队列须显式恢复”；已删除捕获在自动读取过滤
  之前即校验墓碑，避免过滤掉记录后重放被静默接受。
- 真实开发 App 的唯一 `ran` observation 任务
  `4db4510b-a7e8-450b-b8b8-cc0b3b71751e` 已完成 `extract_memory|index|verify`；
  78/78 个处理目标均有终态回执，其中 68 `succeeded`、10 `unknown`，没有把未知结果
  宣称为成功。14 条 trace 全部终止，26 次模型调用均有 ledger 与调用回执；没有待处理
  步骤、未完成调用、重复目标/回执或第二观察任务。来源处理批次为单条
  `local_wechat_observation`，78 条来源引用均指向同一观察；最终水位为
  `0ab712ff-8d6a-4f75-9024-7461df3867ee`，调度 pending 为 0。
- 该真实任务按 observation 路径执行，不伪造 `source_document` 或 import 来源；文件导入
  的分层、混联系人拒绝、幂等、唤醒、取消和删除闭包由上述隔离合同验证。最终组合 App、
  真实模型质量与发布切回仍由票 24／25 验证，不在本票扩大宣称。
