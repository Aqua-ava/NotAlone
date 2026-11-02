# 内容拒绝不再判失败验收（2026-11-02）

用户确认“内容问题不应该失败”：一条候选不合格不应升级为整批失败、整轮受阻。本次按 [ADR-149](../../architecture/adr/149-content-rejection-is-not-failure.md) 调整，保留来源核验与全部技术故障的保守处理。

## 改动

1. `memory/sqlite/service.ts`：删除“整批候选全被拒即抛 `memory_extraction_source_insufficient`”的升级。逐条拒绝后仍按 `finish` 收尾，目标记为已处理、`stage_result` 记录 `no_new_memory` 与真实拒绝条数，后续批次继续。
2. `memory/extraction/calendar.ts`：时间表达缺少可定位的原话证据时按“发生时间未知”收口，不再抛契约异常；合法的核验输出（occurrence 为 uncertain 且未给证据）保留原始证据与模型判定，不再被伪装成 `insufficient_evidence`。
3. 回归调整：
   - `sqlite-memory-verified-results.test.mjs`：逐项拒绝→任务成功、无候选、保留拒绝计数；新增 25 目标、首批 20 条全拒、第二批 5 条正常的多批回归，断言全目标 `succeeded`、`pending=0`、候选只来自第二批、`blockedContacts=0`。
   - `sqlite-memory-control.test.mjs`：内容拒绝不再产生失败；单人技术失败改用非共用配置故障（`extraction_model_purpose_invalid`，标注为合成代理：真实配置类故障是共用的、调用阶段失败会落为未知回执），继续只重试失败联系人；混合轮次不再有内容失败；历史初始化保护用例改用真实技术失败生成受阻历史。
   - `sqlite-memory-documents-independent.test.mjs`：内容拒绝后文档两阶段严格等于“无合格记忆、明确不适用”，不覆盖任何提取错误归因。
   - `extraction-protocol.test.mjs`：新增“时间表达无逐字证据→发生时间未知、不判契约异常、保留证据”，以及“已取消事件缺发生证据仍可采纳但时间未知、发生证据不含时间表达仍拒绝该候选”的定点回归。

## 验证

- 先红后绿：`语义核验逐项拒绝…` 调整后先失败（`succeeded 0 !== 1`），改 `service.ts` 后通过；`extraction-protocol` 新增用例在 `calendar.ts` 修改前抛 `来源核验结果不符合证据契约`，修改后通过。
- 后端类型检查：`cd backend-ts && node_modules/.bin/tsc --noEmit` 退出码 0。
- 标准测试入口（先构建 `native/skill-read`）定向回归：

  ```
  cd backend-ts && node test/run-current.mjs \
    test/sqlite-memory-verified-results.test.mjs test/extraction-protocol.test.mjs \
    test/sqlite-memory-documents-independent.test.mjs test/sqlite-memory-control.test.mjs
  ```

  结果 57/57 通过。
- 同一入口的更大范围（全部 `sqlite-memory-*`、`extraction-*`、`complete-claim-*`、`memory-*`）中发现 4 条与本改动无关的既有失败：`官方DSH与唯一ModelHost…`、`正式宿主按增量静默阈值…`、`旧source_stamp的已完成存档…`、`旧source_stamp的unknown回执…`。在临时回退本次两个源码文件后，同样 4 条以相同方式失败（24 pass / 4 fail），确认不是本次回归；其余 156+ 条通过。该次聚合运行另有并发挂起进程，已停止，未作为结论。
- 本轮未调用真实模型、未点击真实恢复、未修改真实业务数据；真实资料仅此前只读复核。

## 数据处理影响

- 行为：内容拒绝不再使轮次失败或阻塞；同一批目标按“已处理、无新增”写回，后续目标继续。
- 记录：`stage_result.rejected`、`verification` 事件与处理历史保留拒绝原因与条数，主卡不再显示失败计数。
- 代码策略源指纹随源码变化；已受阻的真实轮次在用户点击一次“恢复本轮处理”后按 ADR-148 建立后继轮，只重做未完成目标（已成功目标不重做、不重发）。
- 零合格记忆的联系人仍会走文档阶段“无合格记忆、明确不适用”路径并推进文档版本号；该路径改动前已存在，频率会上升，已在 ADR-149 权衡中记录。

## 剩余风险与未覆盖

