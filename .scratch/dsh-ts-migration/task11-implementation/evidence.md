# 票 11 实现与验证证据

日期：2026-10-25

## 交付切片

- `backend-ts/src/memory-adoption.ts`：B 段业务裁决与正式发布实现；按联系人范围读取、召回、核验并逐项提交，不领取任务、不创建 Worker、不发送外部消息。
- `backend-ts/src/memory-adjudication-dsh.ts`：批量裁决、独立关系核验、合并正文核验的结构化 adapter；只调用 `StructuredAdjudicationCallPort`，不直接持有 Provider、数据库或桌面能力。
- `backend-ts/test/memory-adoption.test.mjs`、`backend-ts/test/memory-adjudication-dsh.test.mjs`：隔离合成 PG 与合成结构化端口回归。
- 本分支未修改 `host-reply.ts`、唯一 `ModelHost`、HTTP 路由或 trace 完成器；生产 Python `TaskHost`／`_commit_batch` 仍是唯一生产领取与 B 段写方。共享宿主接入见[根集成说明](root-integration.md)。

## DSH 锁定与官方依据

- `backend-ts/package.json` 固定 `@deepseek-ai/dsh*` 为 `0.2.1-rc.2`。官方标签 `dsh-v0.2.1-rc.2` 指向 commit `687f282e8625c6b8d11ff58211a90524be2e4317`；核实入口为[官方 tags API](https://api.github.com/repos/deepseek-ai/deepseek-harness/tags?per_page=100)。
- 消费锁 `backend-ts/pnpm-lock.yaml` 记录 `dsh`、`dsh-llm`、`dsh-agent` 的发行 integrity；本地包无 `gitHead`，未发现可用 attestation，因此不把发行 integrity 冒充逐字节可复现构建证明。
- 官方 LLM 文档在[锁定提交的 llm README](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/llm/llm/README.md#L63)说明 `prepareCall()` 校验并捕获具体 adapter 代次，[单次 stream](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/llm/llm/README.md#L84)返回原始分片，且[服务本身不重跑请求](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/llm/llm/README.md#L93)；prepared call 只可 dispatch 一次。源码对 `prepareCall()`／dispatch 的约束位于[锁定 `src/index.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/llm/llm/src/index.ts#L956)。
- 官方 Agent 文档在[锁定 agent README](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/agent/README.md#L32)说明 `AgentHandle` 是拆除 agent 的能力；teardown 会[停止并排空 loop、撤销 scope、detach session](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/agent/README.md#L107)。

## 适配结论与边界

- 本票 adapter 不启动 agent，也不使用 DSH 私有内部结构；每轮裁决需要一个结构化调用端口。宿主应把每个 `port.call()` 映射为一次已鉴权的 `prepareCall()` 加单次 `stream()`，不得在框架内隐式重试、并发重放或复用 request key。
- `adjudication`、`relation_verification`、`merge_verification` 是三个独立业务用途和 request key；usage 的 purpose 由 adapter 按实际调用覆盖，不接受端口返回的错误用途。
- DSH LLM 只提供 Provider-neutral stream，不提供本产品的权限、ACK、台账、批次或业务 schema。许可、幂等 request identity、失败分类和单次记账仍由宿主 `ModelHost` 负责；这些宿主接口尚未在本分支接线。
- Agent 生命周期只与共享宿主相关：若宿主用 `AgentHandle` 包装调用，必须由持有者 `dispose()` 并等待排空；本 adapter 没有 agent/session 需要清理。不得因 HTTP 断开提前释放仍在使用的 embedding、Provider 或 PG。
- 本分支只以 synthetic port 验证 adapter 契约；没有声称已通过真实 DSH + NotAlone ModelHost ACK 或宿主纵切。

## 业务行为

- 候选按 `self` 分流到 owner 池，`contact/shared` 分流到联系人池；owner 与 contact 始终同时受 `owner_id + contact_id` 约束。
- 固定本地 embedding 与 BM25 两路 RRF 召回最多 5 项；embedding 缺失或维度不符直接失败，没有词法、网络或云端 embedding 降级。
- 裁决覆盖 `add`、`update`、`noop`、`keep`、`merge`。关系证据必须逐字来自本次候选并覆盖相关父来源；合并正文另做独立核验并要求每个来源消息被逐字引用。
- 候选、父版本 revision、逐来源 receipt、人工父版本、父版本事件／条件／有效期和合并源集合均在接触范围锁内复验。来源正文变化返回 `adoption_source_changed`，旧父版本保持 active。
- 自动采纳统一标记 `auto` 并保留 candidate、来源、version evidence 和 trace；人工父版本保护不因低置信度或风险标签增加额外人工门。
- 候选、确认记忆、父版本退役、trace link／event／dependency 在单项事务内提交；批次不伪装成单一事务。后续单项失败抛出的 `MemoryAdoptionError.partial` 返回按原索引排序的已提交结果，供宿主禁止推进水位并在重试时协调。
- 删除正文指纹在锁内再次检查，owner 自动资料只影响其来源候选所属联系人；同文重放要求完整来源集、依赖模式和 `requires_all_sources` 一致。撤销链沿用既有自动更新恢复接口。

## 验证结果

在隔离 worktree `/private/tmp/notalone-task11.0977IG`，使用 bundled Node：

```text
pnpm exec tsc --noEmit
通过，0 error

node --test test/memory-adoption.test.mjs test/memory-adjudication-dsh.test.mjs
12 tests, 12 pass

retrieval-hybrid / lexical / ranking / memory-mutations / candidate / projection / dimensions
12 tests, 12 pass

extraction-batch-service / pipeline / task-store
18 tests, 18 pass

retrieval-embedding / retrieval-python-parity
5 tests, 5 pass；512 dimensions；max absolute error 3.690149324997449e-8
```

有界全量 `pnpm test`：1061 项，1056 pass、5 fail、约 130 秒。失败均不在本票 diff 的文件中：两个 exploration 服务测试和桌面 foreground-host 测试缺 `esbuild`；`host-reply-unconfigured` 报 `discussion_skills_root_required`；`sync-incremental-reconnect` 的既有清理／错误码断言失败。本票核心与相邻模块均单独复跑通过；不把全量环境失败写成全绿。

## 数据处理影响

- 测试只使用合成 UUID、合成正文、临时 PostgreSQL schema／测试库和本机固定测试向量，不读取实际 App、微信、真实联系人资料、凭据或真实模型。
- 来源正文只在测试进程和合成数据库中短暂处理；测试 fixture 关闭时清理。没有外部网络 embedding、模型调用、回复发送、打包或部署。
- `backend-ts/node_modules` 是从主树创建的临时 symlink，仅用于隔离 worktree 运行验证，提交前删除，不进入交付。

## 未覆盖与后续

- 共享 `host-reply.ts` 接线、三种 purpose 的真实 ACK／台账、Python B 段停写、trace/processing receipt/watermark 协调和宿主排空由根集成完成。
- 真实 DSH + ModelHost 纵切、真实模型质量、实际 App／微信和桌面验收仍待票 24／25；不能把本票业务组件测试解释为生产入口已切换。
