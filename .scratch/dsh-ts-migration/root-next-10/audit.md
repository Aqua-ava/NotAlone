# 票10隔离整合审计

状态：默认可独立 Core 已整合；整票仍未完成，生产 Worker 责任未切换。审计日 2026-10-25。

## 基线与交付
- 冻结 base：`b0a6817582d92b4142977c486fe7a9366496cb88`；冻结 target：`6e3a864ca5653311957b106e16130084b5f5c12a`，应用后 tree `352716403a4c2e23a1631cd81e4721240e751142`，50/50 文件 SHA 一致。
- 冻结纵切提交 `f07d7e405f35f75f50e0e6ebdcc3c6f2ab957484`；唯一 Worker/owner 进度提交 `f8bdde0bc0a4a907230e9316751e60b2fe5bc23f`。
- 最新主树整合 base：`8ce975e83e25d30f3de2247a6261489bae177826`；整合提交：`11dbf0632723e6eeefab6d65ec095d48e8ef7e6b`，tree `3137c0b1ed0f9269db28d954e3e7a59b63205125`。
- 主树接收后的纵切：显式恢复入口 `1195aff8`、POST 正文隔离修复 `a6dd5623`、历史 bounded/nullable-proof `4c936d1e`。
- 全量可应用补丁：`task10-current-main.patch`，SHA256 `62927c03971b12fb4ae9e256eeb471cb2b2b09c00dfc838e4617f58f8341fb1e`；仅 Worker 补丁 SHA256 `a2c8487e3985302ae8f3348036be4ade69120a797f4f03f38c7ce35437073f28`。
- closeout 累计补丁：`e9dd6e39..4c936d1e -- backend-ts` 导出为 `task10-owned-closeout.patch.gz`，压缩包 SHA256 `ad7017dfe87759199e00ac3599548b2da73433f6e568a687437cdee5b3ad8b74`；解压后补丁 SHA256 `e9b76f45f19568a26200e3653d0dccc72a1f341faafe21cb08135497d1fabe80`。
- 本地分支：`codex/task10-integration`/`codex/task10-worker` 指向 `f8bdde0b`；`codex/task10-current-main-integration` 指向 `11dbf063`。未 push、PR、打包或发送外部消息。

## 精确冲突与整合顺序
1. `backend-ts/src/host-plugin.ts`：07 的 `/internal/exploration` 与票10的 `/internal/extraction` 都先私有鉴权；整合同时保留 reply、exploration、extraction 三类私有路径。
2. `backend-ts/src/host-reply.ts`：07 exploration 与票10 extraction 共用 provider/ModelHost/http 装配；整合同时保留 ExplorationService、ExtractionBatchService、`callExtraction` 和两条 HTTP 入口，没有第二个模型仲裁器。
3. `host-storage.ts`、`legacy-backend.ts`、`reply-service.ts` 对冻结包是依赖漂移，不是合并内容冲突；12 个共享文件中的其余 Python 文件当前 base SHA 仍与冻结清单一致。
4. 正确顺序：先取最新 main，再逐 hunk 联合上述两文件，最后叠加 `task10-worker.patch`；不可整文件回退为冻结 target，否则会丢失 07/23 与分层修复。

## 已完成能力
- 新增 `ExtractionWorker`：原 `notalone:global-worker` 会话锁下单循环扫描；第二实例无法启动；支持唤醒、步骤心跳、停止、成功/可重试失败交接。
- 队列扫描按 owner 找来源仍有效的 parse/normalize/extract_memory 范围；默认只选 legacy，显式 bounded 不会误领或饿死后续联系人。
- owner/contact 进度共用原任务、target、receipt 行；owner 查询真正跨联系人，仍校验 owner 与 `owner_id + contact_id` 隔离。
- 增量同步的消息、来源、回执与观察调度在同一事务内提交；调度调用统一到持久提取入口，事件丢失仍由 due 扫描恢复。
- 新增只读 memory-processing HTTP 适配器，不读正文、不启动模型。Worker 明确要求执行器在同一 claim 围栏内完成 B、trace、watermark 后返回真实处理量。
- `GET/POST /api/contacts/{contact_id}/memory-processing/resume` 已有显式恢复入口：严格校验 owner/contact/task/action，区分 404/409/503；只在精确路径读取 POST 正文，不吞原设置等入口的请求体，且不自行启动 Worker。
- 已迁移显式 `bounded-runtime-v1`：E 使用 `GroundedMemoryLabels` / `grounded-v2` 动态 schema，V 使用 `nullable-proof-v3`，候选按 ALL 依赖和有限六类图重新验真；结果生成可持久化的 v4 依据，null proof 只保留可恢复正文证据、不授予语义支持。批处理缓存和新 trace 恢复复用同一 E/V 执行，不回落 legacy。
- DSH 仍锁定 `0.2.1-rc.2` / `687f282e8625c6b8d11ff58211a90524be2e4317`；本次 Worker 工作走 PG、AbortSignal 和业务租约，不涉及直接 DSH 接口，未改官方核心。

## 验证
- 最小：`extraction-batch-service.test.mjs` 2/2；bounded 批处理断言 E/V 工具各一次、ALL/v4 依据、trace/result 恢复；合成物理调用 2、`model_call_receipt` 2、`outbound_ledger_entry` 2、committed `memory_extraction_trace_call` 2，恢复后均不再增加，未配置外部网络。
- 相关：15 个 extraction 测试 52/52；`model-permits`、`extraction-pipeline`、`extraction-task-store`、`extraction-sources`、`extraction-a-recovery` 组合 31/31；联系人概览 11/11。
- Python 相关：`test_extraction_remote`、`test_extraction_a_consumption`、`test_command` 44/44。
- 类型：`tsc --noEmit` exit 0；`git diff --check` 通过；closeout 补丁在 base `e9dd6e39` 的独立 worktree `git apply --check` 通过。
- 公开扫描：最终 closeout `HEAD --working-tree`，4472 当前文件、15117 历史 blob、2244 提交，issues 0。

## 剩余项
- 未把 `ExtractionWorker` 启动接入生产 host effect；Python `TaskHost` 仍是当前唯一领取者。切换到 TS 前必须先停读/排空旧 Worker、复验租约，并提供 B 段采纳、trace、watermark 及 index/verify 的完整执行器。
- 自动裁决/采纳仍属票11，完整 trace 与来源处理仍属票12，不能把本次 Worker 空接为成功。
- 历史 bounded/nullable-proof 目前以合成 PG、固定 Python oracle 和 loopback/合成调用验收；实际桌面 App/微信、真实模型质量与费用仍未验收，本票仍 claimed，不能标 resolved。

## 数据与清理
- 只使用 `/tmp` 合成 PG `_test` 库、临时目录和合成消息；未读真实 `.env`/资料、未调用真实模型/微信、未写主工作树 source 或 index。
- 临时 `_test` 库查询残留 0，未终止未知 PID；自有三处临时 worktree 已正常移除。分支与补丁保留供 root 集成，不占用额外工作树。
