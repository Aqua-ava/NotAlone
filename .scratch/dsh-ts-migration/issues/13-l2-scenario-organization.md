# 13：整理 L2 场景

Triage: ready-for-agent
State: claimed
Type: task
Blocked by: 11
Spec: ../spec.md

## 交付行为

既有输入经受控文档工具、校验、版本保存到查看／修正／删除，工具不直接发布或访问任意文件。

规格：[精简 DSH 与 TS 后端迁移](../spec.md)。前置任务：[11](../issues/11-memory-adjudication-adoption.md)。

## 验收条件

- [ ] 完成本票下方 DSH 查证要求，记录版本、官方文档／源码／示例依据与适配理由；无直接接口时记录边界核对结论，未查证不得宣称完成。
- [ ] 合格记忆进入 L2 暂存场景，模型只用受控文档工具读写本次允许视图，不能直接提交业务版本或读任意文件。
- [ ] 完成输出、引用和输入版本校验后事务发布，可从界面查看、修正、追溯及删除场景与段落。
- [ ] 停用、手动修正、来源删除、并发版本变化及模型失败时不发布过时文档，恢复保持幂等。
- [ ] 工具和模型调用逐次受预算、取消及实际记账约束；新旧场景消费与缓存失效合同兼容。

## 验证

从任务入口到场景查询验证暂存编辑、来源与版本发布、人工修正、删除和失败恢复。 优先经已确认的 HTTP／事件业务入口和桌面控制器检查持久状态及用户可见结果，必要时补充模型／任务接口与宿主生命周期检查，不依赖框架私有内部结构。

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

票内 TS 业务纵切和共享宿主候选已完成，仍为 `claimed`；生产 Worker切换、实际 App／微信和桌面页面验收尚未完成，不能标为 `resolved`。

- DSH 固定为 `0.2.1-rc.2`、tag `dsh-v0.2.1-rc.2`、commit `687f282e8625c6b8d11ff58211a90524be2e4317`。依据锁定 [Tool 教程](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/docs/user/develop/basic/tool.zh.md#L13)、[执行流水线](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/docs/tool-execution-pipeline.zh.md#L8)、`defineTool` 注册/限制/guard 源码和 `prepareCall()`/单次 stream 说明。业务代码保留轮次、分发、取消和发布权；模型只获 `read/write/edit`，没有文件系统、Shell、MCP、发送或新 Tool 注册能力。
- 已实现 [工作区](../../../backend-ts/src/l2-scenario-workspace.ts)、[服务](../../../backend-ts/src/l2-scenario-service.ts)、[物理模型桥](../../../backend-ts/src/l2-scenario-model.ts) 和 [独立宿主候选](../../../backend-ts/src/l2-scenario-host.ts)。严格工作区支持创建、先读后改、显式完整替换、多旧主题合并及逐字引用核验；服务在最终事务复验 claim/settings/organization/correction/batch/输入/旧场景完整快照后发布，并支持查看、段落反馈、安全段落撤回、场景撤回和映射分页。
- 反馈 guard 覆盖完整旧输入窗口和规范消息；回复正文擦除后仍以 `erased_guard` 排除 L1。段落/场景撤回在同一事务清除依赖回复副本并使冻结快照失效。来源记录按 `owner_id + contact_id` 隔离，`contact_id=NULL` 的本人范围也走完整纵切。
- 独立合成宿主已从官方 DSH profile 经本地回环 provider、真实 ModelPermit/accounting/PG 跑通发布、取消和预算拒绝。共享接线现已在隔离分支接入 `host-reply.ts`/`host-plugin.ts`，参数、source validator、HTTP薄桥和唯一 Worker 边界记录在 [root-integration.md](../task13-implementation/root-integration.md)；生产 Worker未切换。
- 数据影响：合成 PG 只写随机 `_test` 库和合成正文；未持久化真实聊天、截图、语音或凭据。L2 批次保存本批输入、旧场景修订和精确 `dependency_ids`；场景正文不可变版本化。未新增 schema/迁移。票 12 `SourceProcessingTraceStore` fail-closed validator 仍需根线程传入 `validateSources(client, work)`，本票不复制 trace 正文。
- 验证：`tsc --noEmit` 0 错误；工作区/服务 9 通过；独立宿主 1 通过；相关既有模块 14 通过。全量 `test/*.test.mjs` 为 1096 项、1091 通过、5 失败；失败均在本票外（desktop `esbuild` 缺失 3 项、缺 `discussion_skills_root` 1 项、既有 sync 清理断言 1 项），票内与相关模块独立运行全绿。详见 [evidence.md](../task13-implementation/evidence.md)。
- 清理：所有测试临时 PG/目录自行回收，提交前删除 `backend-ts/node_modules` 临时 symlink；未启动 App/微信、未调用真实模型/embedding/外部消息、未打包、未 push。剩余覆盖包括生产 Worker切换、实际 App/微信、真实模型质量和正式TS质量Store。
- 共享宿主候选补强（2026-10-25）：`host-reply.ts` 已在唯一 provider/permit/accounting 生命周期内创建一次 L2 host，新增私有 `POST /internal/layered-memory/run`、已认证联系人/本人读取、summary-error 与 withdraw-scenario 薄桥，并保留关闭取消和事务排空。票12 Store 新增同事务无正文复验：自动来源未记录、处理中、失败、跨联系人或不完整，以及窗口快照摘要变化均拒绝；仅当前 active/revision 一致的合法手录走 manual 兼容边界。
- 质量投影接入 `L2ScenarioQualityReader` seam；主树没有TS质量Store，所以未注入或读取失败时返回`unknown`和`automatic_use_allowed=false`，不宣称`synthetic`或开放自动使用。共享官方DSH profile测试覆盖手录发布、自动来源调用前拒绝/恢复发布、两种撤回、认证/scope边界和关闭permit归零；最终相关矩阵44/44、类型检查0错误。未切换Python Worker或默认运行时，实际App/微信验收仍由根完成。
