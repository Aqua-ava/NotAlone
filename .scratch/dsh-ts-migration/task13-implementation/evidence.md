# 票 13 实现与验证证据

日期：2026-10-25

## 启动与隔离

- 主树启动 HEAD：`889c38a6a609fed91a1ba21478ea6588c70513ac`。
- 独立 worktree：`/private/tmp/notalone-task13.K71Wq4/NotAlone`，分支 `codex/task13-l2-scenarios`。
- 未写主工作树，未启动 App/微信，未处理真实资料，未调用真实模型或网络 embedding。所有 PG、provider、路径、联系人和正文均为随机合成。

## DSH 版本与官方核验

- 固定版本：`@deepseek-ai/dsh* 0.2.1-rc.2`；本地干净 checkout 为官方 tag `dsh-v0.2.1-rc.2` / commit `687f282e8625c6b8d11ff58211a90524be2e4317`。
- [Tool 教程](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/docs/user/develop/basic/tool.zh.md#L13) 说明 `defineTool` 参数校验、`output.schema` 与 render；[执行流水线](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/docs/tool-execution-pipeline.zh.md#L8) 区分 pre-execute、单调 guard 和正式结果。
- 锁定 [`packages/core/tools/src/index.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/tools/src/index.ts#L1071) 的 `register()`，以及 [同上 L1105/L1144](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/tools/src/index.ts#L1105) 的 scope restriction/guard。源码 SHA-256：`398bcdeb221e450d088510830b77d99a513e65ab31e40ade71688a19cdf5e6aa`。
- 锁定 [`packages/llm/llm/README.md`](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/llm/llm/README.md#L63) 的 `prepareCall()` 捕获适配器代次、单次 stream 和“服务不自行重跑请求”（L84/L93）。
- 锁定 [`packages/core/agent/README.md`](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/agent/README.md#L32) 的 Agent handle/dispose 边界。本票没有启动 Agent，因此不存在待排空 Agent/session；LLM 物理轮次仍由本票宿主逐次许可和记账。
- SHA-256：`agent/src/index.ts` `218b30227cdc55d4c193112495a852507d12070028572ac95e6f9d1f954d1077`，`llm/README.md` `9cc8f2c8d30f9ba44afb8d14f3bbf5f31fbdfb01f950a51a49a1322e2a841049`。

适配理由：确定性业务循环保留轮次、工具分发和发布控制，DSH 提供固定版本的官方 LLM/Tool 公开契约，不把正式版本提交交给框架私有状态。工具 schema 由 `defineTool` 创建；模型响应中的工具名再经业务白名单和参数 schema 分发，不存在 Shell、通用文件、MCP 或发送 Tool。

## 交付切片

- `backend-ts/src/l2-scenario-workspace.ts`：内存 Markdown 工作区、三工具限制、先读后改、唯一替换、场景/段落/来源结构校验和逐字核验。
- `backend-ts/src/l2-scenario-service.ts`：冻结 eligible L1、持久 batch、最终事务复验、版本/映射/generation 发布、读取、段落反馈、段落安全撤回和场景撤回。
- `backend-ts/src/l2-scenario-model.ts`：每次物理模型轮次的官方 `prepareCall`/stream、后台 permit、预约和终态 receipt。
- `backend-ts/src/l2-scenario-host.ts`：独立宿主候选；当时共享主宿主未改，后续共享接线见下节。
- `backend-ts/test/l2-scenario-workspace.test.mjs`、`l2-scenario-service.test.mjs`、`l2-scenario-host.test.mjs`：纯工作区、随机 `_test` PG 和真实官方 profile/ModelPermit 合成纵切。
- 最终自审补强了多旧主题合并、完整旧输入窗口保护、`erased_guard` 续用、陈旧失败隔离、明确预约拒绝后的 permit 释放，以及场景/段落撤回时的既有回复副本清理。

## 业务合同

- 仅 active、latest、时间有效、来源合法的 `manual_entry`/`source_supported` 记忆进入输入；owner 为 `contact_id=NULL` 的真实 owner scope。
- 模型只看到本批记忆、旧场景目录和当前目录内正文。写旧文档前必须读；`[DELETED]` 必须有完整替代正文；输出引用只能指向本批 memory_id+revision。
- 独立核验要求每段明确 supported，且 evidence 的 quote 必须是所引用记忆正文的逐字子串，否则不发布。
- 发布事务复验 claim lease、启用/设置世代、组织世代、correction revision、batch 状态、完整输入 manifest、旧场景完整快照/依赖和可选票 12 来源 validator。
- 停用、段落反馈、来源删除、并发 generation、模型失败、模型预算拒绝和取消均保持零新场景。陈旧 worker 的失败也不能覆盖替代批次；相同已提交工作重放不再调用模型或创建版本。
- 场景更新保留稳定 scenario_id、显式 replaces 和映射；旧版本作为只读审计保留。段落反馈删除含该段的派生版本并记录反馈；场景撤回走现有 generation 失效路径。
- 反馈 guard 覆盖模型实际看过的完整旧输入窗口及规范消息；正文擦除后仍以 `erased_guard` 排除相关 L1。段落/场景撤回在同一事务内清理既有回复副本，不新增单独清理捷径。
- 消费者缓存不以目录存在为资格：本票测试在发布后捕获分层快照，段落反馈后同一快照复验为 false。

## 数据影响与删除

- 合成输入只写随机 `_test` 数据库；测试结束普通 DROP 自有数据库并删除私有临时目录。未持久化真实聊天、截图、语音、凭据或模型请求正文。
- L2 batch 保存本批规范化记忆输入和旧场景快照；`dependency_ids` 覆盖记忆、递归来源、旧场景输入与修正 guard，供现有 PG 删除触发器物理清理。
- 场景正文按不可变版本保存；段落反馈/场景撤回让当前 generation 失效并清除依赖回复副本，重建只能使用仍合法 L1。未新增 schema 或迁移。

## 验证记录

2026-10-25，在 `backend-ts/` 使用 bundled Node `v24.22.1` 和主树只读依赖 symlink 实际运行：

- `node node_modules/typescript/bin/tsc --noEmit`：0 条诊断。
- `node --test test/l2-scenario-workspace.test.mjs test/l2-scenario-service.test.mjs`：9 项通过，0 失败；覆盖受控工具、旧主题合并、发布/回放、映射游标、完整反馈 guard、回复副本清理、撤回、停用/来源变化/并发/失败/取消和本人 NULL scope。
- `node --test test/l2-scenario-host.test.mjs`：1 项通过；官方 DSH profile 经本地回环 provider、真实 permit/accounting/PG 完成 3 次物理调用、取消和预算拒绝，终态 permit 归零且不发布过时场景。
- `node --test test/reply-context-layered.test.mjs test/memory-adoption.test.mjs test/memory-adjudication-dsh.test.mjs`：14 项通过，0 失败。
- `node --test test/*.test.mjs` 全量：1096 项中 1091 通过、5 失败。失败均在本票文件之外：`exploration-discussion-service` / `exploration-workspace-service` / `foreground-location-host` 因 worktree 未安装 desktop 的 `esbuild`；`host-reply-unconfigured` 因缺少 `discussion_skills_root`；`sync-incremental-reconnect` 的既有清理断言得到 `undefined` 而非 `ERR_ASSERTION`。本票局部、宿主和相关模块在独立运行中全部通过。

未启动 App/微信，未运行桌面页面或打包版，未调用真实模型/embedding/外部消息。

## 共享宿主接线验证

- 起点主树 `e0ba85275e90072884d6d90d592e39a99ff30856`，票13业务已集成为 `31b98736`。
- `host-reply.ts` 在同一provider/permit/accounting生命周期内只装配一次L2 host；私有run与已认证公共读/summary-error/withdraw-scenario由同一个HTTP薄桥映射。
- `SourceProcessingTraceStore` 新增同事务无正文验证入口；自动联系人/本人来源覆盖成功、未记录、处理中、快照摘要变化和跨联系人，manual只兼容当前active/revision一致的manual来源。本人记忆作为依赖时也须通过其候选、来源或消息关联当前contact。
- 官方DSH profile共享宿主测试经本地回环provider真实完成：手录来源发布、公开读取、无`memory_id`的summary-error、第二任务场景撤回、自动来源快照变化在模型调用前409、恢复后发布、错误token401、错误scope409、关闭后私有run503且permit归零。不存在范围返回404；profile summary-error请求体由旧路由原样回放。
- `tsc --noEmit` 0错误；最终相关矩阵在原40/40基础上加入旧代理请求体回放回归，通过后提交。
- Shared host未注入TS quality store时读取为`unknown`且`automatic_use_allowed=false`；注入成功、缺省和读取失败的质量投影均有合成PG回归，不继续硬编码`synthetic`。

## 未覆盖与剩余边界

- 唯一 TS Worker 已在隔离宿主接入；默认运行时、桌面控制器与页面仍未由根验收，票保持 claimed。
- 未调用真实模型、真实 embedding、微信或发布包，无法认证真实语义质量、provider 延迟、实际桌面交互和线上 DSH 生命周期。
- 隔离测试可显式注入 synthetic 资格；共享宿主缺省为 unknown 且禁止自动使用，根必须注入真实 quality 状态。
- 票 17 的整体来源删除编排和票 14 的 L3 生成仍由各自 owner 完成；本票只验证 L2 发布/失效接缝。
- 全量 5 个环境/既有失败不属于本票范围，未通过安装 desktop 依赖或修改既有夹具掩盖；本票最终提交不包含工作树临时 `node_modules` symlink。

## 唯一 Worker 与执行权验证

- 官方 DSH profile 纵切从 `queued/pending` L2 任务开始，由唯一 `ExtractionWorker` 自动领取并完成 3 次物理调用、场景发布、batch/job/task/step 收口；`attempt_count=1`、无残留 Worker 或租约。
- 第二项 L2 任务在模型响应在途时关闭宿主：`backgroundActive=0`，步骤回到 `pending`、`attempt_count=0`、`worker_id/lease_expires_at=NULL`，任务回到 `queued`，不产生成功版本或错误水位推进。
- Python 回归确认 TS 所有权下 enable/refresh 和自动维护仍会 enqueue，proposal/verifier 零调用，`run_batch()` 明确拒绝；`profile_required` 的 L2 回执不被再生成或被伪标 L3。
- 本轮 `tsc --noEmit` 0 错误；TS L2 16/16、task store/runner/control 19/19、source trace/host/shared 12/12。Python runtime/组织相关单元 47/47，管理门禁重点 2/2，质量/profile 重点 4/4；完整 `test_layered_memory_management` 37/38，唯一自然过期边界失败在基提交 `f90545aa` 同样复现。
