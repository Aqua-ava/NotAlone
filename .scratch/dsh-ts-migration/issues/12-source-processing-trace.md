# 12：查看完整来源和处理追踪

Triage: ready-for-agent
State: claimed
Type: task
Blocked by: 11
Spec: ../spec.md

## 交付行为

从资料回到原始来源、批次及失败原因，删除后引用失效，不新增无删除路径的诊断正文副本。

规格：[精简 DSH 与 TS 后端迁移](../spec.md)。前置任务：[11](../issues/11-memory-adjudication-adoption.md)。

## 验收条件

- [ ] 完成本票下方 DSH 查证要求，记录版本、官方文档／源码／示例依据与适配理由；无直接接口时记录边界核对结论，未查证不得宣称完成。
- [ ] 用户可从记忆或处理任务回到实际原始来源、规范消息、批次、提取／核验／裁决记录和失败原因。
- [ ] 过程记录的正文留存遵循现有授权与删除路径，不把模型调用最小台账误当完整过程记录或额外永久日志。
- [ ] 跨联系人访问、失效来源、部分删除及正在处理时查询均正确拒绝或标注，不伪造证据。
- [ ] 删除原始资料、过程或联系人后对应引用和恢复副本按范围清理，诊断默认脱敏且不自动上传。

## 验证

通过资料／追踪业务入口验证来源导航、过程和最小台账的不同留存、错误及删除。 优先经已确认的 HTTP／事件业务入口和桌面控制器检查持久状态及用户可见结果，必要时补充模型／任务接口与宿主生命周期检查，不依赖框架私有内部结构。

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

实现候选已完成，等待根集成与实际 App／微信验收，票保持 `claimed`。

- `backend-ts/src/source-processing-trace.ts`：新增 PostgreSQL 追踪读取与有界删除业务模块。可按记忆、规范消息或处理任务反查提取批次；详情连接实际来源、规范消息、来源处理批次、全部提取／核验／裁决事件、失败阶段、写入回执、auto／manual 采纳方式和来源版本。`process_record` 明确标为含正文资料，`model_ledger` 只含调用用途、状态、用量和成本等非正文元数据。
- `backend-ts/src/source-processing-trace-http.ts`：新增独立路由适配器，覆盖记忆追踪、来源处理追踪、记录反查、任务导航、脱敏诊断和确认后删除；不启动模型、不读取请求正文。
- `backend-ts/src/memory-mutations-erasure.ts`：来源删除探测扩展到旧 `window` 事件的全部目标、上下文消息和来源快照，修复仅依赖 `trace_dependency`／输入 link 时漏清旧正文的路径。
- 所有查询先核验联系人，再按 `owner_id + contact_id` 过滤；跨联系人、失效来源、来源处理中删除统一拒绝。正在提取的批次返回 `processing_state=in_progress` 与 `completeness=partial`，失败详情保留稳定的 `failure_stage`／`error_code`，不伪造完成。
- 来源处理及追踪删除复用既有可恢复记录清理路径；来源处理删除先写无正文 capture tombstone，再清 payload、定位和受影响追踪正文；手动删追踪保留权威记忆及无正文调用／关联。联系人删除后由 FK 与联系人存在性检查阻止旧引用复活。
- 诊断接口只返回计数、状态、失败分类和删除分类，不回传消息、来源文件名、定位或事件载荷，也不联网上传。

### DSH 锁定与核对

- 产品依赖固定 `@deepseek-ai/dsh 0.2.1-rc.2`；官方 tag `dsh-v0.2.1-rc.2` 解析为 commit `687f282e8625c6b8d11ff58211a90524be2e4317`。
- 固定 commit 的 [LLM README](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/llm/llm/README.md#L47) 与 [LLM 源码](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/llm/llm/src/index.ts#L956) 证明 `prepareCall()` 捕获具体 adapter 代次、冻结配置且 prepared call 只能 dispatch 一次；框架不会自动重跑请求。完整追踪仍须由宿主在真实物理调用边界保存最终请求／返回和最小台账，DSH session 不能替代。
- 固定 commit 的 [AgentHandle](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/agent/src/index.ts#L147) 说明 `dispose()` 会停止并排空 loop、撤销 session/world；[Cordis effect 教程](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/docs/cordis-tutorial/02-lifecycle-and-effects.zh.md#L5) 要求外部资源返回 disposer，`fiber.dispose()` 等待异步清理。本票查询／删除模块没有 Agent 或 DSH session，宿主接入只复用现有共享 PG pool；停止接收后仍须按现有顺序排空模型调用和数据库资源。
- 本票的 owner/contact 隔离、PG 查询、脱敏、删除和台账分层均为确定性业务，不调用 DSH 私有 API，也不新增插件、Provider、Tool 或外部发送能力。

### 验证与边界

- 单文件合成 PG：2/2 通过，覆盖记忆／任务／消息反查、E/V/A 最小台账、auto／manual、运行中与失败状态、跨联系人拒绝、失效来源拒绝、追踪删除、来源处理删除、旧窗口来源删除、联系人删除及诊断脱敏。
- 相关模块、类型检查和公开扫描结果见[实现证据](../task12-implementation/evidence.md)。
- 尚未修改共享 `host-plugin.ts`；精确接线补丁见[根集成说明](../task12-implementation/root-integration.md)。未运行实际 App／微信、真实资料、真实模型或网络 embedding，未 push／PR／打包。
- 现有 Python 生产入口仍负责完整追踪写入与水位尾部提交；本票交付的是 TS 查询／删除纵切和可接入候选。根集成、真实 DSH 调用链以及实际 App 验收完成前不得标为 `resolved`。
