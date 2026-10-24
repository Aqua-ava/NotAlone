# 票 13 根集成说明

状态：业务纵切、独立宿主候选和隔离验证完成；未修改共享 `host-plugin.ts`、`host-reply.ts`、桌面控制器或生产 Worker。待根集成和实际验收。

## 已交付边界

- `L2ScenarioService` 独占 L2 暂存、核验后发布、读取、段落反馈和场景撤回；不领取任务，不完成 Worker，不发送外部消息。
- `L2ScenarioModel` 每个物理轮次独立领取后台 permit、调用 DSH `prepareCall()` 一次、dispatch 一次，并由现有 ModelHost accounting 预约/记账。没有框架重试、第二套仲裁或 owner/session 替代业务范围。
- `L2ScenarioDocumentWorkspace` 只保留本次内存 Markdown；模型只拿 `read`、`write`、`edit` 三个 schema，路径必须是无斜杠的 `*.md`。写工具没有发布能力。
- 独立候选入口是 `createL2ScenarioHost()`；合成 DSH profile 已从 HTTP `/run` 穿过真实 PG、ModelPermit 和本地回环 provider 发布场景。

## 共享 host-reply 接线

1. 在唯一 `provider` 已安装且 `extractionPermit` 已存在后创建一次候选：

```ts
const l2Scenarios = createL2ScenarioHost({
  ctx: options.ctx,
  transaction: work => options.storage.businessTransaction(work),
  provider,
  permit: options.extractionPermit,
  binding: {
    provider: options.configuration.model.provider,
    model: options.configuration.model.model,
    maxTokens: options.configuration.model.maxTokens,
    temperature: options.configuration.model.temperature,
    reasoningEffort: options.configuration.model.reasoningEffort,
  },
  profile: options.configuration.model.budgetProfile,
  budget: {max_memories:120,max_batch_memories:20,max_scenarios:15,max_paragraphs:40,max_characters:128000,max_model_calls:16},
  validateSources: async (client, work) => { /* 票 12 来源复验 */ },
});
```

2. 只在已领取的 `layered_memory/organize_memory` 私有路径调用 `l2Scenarios.run(scope, claim, signal)`。调用前必须停止 Python L2 writer；切换期不能双写。`run()` 成功只把 batch 标成 succeeded、job 标成 `pending_receipt=true`，继续由唯一 Worker 完成后续 L3/任务回执。
3. `validateSources` 应直接调用票 12 的 `SourceProcessingTraceStore`：按 `owner_id + contact_id` 和每个 `work.inputs[].memory_id` 复验 `availability`；`deleted`、`not_recorded`、`not_applicable`、处理中或来源快照变化均拒绝本次发布。不得把 trace 正文复制进 L2。
4. 读取路由映射到 `service.read(scope, mapping_cursor)`；输出沿用现有 `layered_memory` DTO。`eligible_count` 保留全部合法 L1 计数，`protected_count` 单列反馈 guard 排除量。摘要段错误映射到 `reportParagraphError()`，场景删除映射到 `withdrawScenario()`；两者会在同一事务内清理既有回复副本。若产品新增段落删除动作，只调用 `removeParagraph()` 的安全撤回语义，不伪造手工 `system_generated=true` 正文。
5. `host-reply.close()` 仍先停止接单、等待在途业务和物理调用排空，再由共享宿主释放 provider/PG。候选没有 Agent/session 或临时文件需要第二次清理。

合成接线参考 [l2-scenario-host-plugin.ts](../../../backend-ts/test/l2-scenario-host-plugin.ts) 与 [l2-scenario-host.test.mjs](../../../backend-ts/test/l2-scenario-host.test.mjs)。该 plugin 仅测试，不进入正式 profile。

## 票 12 对齐

- 已对齐提交 `bba2dc11e3f202de3de272bad6d0d6b39df404e3` 的 fail-closed 来源读取与 `eraseSourceTraces()` 删除接缝；本票不复制 trace 正文，也不新增来源副本。
- L2 batch 的 `dependency_ids` 包含本批合法记忆、递归来源、已读旧场景依赖和修正 guard；来源/记忆覆盖或删除继续由现有 PG 触发器物理清理批次，generation 消费者拒绝旧版本。
- 根集成必须把票 12 的 source validator 传入 `validateSources`，并在来源删除事务中同时调用票 12 的 erase seam；本票只验证了现有来源触发器导致的不发布，没有在本分支改动 ticket 12 文件。

## 不得直接合并的部分

- 生产 Python `TaskHost`、Worker 完成器和 L3 写入仍由根线程统一切换。
- 实际 HTTP/desktop IPC 路由、页面动作和 source-trace 适配没有在本分支修改。
- 本地质量投影固定为 `synthetic` 只供隔离测试；根集成应从现有 quality store 注入真实状态，不能把本票测试结果当线上资格。
