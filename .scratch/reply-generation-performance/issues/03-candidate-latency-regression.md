# 候选准备延迟回归

Triage: ready-for-agent
State: resolved

Blocked by: 01, 02

## Goal

用合成 SQLite、合成后台读和合成模型 provider 验证：后台图片／记忆读取进行时，候选请求完成本地准备并把请求交给 provider 的 P95 ≤ 1 秒、最大值 ≤ 2 秒。

## Acceptance

- [x] 完整候选链路记录受理、上下文冻结、运行时可用、provider 收到请求的阶段。
- [x] 后台慢读与候选写入并发时，候选不再等待后台查询结束。
- [x] 指标断言使用稳定合成数据和明确样本量，不以真实聊天正文作夹具。
- [x] 若仍超目标，记录实际瓶颈并按规格决定是否合并图片同步 pending 查询。
- [x] 相关后端测试和类型检查通过。
## Answer

- 实现：候选 `SqliteReplyTurns` 在现有准备链路增加 `onPreparationStage` 观测点，分别记录 `accepted`、`context-frozen`、`runtime-available`；`runSingleDiscussionTurn` 在运行时副本可用时回调，阶段只用于测量，不改变候选业务分支。
- 测量边界：从候选受理开始，到合成模型 provider 收到首次请求为止；不包含模型生成和网络耗时。测试使用真实 SQLite、真实候选存储/运行时链路和进程内合成 SSE provider。
- 后台并发夹具：新增 `sqlite-reply-preparation-slow-reads.mjs`，让 `media.imageSyncTargets` 与 `memory.read` 在独立只读事务中实际进入并阻塞；20 个样本中图片 10 次、记忆 10 次，每次 provider 收到请求时后台读仍未结束，后台读最终均返回确定的空结果。
- RED：临时移除 `runtime-available` 回调后，`node --test backend-ts/test/sqlite-reply-preparation-latency.test.mjs` 失败，缺少的准备阶段为 `accepted`、`context-frozen` 但无 `runtime-available`，证明测试确实覆盖阶段链路。
- GREEN：同一测试 20 样本全部通过；受理→provider 总计 P50 `16.224ms`、P95 `24.269ms`、max `61.046ms`，低于 P95≤1,000ms、max≤2,000ms 目标。分阶段 P95：受理→冻结 `2.233ms`、冻结→运行时 `14.933ms`、运行时→provider `8.035ms`、调用入口→受理 `2.774ms`。
- 结论：当前瓶颈未超过规格目标，不需要把图片同步 pending 查询合并到候选准备；后台慢读不会阻塞候选写入和 provider 请求。
- 验证：`backend-ts` typecheck 通过；合并 Skill 后 `sqlite-reply-skill-loop.test.mjs` 15/15。仅使用合成联系人、消息、Skill、SQLite 慢读和 SSE，不调用真实外部模型、不读取真实微信、不发送消息、不启动 App。
- 剩余风险：本票是本地准备延迟证据，不替代 Performance 04 的实际开发 App 验收；样本是本机合成负载，不宣称真实联系人历史的绝对时延。


### 2026-11-04 删除排空后复测

- 在共享删除 holder 与边界读取修复后重跑同一条 20 样本完整候选链路：P50 `23.370ms`、P95 `33.186ms`、max `77.442ms`；20 次均在后台图片/记忆慢读尚未结束时让进程内 provider 收到请求。
- 分阶段 P95：受理→冻结 `5.073ms`、冻结→运行时 `17.243ms`、运行时→provider `12.929ms`、调用入口→受理 `4.105ms`。仍显著低于 P95 ≤ 1,000ms、max ≤ 2,000ms。
- 与先前样本的绝对毫秒差异仅为本机运行波动；结论仍是本地准备不等待后台慢读，且不包含模型网络/生成耗时。实际开发 App 验收仍由 ticket 04 完成。
