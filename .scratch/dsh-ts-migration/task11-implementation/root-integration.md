# 票 11 根集成说明

状态：票 11 的业务组件、DSH 结构化 adapter 与隔离 PG 回归已完成；尚未切换生产 B 段，也未修改共享宿主。

## 不改的边界

- `MemoryAdoption` 是 B 段唯一业务发布实现；它不领取任务、不创建第二个 Worker、不发送外部消息。
- 当前 Python `TaskHost` 仍是唯一生产领取者，Python `_commit_batch` 仍在执行 B 段。根接入前必须停止 Python B 段责任，避免 A 结果同时由 Python 和 TS 采纳。
- `backend-ts/src/host-reply.ts`、唯一 `ModelHost`、提取 HTTP 路由和 trace 完成入口均为共享宿主文件，本分支不修改。

## 接线步骤

1. 在 `host-reply.ts` 的提取配置建立期创建一次固定本机 embedding（`createLocalEmbedding()`），并作为 `MemoryAdoptionOptions.embed` 注入；宿主退出时关闭。
2. 用 `DshMemoryAdjudicationRuntime({port,batchKey})` 实现 `AdjudicationRuntime`。`port.call` 必须接到 05 的唯一 `ExtractionModelCaller`/许可与记账链：
   - 每次 `adjudication`、`relation_verification`、`merge_verification` 各自一次真实调用。
   - 沿用原 task 五字段 claim，使用独立 `attempt_id`、`ledger_entry_id` 和 purpose-specific 确定性 request key。
   - 当前 `modelTaskRequestId()` 只接受 `extraction|skill_learning`；根需扩展受限 purpose，或提供等价的确定性 request identity。不能把三次调用复用一个 request key。
   - 调用端 ACK 未知时 fail-closed；PG 已知不降级，不根据 HTTP 回包丢失直接重发。
3. `ExtractionBatchService.run()` 返回 A 段 `accepted` 与同序 `candidate_trace_ids`。在 B 段责任已完全移交后，将它们映射为：

```ts
{
  contact_id,
  trace_id,
  batch_key,
  signal,
  facts: outcome.accepted.map((fact, index) => ({
    fact,
    candidate_trace_id: outcome.candidate_trace_ids[index],
  })),
}
```

4. 调用 `MemoryAdoption.adoptBatch()`。该方法按批序逐项使用独立事务；单项内完成 candidate、来源/父版本复验、auto 记忆、父退役、trace link/dependency。整批不是单一事务。
5. 只有整批成功后才在同一下游事务完成 trace、processing receipt 与 watermark。任一项失败都不能推进水位；重跑依靠同一 trace/target 和确定性 candidate identity 去重。部分已提交项须从 `AdoptionStats.results` 与数据库真实行协调。
   单项提交失败会抛出 `MemoryAdoptionError`，其 `partial` 属性携带按原候选索引排序的已落库结果；宿主不得把异常当作整批回滚，也不得在推进水位前忽略它。
6. 宿主停止接收后，先排空在途采纳与模型许可，再释放 embedding、Provider 和 PG。不得仅在 HTTP 断开时释放资源。

## 已收紧的业务边界

- 候选在任何新增、待确认、重复或删除指纹结果发布前，都在接触范围锁内复验当前完整来源窗口与已存 dimension evidence；来源正文变化返回 `adoption_source_changed`，不会以 stale 事实推进任务。
- 更新与合并的父版本按裁决 shortlist 的 revision 和逐来源 receipt 复验；短名单来源缓存另按候选来源主张解析，不能把旧父版本的附属来源冒充本次模型依据。
- 合并拒绝人工父版本、事件／条件／有效期不一致、正文或逐来源引用不成立、来源集合变化；父版本退役、候选确认和 trace 在同一单项事务。
- 重复判定同时比较来源集、依赖模式和 `requires_all_sources`，不把同文但依赖合同不同的事实吞成 replay。

## 必须新增的共享宿主 patch

- `modelTaskRequestId()`：增加仅允许 `adjudication|relation_verification|merge_verification` 的 purpose 参数；调用点仍绑定原 task/batch，不能由客户端自报权限。
- `host-reply.ts`：注入 embedding、`StructuredAdjudicationCallPort` 和 `MemoryAdoption`；选择 A+B 的新私有业务入口，或由原 Worker 在完成 A 后直接进入 TS B。两种方案只能选一个写入责任方。
- 提取 trace 完成器：把 `adoptBatch` 返回的真实结果与 `trace.complete`/watermark 协调；不要将 `write_plan` 当 committed。
- 现有 05 测试增加三种 purpose 的 ACK 丢失、已知失败和真实新 batch 用例；现有 A 段 tests 不能代签。

## 集成后最小验收

1. 合成导入/观察任务经原 claim 和真实内部入口产生 A，再走 TS B；数据库断言 candidate `confirmed`、confirmed/owner memory `auto`，trace links 与 watermark 一致。
2. 两段模型回应下完成 update，确认独立两次真实 physical call、ledger 各一行、父 revision 与 version evidence 可撤销。
3. merge 的 2–8 父版本、ALL 来源和失效同事务；合并正文核验失败或输出坏 ID 时无新增、无水位。
4. 裁决后、写事务前撤销来源；断言既有父仍 active、无新记忆、无 processing 完成。
5. 同一请求重放只读回既有结果；部分批次失败重试只补未提交项。
6. 关闭 Python B 后运行 `npm run dev` 的真实内部入口；本分支未授权或执行实际 App/微信/真实资料。
