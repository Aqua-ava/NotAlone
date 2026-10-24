# 14：更新 L3 画像与关系概览

Triage: ready-for-agent
State: claimed
Type: task
Blocked by: 13
Spec: ../spec.md

## 交付行为

使用合格场景与记忆生成有据版本，保留本人／联系人隔离、手工修正、时效和删除。

规格：[精简 DSH 与 TS 后端迁移](../spec.md)。前置任务：[13](../issues/13-l2-scenario-organization.md)。

## 验收条件

- [ ] 完成本票下方 DSH 查证要求，记录版本、官方文档／源码／示例依据与适配理由；无直接接口时记录边界核对结论，未查证不得宣称完成。
- [ ] 从合格记忆与有变化场景增量更新 L3 画像及关系概览，无需更新时按原规则跳过。
- [ ] 本人和联系人范围隔离，保留来源、版本、不确定性、时间资格和合法推断，不把行为建议写成关系事实。
- [ ] 用户可查看、修正及删除；来源失效、人工修改或输入变化时，旧摘要、缓存及晚结果不能覆盖当前状态。
- [ ] 回复和 Skill 审核读取的 L2 目录／L3 条目与实际发布 generation 一致，预算、取消和任务恢复保持。

## 验证

从整理任务到画像／概览查询及回复读取验证增量更新、generation、范围和来源失效。 优先经已确认的 HTTP／事件业务入口和桌面控制器检查持久状态及用户可见结果，必要时补充模型／任务接口与宿主生命周期检查，不依赖框架私有内部结构。

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

2026-10-25：代码与合成验证完成，本地实现提交 `3e9ec5abe947599c06c02cc22447148583bfb950`；`State` 保持 `claimed`，等待根线程完成实际 App／微信及真实模型验收后再改为 `resolved`。

### DSH 查证

- 锁定版本：`@deepseek-ai/dsh@0.2.1-rc.2`，commit `687f282e8625c6b8d11ff58211a90524be2e4317`；核对的是该 commit 的官方源码树，不以可变 master 为依据。
- 官方依据：`docs/user/develop/basic/tool.zh.md:13`（`defineTool`）、`:36`（参数、执行与渲染契约）；`docs/tool-execution-pipeline.zh.md:8`（工具调用流水线）；`packages/core/tools/src/index.ts:1071`（工具注册）、`:1144`（执行守卫）；`packages/llm/llm/README.md:34`、`:63`、`:93`（单次 provider attempt、`prepareCall`、终止 chunk）；`apps/cli/src/profile-boot.ts:283`（官方 profile 启动与清理边界）。
- 核验结论与适配：L3 使用公开的 `defineTool` 定义只读场景、暂存 `profile.md` 与独立核验工具；文档执行、范围、轮次、预算、核验、发布、取消均由业务代码控制。模型只提交工具调用，不能直接写数据库、文件系统或发送消息。未发现需要修改 DSH 私有 API 或核心的缺口，因此未改动框架源码。

### 已实现

- 新增 L3 内存工作区、逐条结构／版本／时间／不确定性／行动建议校验、独立忠实度核验、增量保留、纠错正文隔离及短事务发布。
- L3 与 L2 在同一 Worker 租约内衔接：L2 发布后继续 L3；已有成功 L2 回执时只补 L3，不重新生成场景。无变化时复用同一画像版本，不调用模型。
- 画像版本、场景版本集合和 `organization_generation` 原子推进；generation 场景缺失、重复、跨范围、清单或底层 revision 变化时失败关闭，不投影部分目录。部分旧场景失效时不用覆盖失效集合的旧画像做增量基准，改从当前有效集合重建。
- 本人与联系人按 `owner_id + contact_id` 隔离；回复上下文及 Skill 审核导航复用同一冻结 generation、revision 和依赖摘要。画像可查看、总结纠错、撤回和删除，来源失效会物理清除 L3 批次并令旧快照失效。
- 用户纠错撤下当前画像并保护完整实际输入窗口；纠错正文只作为最小错误对照进入后续提案和核验，不能再由其他来源换入发布。
- 多轮文档调用改为每次只为后续核验保留一个额度；提案与核验输入都在物理调用前执行字符预算检查。L2／L3 共享累计 job 预算，取消与显式重试仍有界。

变更文件：