- 真实模型质量未在本轮验收：内容拒绝改为跳过后，模型系统性劣质输出在界面上表现为“没有新增记忆”，需要查看处理历史/执行事件确认原因。
- 现有历史失败记录（含旧 `memory_extraction_source_insufficient`）保持原样，不追溯改写；本次只改变新执行的结果语义。
- 主卡未新增“跳过条数”展示；如需要，另开界面改动。
- 未覆盖：已有发布联系人在内容拒绝后的 `unchanged_memories` 重发组合、ADR-148 后继轮内容拒绝后解除阻塞的端到端回归；现有后继轮用例使用认证失败。以上两项留作后续补测。

## 补充（2026-11-02）：时间标注降级为可选信息

用户确认时间问题参考参考实现 TencentDB-Agent-Memory 处理：发生时间核验不可采纳时只丢弃时间标注、保留正文候选（决定见 [ADR-150](../../architecture/adr/150-optional-event-time.md)）。实现与回归：

1. `memory/extraction/protocol.ts`：核验结果新增可选 `time_unverified`；`event` 不可采纳（未能确认 stage/occurrence）时 `event` 置空并置标记，不再因此把候选判为不通过；`valid_at`/`invalid_at` 与条件仍按原规则准入，不随本条降级。
2. `memory/extraction/verification/complete-claim.ts`：`event` 字段仍校验结构，但不进入整条候选的字段聚合；`time_unverified` 随声明结果传回，供执行事件与处理历史查看。
3. 回归：
   - `extraction-protocol.test.mjs`：时间无逐字证据、发生证据不含表达、来源日历缺失三种情况均由“拒绝候选”改为“丢弃时间、保留候选支持并置 `time_unverified`”；已取消事件仍可采纳但时间未知；条件未核验仍拒绝未被放宽。
   - `complete-claim-verification.test.mjs`：新增“时间字段 uncertain、其余字段有据 → 准入且 event 为空、标记为真、证据保留”；旧事件未核验只丢时间，条件未核验仍拒绝。
   - `complete-claim-semantic-scope.test.mjs`：逐字段否决用例明确排除 `event`（时间可选），其余语义字段仍逐项否决。
   - `sqlite-memory-verified-results.test.mjs`：新增端到端“提取产出无发生证据的时间 + 核验判时间不确定 → 记忆入库、event 为空、`time_unverified` 保留在执行事件”。
   - 追加：结构上可采纳（已取消事件）但 `claim_check.event` 判 uncertain 时丢弃时间并保留候选；没有时间提案时忽略多余的 `event_verification` 槽，不拒绝正文。

先红后绿：`extraction-protocol` 三条用例在协议修改前失败；`complete-claim` 新增用例在聚合修改前 `admitted=false`；端到端用例在协议与聚合修改前无候选。

验证命令与结果：

```
cd backend-ts && node test/run-current.mjs \
  test/extraction-protocol.test.mjs test/complete-claim-verification.test.mjs \
  test/complete-claim-semantic-scope.test.mjs test/sqlite-memory-verified-results.test.mjs \
  test/extraction-flow.test.mjs test/extraction-flow-failure-contract.test.mjs \
  test/extraction-verification-envelope.test.mjs test/extraction-verification-quality-regression.test.mjs \
  test/sqlite-memory-control.test.mjs test/sqlite-memory-documents-independent.test.mjs
```

上述 10 个文件 96/96 通过；其中前 8 个文件单独运行为 55/55。另运行 `test/sqlite-memory-documents.test.mjs` 时其“合成正式宿主未在有界时间内就绪”失败；临时回退本次源码改动后同样失败（6 项中 5 通过、同一条失败），确认为既有环境问题，与本次无关，故不并入本命令。后端 `tsc --noEmit` 退出 0。

数据处理影响：发生时间不可核验的记忆现在会入库（正文、主体、分类、语义、有效起止与条件仍按逐字证据核验），不再被整条丢弃；`verification` 事件的 `result.time_unverified=true` 与 `event=null` 是丢弃依据；记忆字段不带额外标记，避免改变准入绑定。剩余风险同上一节；另需注意按时间检索不到已丢弃时间标注的记忆。独立 Standards/Spec 审查提出并已处理的修正：时间决定拆到 ADR-150、核验提示词与准入规则对齐（含 `claim_check.event` 判定）、验收命令与数量按实跑修正、`nullable-proof-v3` 旧路径例外与“核验模型整体判不确定时仍按原规则”的残余边界在 ADR-150 记录；既有解析归一（日期原话无发生主张的空事件置空）不属于本次时间可选规则，不产生 `time_unverified`。
