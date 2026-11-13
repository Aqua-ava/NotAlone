# 单窗口先审后采纳的现有接缝

2026-10-25，只读源码核对；未读取真实库、联系人资料或 App，未调用模型。

1. `POST /internal/extraction/run` 是 A-only：`backend-ts/src/extraction-batch-http.ts:23` 与 `backend-ts/src/host-reply.ts:208`。仅接收 `owner_id/contact_id/trace_id/batch_key/claim`；正文由正式来源读取，不能贴入另造合成夹具。
2. `ExtractionBatchService.run` 在 `backend-ts/src/extraction-batch-service.ts:108` 读取原登记的窗口，在有效任务租约下核对范围、来源、target/context、快照和原请求身份；`:294` 附来源核验回执、写 `typescript_a_result`。其返回不是采纳。
3. 暂不调用 `/internal/extraction/run-b`。该路由接 `runExtractionWithAdoption`（`backend-ts/src/extraction-adoption-host.ts:41`），会先跑／恢复 A，再进入 B；不是 B-only，也没有操作员审阅暂停参数。
4. 审后 B-only 的现有业务接缝是 `createExtractionAdoptionHost(...).run(input,aResult,signal)`（同文件`:102`）；必须保留原 A 回执、规则和来源世代，不能手填模型结果。根需将审阅确认与该接缝接在现有正式宿主里，或核实可安全复用的原调用方。

## 最多八次物理调用

- `createExtractionModelCaller`（`backend-ts/src/extraction-model.ts:86`）走 ModelPermit、`beforeDispatch`、PG reservation 和 receipt；实际调用后复验来源与取消。`SourceVerificationOutput` 的 strict 传输也在同一记账链内。
- `model-provider.ts:83`／`:137` 是实际发送前回调；`host-model-accounting.ts:144` 是现有预留入口。提取权威上限仍是该文件`:77` 的 `129`，不是任意实验的八次总 cap。
- 未发现 TS 接 `NOTALONE_PROBLEM_BUDGET` 的实现。只 export Python 环境变量不能保护 TS；HTTP 入口前后计一次也不等于物理计数。
- 根需把同问题现有累计账本的原子预留接到这条发送前链，覆盖 E、strict-V、重试及若获准的 B／关系／合并请求；失败、超时和 unknown 不退款。此文未创建预算或修改生产限额。

## 未知结果不是重放许可

`extraction-batch-service.ts:109` 查 unconfirmed，`:134` 对原 request 的 pending／unknown 拒绝为 `extraction_batch_outcome_unknown`；caller 另有 `extraction_model_recovery_unknown`。不能换 task ID 对同一未知窗口重新发送。先核对原 receipt／trace 的派发和提交终态；仍未知就保留阻塞。`adoption_event_unverified` 也不能用放宽来源校验解决。

结论：现有 A-only 足以承接正式来源下的先审结果；审阅后的 B-only 操作接线和跨全部阶段的八次原子 cap 尚需根补齐，不能把当前 `/run-b` 宣称为已经满足整项要求。
