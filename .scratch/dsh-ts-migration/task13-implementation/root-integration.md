# 票 13 根集成说明

状态：业务纵切、共享宿主、唯一TS Worker、Python执行权门禁和管理HTTP薄桥已完成隔离验证；默认运行时和实际App验收仍由根处理。

## 已交付边界

- `L2ScenarioService` 独占 L2 暂存、核验后发布、读取、段落反馈和场景撤回；不领取任务，不完成 Worker，不发送外部消息。
- `L2ScenarioModel` 每个物理轮次独立领取后台 permit、调用 DSH `prepareCall()` 一次、dispatch 一次，并由现有 ModelHost accounting 预约/记账。没有框架重试、第二套仲裁或 owner/session 替代业务范围。
- `L2ScenarioDocumentWorkspace` 只保留本次内存 Markdown；模型只拿 `read`、`write`、`edit` 三个 schema，路径必须是无斜杠的 `*.md`。写工具没有发布能力。
- 独立候选入口是 `createL2ScenarioHost()`；合成 DSH profile 已从 HTTP `/run` 穿过真实 PG、ModelPermit 和本地回环 provider 发布场景。

## 共享 host-reply 接线

1. `host-reply.ts` 在唯一 `provider` 已安装且 `extractionPermit`、票12 `SourceProcessingTraceStore` 已存在后只创建一次 L2 host。候选预算固定由宿主配置，Worker不能通过请求扩大预算。

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

2. 原唯一Worker仅调用私有 `POST /internal/layered-memory/run`，请求严格为 `{owner_id, contact_id, claim}` 包围的 scope/claim；使用宿主现有内部token、loopback、无Origin与JSON边界。`run()` 成功只把 batch 标成 succeeded、job 标成 `pending_receipt=true`，继续由唯一Worker完成后续L3/任务回执。请求断连会取消物理调用；关闭先排空在途L2调用。
3. L2来源validator在最终事务复用宿主同一个PG client。自动来源必须找到关联contact、trace全部非删除批次成功、含window/batch_end、依赖仍可用且窗口来源摘要等于当前来源；未记录、运行中、失败、跨联系人或不完整均拒绝。联系人手录只接受当前active且revision一致、来源确为active manual document；本人手录只接受当前manual且来源为本人身份或active manual document。不得把trace正文复制进L2。
4. 已认证公共薄桥支持联系人/本人 `GET .../layered-memory`、目标为scenario的 `POST .../summary-error` 与 `POST .../withdraw-scenario`。未支持的enable/refresh/pause等动作继续原路由；已消费请求体的profile summary-error通过同字节回放交给旧执行方，不能因L2接管而截断尚未迁移的profile修正。摘要段错误和场景撤回沿用现有回复副本/generation失效逻辑。
5. L2 service接受明确 `L2ScenarioQualityReader` 注入。主树尚无TS质量Store，因此共享宿主缺省返回 `quality_status=unknown`、`quality_store_unconfigured` 和 `automatic_use_allowed=false`；读取失败同样fail-closed，不会伪造`verified`或`synthetic`资格。
6. `host-reply.close()` 先停止接单、取消私有run、等待宿主事务与物理permit排空，再由共享生命周期释放provider；共享测试关闭后`backgroundActive=0`。

合成接线参考 [l2-scenario-host-plugin.ts](../../../backend-ts/test/l2-scenario-host-plugin.ts) 与 [l2-scenario-host.test.mjs](../../../backend-ts/test/l2-scenario-host.test.mjs)。该 plugin 仅测试，不进入正式 profile。

## 唯一TS Worker与Python执行权

- `extraction-worker.ts` 的同一全局 Worker 同时领取导入/观察任务和 `organize_memory`；L2 使用独立 `organizationRunner`，但共用同一全局锁、步骤租约、心跳、取消、唤醒和关闭排空。
- `completeL2ScenarioWorkerStep()` 在同一 Worker 事务内复验租约、job、批次、generation 和回执。仍有未覆盖资料时重排 pending 步骤并保持 job paused；预算错误码不被清空；`profile_required` 只保留已发布L2回执并把失败/暂停交给票14，不伪造L3或任务成功。
- Python `LayeredMemoryService` 在 TS Task Worker 模式下仍负责 enable、refresh、pause、continue 和维护发现/入队，但 `_dispatch()` 与 `run_batch()` 不再执行 Python L2 模型；取消会立即释放 `organize_memory` 租约。

## 票 12 对齐

- 已对齐提交 `bba2dc11e3f202de3de272bad6d0d6b39df404e3` 的 fail-closed 来源读取与 `eraseSourceTraces()` 删除接缝；本票不复制 trace 正文，也不新增来源副本。
- `SourceProcessingTraceStore` 新增同事务无正文验证入口；自动来源的窗口source snapshot摘要变化会拒绝；直接依赖与本人记忆的候选、来源或消息关联都固定owner+contact。
- L2 batch 的 `dependency_ids` 包含本批合法记忆、递归来源、已读旧场景依赖和修正 guard；来源/记忆覆盖或删除继续由现有 PG 触发器物理清理批次，generation 消费者拒绝旧版本。
- 根未在真实 App 上切换或验收；来源删除与L2发布的整体编排仍由票17负责，单写门禁已在Python执行入口收口。

## 本次未切换的部分

- 默认 Python Task Worker 保留；显式 `NOTALONE_TASK_WORKER_RUNTIME=typescript` 时不启动 Python TaskHost，由唯一 TS Worker执行。L3写入仍属票14。
- TypeScript运行时未配置时，公共L2薄桥认证后稳定返回`layered_memory_unavailable`；Python默认运行时路径未改变。
- 实际App/微信、桌面页面动作和使用真实数据的端到端验收尚未执行。
- TS quality store尚不存在；根必须注入真实读取器后才能打开自动使用，当前不声明任何正式质量资格。