- 新增：`backend-ts/src/l3-profile-workspace.ts`、`backend-ts/src/l3-profile-service.ts`
- 接入：`backend-ts/src/l2-scenario-service.ts`、`backend-ts/src/l2-scenario-http.ts`、`backend-ts/src/l2-scenario-source-validation.ts`、`backend-ts/src/host-reply.ts`、`backend-ts/src/host-model-accounting.ts`
- 桌面：`desktop/src/renderer/LayeredMemorySections.tsx`
- 测试：`backend-ts/test/l3-profile-workspace.test.mjs`、`backend-ts/test/l3-profile-service.test.mjs`、`backend-ts/test/l2-scenario-http.test.mjs`、`backend-ts/test/l2-scenario-service.test.mjs`、`backend-ts/test/l2-scenario-shared-host.test.mjs`、`backend-ts/test/host-model-accounting.test.mjs`
- 桌面测试：`desktop/tests/layered-memory/react.test.mjs`、`desktop/tests/memory-ui-wiring.test.mjs`

### 验证结果

- `node node_modules/typescript/bin/tsc --noEmit`：通过。
- L3 工作区、服务、公开 HTTP：`25/25` 通过，覆盖增量／无变化跳过、generation 精确闭合、部分旧场景失效后重建、亚毫秒时间资格、核验输入预算、多轮工具历史压缩、本人／联系人隔离、纠错、撤回、来源物理删除、晚结果、取消重试、仅剩两次额度及 HTTP 错误映射。
- L2 服务、Worker、宿主及模型记账：`25/25` 通过，覆盖 L2→L3 同租约、成功 L2 回执只补 L3、Worker 完成后收口、共享预算和 pending 幂等。
- 共享官方 DSH profile、分层回复读取、Skill 来源导航：`26/26` 通过（`9/9`、`17/17`），覆盖 6 次真实合成模型请求的 L2→L3、公开撤回、回复／审核来源的当前 generation 核验与冻结快照失效。
- 桌面类型检查通过；长期背景可见、引用、逐条修正／删除和整份撤回入口专项用例 `7/7` 通过。
- 后端全量回归：`1184` 项中 `1181` 通过；3 个失败均不在本票变更路径。`exploration-store` 与 `foreground-location-api` 单例复跑通过，`sync-incremental-reconnect` 的清理断言在共享工作树中仍失败，已作为剩余风险保留。
- `git diff --check`：通过。

### 数据与遗留

- 自动化只使用测试临时 PostgreSQL 与合成模型／来源；测试 fixture 自动销毁数据库，无真实消息发送或外部资料扩大。
- 正式数据库仅做只读状态核对，未写入画像、任务或验收结果。当前等待根线程复用已运行的 `npm run dev` 实例，从正式范围的有效性检查出发完成实际 App／微信恢复、画像查看／纠错／撤回和真实模型质量验收；不得用测试库结果代替。全量回归中的既有清理失败也须在最终验收前复查。
- 未执行打包、推送、远端分支、PR、外部消息或 DSH 核心修改。

### 真实验收阻塞诊断

- 现场：owner `6b0faa77-8bcf-4a14-a627-7629265624da`、task `0c5b9add-5006-4cfe-aef3-4c964b5d22ce`、job revision `13`、model calls `31/208`、`run_remaining=1`。唯一 profile batch 的 20 项输入与 59,328 字节 payload 已冻结，`output_payload=null`；4 个新增 receipt 全部成功，最后一次请求序列化 134,298 字节，随后在第五轮物理调用前触发 `l3_profile_context_budget_exceeded`。因此失败发生在多轮提案历史累积，不在核验、重试或初始输入。
- 修复：达到既有 `max_characters` 时保留初始任务消息和当前 `profile.md`，移除已执行且可由工作区重建的旧 tool-call 参数，只携带最后一次工具名称／错误；未提高或取消预算。先在快速回归中稳定复现同一错误，再通过 workspace 与合成 PostgreSQL 发布用例。
- 可重新 continue 的前置条件：当前 dev runtime 已加载本修复；正式 state 仍为 settings generation `0`、job revision `13`、job failed，且当前目标 key／资料集合未变化。根线程使用 revision `13` 发起 continue 后应得到 revision `14`、state active、step pending；新一轮模型调用上限会按既有合同增加 `16` 到 `224`。
