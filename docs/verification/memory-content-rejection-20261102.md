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
