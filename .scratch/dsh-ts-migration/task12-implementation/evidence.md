# 票 12 实现与验证证据

日期：2026-10-25

## 交付切片

- `backend-ts/src/source-processing-trace.ts`：既有 PG 敏感表的同范围读取、记忆／任务反查、脱敏诊断和两类有界删除。返回字段保留旧桌面协议，并显式把 `process_record` 与 `model_ledger` 分开。
- `backend-ts/src/source-processing-trace-http.ts`：`memory-traces`／`source-processing-traces` GET／DELETE 路由候选，不读请求正文、不启动模型、不向外部上传。
- `backend-ts/src/memory-mutations-erasure.ts`：来源删除增加 `window` 事件全量消息／来源快照扫描，兼容缺少 dependency 与 message input link 的旧追踪。
- `backend-ts/test/source-processing-trace.test.mjs`：随机合成 `_test` PostgreSQL 的完整来源、任务、E/V/A 台账、失效、删除和联系删除回归。
- `.scratch/dsh-ts-migration/task12-implementation/host-integration.patch`：只包含宿主接线候选，未修改共享 `host-plugin.ts`。

## DSH 锁定与官方依据

- 固定包版本：`@deepseek-ai/dsh 0.2.1-rc.2`。
- 官方 tag：`dsh-v0.2.1-rc.2` → `687f282e8625c6b8d11ff58211a90524be2e4317`。

| 固定 commit 文件 | SHA-256 | 核对结论 |
| --- | --- | --- |
| `packages/llm/llm/README.md` | `9cc8f2c8d30f9ba44afb8d14f3bbf5f31fbdfb01f950a51a49a1322e2a841049` | 公开 stream、`prepareCall()` 冻结配置；服务不自动重试。 |
| `packages/llm/llm/src/index.ts` | `12863e4b6419825e2600a63110379c5c6bbab18b3a2365ca45645baca5f96db2` | prepared call 只能 dispatch 一次，取消或配置失败在派发前拒绝。 |
| `packages/core/agent/src/index.ts` | `218b30227cdc55d4c193112495a852507d12070028572ac95e6f9d1f954d1077` | `AgentHandle.dispose()` 停止并排空 loop、撤销 session/world；不清理 NotAlone 来源或追踪。 |
| `docs/cordis-tutorial/02-lifecycle-and-effects.zh.md` | `568d7abd06db7f054c73348fe6c5decd57c1ca69f996dfcb8ab30ea3cdbc816c` | 外部资源须返回 disposer；`fiber.dispose()` 等待异步清理。 |

本票没有 Agent、DSH session、Provider 或 Tool 的直接接口：PG 查询／删除是确定性业务。宿主接入复用现有共享池；若未来接入 AgentHandle 或 Cordis effect，关闭顺序必须是停止接收、排空在途调用、释放外部资源，不能靠删除 DB 行取消框架任务。

## 验证结果

在隔离 worktree `/private/tmp/notalone-task12.4wg2K7` 使用 bundled Node 26 / pnpm 和本机合成 PostgreSQL：

```text
node --test test/source-processing-trace.test.mjs
2 tests, 2 pass

相关模块：source-processing-trace / extraction-sources / extraction-task-store /
memory-adoption / memory-candidate-projection / memory-mutations-candidate /
memory-mutations / model-ledger
41 tests, 41 pass

pnpm exec tsc --noEmit
通过，0 error

git apply --check .scratch/.../host-integration.patch
通过

node scripts/check_public_history.mjs --ref HEAD --working-tree
issues: 0
```

新建回归覆盖：

1. 从自动采纳记忆、规范消息和处理任务反查到同一提取批次、来源处理记录、实际来源版本、全部 E/V/A 事件、裁决结果及三条最小调用台账。
2. `process_record.contains_body=true` 与 `model_ledger.contains_body=false` 分离；模型台账不包含 synthetic 输入／返回正文。
3. auto 写入回执和版本保留 `adoption_method=auto`；纯手录 owner 资料返回 `not_applicable`。
4. 运行中追踪标为 `in_progress`／`partial`；失败保留 `failure_stage`／`error_code`；来源进入删除中时拒绝详情。
5. 跨联系人详情与记录反查统一不可见，不返回正文。
6. 手动删追踪清 events／dependency、保留最小调用台账和权威 active 记忆。
7. 来源处理删除写 capture tombstone、清 payload／locator，并通过旧 `window` 快照清除不再有 dependency／message link 的追踪。
8. 独立来源删除入口沿用同一完整快照扫描；联系人删除后追踪不可查询，旧引用不复活。
9. 诊断仅含计数、状态、失败和删除分类；测试断言不含合成消息、请求载荷、文件名或定位。

## 数据处理影响

- 运行时新增的是读取与删除路径，没有新增 schema、正文副本、模型调用、外部网络请求或自动上传。
- 完整过程正文仍只在既有 `memory_extraction_trace_event`、`source_processing_record`、`message_source_ref` 等敏感表；最小模型台账继续是无正文元数据。
- 来源处理删除现在会清受影响整份追踪正文并保留无正文 tombstone／最小调用关联；手动删追踪不删权威消息／记忆。
- 联系范围的完整最小台账清除仍属于整域删除票 17；本票只验证联系人 FK 删除后追踪及调用关联不可重新进入，不宣称完成跨域台账清理。

## 清理

- 两个测试 fixture 各自创建随机 `notalone_task12_trace_*_test` 库，并在连接结束后普通 `DROP DATABASE`；未终止其他连接或删除非本票数据库。
- 验证期间临时 symlink 到主树 `backend-ts/node_modules`，运行结束前已移除；worktree 未安装依赖。
- 检查宿主补丁时创建的 `/private/tmp/notalone-task12-patch.*` 临时目录已移除；其中只有两份 `host-plugin.ts` 副本。
- 未启动实际 App／微信，未读取真实资料、`.env`、凭据或私人聊天，未运行真实模型／网络 embedding，未打包、push、PR 或外部发送。

## 未覆盖与后续

- `host-plugin.ts` 未修改；根需按补丁接入并独占实际 App／微信验收。
- `SourceProcessingTraceApi` 仅以真实 `URL` 直接调用适配器验证路由与状态码；没有启动 DSH host／HTTP server。来源删除回归直接调用共享 erasure seam，没有经过完整来源删除任务入口。
- Python 仍是现有完整追踪写入方与 `batch_end`／watermark 原子尾提交方；宿主切换 B 段时必须完成票 11 的业务唯一写方移交。
- DSH 实际最终 wire 捕获、真实 ModelHost ACK／台账和真实模型质量仍由票 05／24／25 验收。
- 桌面任务导航 UI／控制器尚未增加；本票只交付服务与 HTTP 入口。
- 整联系人／账户的最小台账与可恢复副本彻底清除仍由票 17／24 负责。
