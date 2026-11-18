# ADR-174：对齐腾讯方案——不确定性降级而非拦截候选

已合并入[ADR-200：记忆采纳、来源核验与更新合并现行合并决定](../200-memory-adoption-consolidated.md)（2026-11-18）：关系记忆的采纳、来源核验、内容拒绝、时间标注与更新合并约束已收拢到该 ADR。下文保留为历史决定与原因，现行条款以该 ADR 为准。

> 部分替代（2026-11-14）：第 2、4 条关于动作兼容与正常变化拦截的限制由 [ADR-184：有来源支持的记忆变化自动更新与合并](184-source-grounded-memory-update-and-merge.md) 修订。以下保留原决定及其当时依据；自由文本不确定性降级、低把握丢弃、同义重复留痕与人工保护继续有效，现行自动更新／合并要求见 ADR-184 和[记忆处理](../../current/memory-processing.md)。

状态：已合并（ADR-200）。原记录：已采纳（2026-11-06，用户在实施规格确认中同意本决定与下述直接放行范围）。实现见任务 01–04 的本地提交（460fdf5d5、f0ad57a41、dee12e2f5、49b7b5f46）；真实小批验收（R1/R2）按 `.scratch/memory-auto-adoption-alignment/spec.md` 执行前不宣称质量收敛。依据的实测证据（隔离副本真实库）计数见 `.scratch/memory-auto-adoption-alignment/evidence/01-relation-coverage-replay.md`。

## 决定

候选的「不确定」不再整体转化为人工待确认。腾讯同类链路把不确定性消化在提取与合并阶段（宁缺毋滥、独立完整、归纳合并、低分丢弃），裁决阶段只有 `store / skip / update / merge` 四个自动落地动作；本仓库保留更严格的来源核验（正文逐字证据、主体归属、联系人隔离），这是产品硬边界，不在本决定放宽范围。

1. **独立关系的证据覆盖误拦修复**：`relation.kind='independent'` 时，核验证据只须逐字有效且引用至少一条候选来源，不再要求覆盖比较池中每条旧记忆的来源原文——旧记忆与候选无关时该要求不可满足。其余关系类型保持原覆盖要求。
2. **`keep` 与 `noop` 自动条件对齐**：`keep` 允许 `independent | supplement | historical_supplement`（两处 `changed` 均为假）；`noop` 不再要求逐字相同，当模型判无增量、目标为非保护 `auto` 旧记忆且旧正文信息量不更少（码点长度代理）时自动跳过，候选新增来源只记 `skipped_duplicate` 执行事件。
3. **前置门槛只保留数据正确性**：时间不合格、整组 `alternatives` 为未决指代标注（`AMBIGUITY_NOTE`）、条件无来源支持的候选仍被拦截；`alternatives` 自由文本（细节缺失之类）由拦截改为降级——继续裁决并自动采纳，采纳事件记 `adopted_with_alternatives`；未核实的事件标注按现行规格丢弃标注、正文继续并记 `time_unverified`。核验层的 `time_unverified` 降级继续生效。
4. **待确认保留给真矛盾与不一致**：`memory_relation_pending` 拆分为 `memory_relation_conflict`（真矛盾）、`memory_relation_evidence_incomplete`（证据覆盖不足）、`memory_relation_unsupported`（核验不支持）、`memory_relation_inconsistent`（模型自相矛盾/ID 不一致）；`unresolved_conflict`、核验不支持、多目标、人工保护、时间线覆盖风险、图片参与比较、合并与重复核验未通过仍保持待确认。
5. **「处理中/未完成」与「待确认」分开**：读取层按最後裁决结果与门槛留痕派生候选状态（`pendingStage`），未发出裁决且无拦截条件的候选在记忆页标「处理中/未完成」而非「待确认」；触发处理使用现有「继续 / 放弃未知并重试」入口，不新增后台能力。提取层低把握候选（confidence < 0.5）解析后丢弃并记 `low_value_dropped`，不计为结构拒绝、不影响水位或批次完成。

## 被替代的现行规则

- [现行记忆处理规格](../../current/memory-processing.md)第 1 条「置信度、语用或风险标签本身不新增人工审核门」在此之前仍被 `alternatives` 前置门槛部分绕过：自由文本 `alternatives` 曾整体拦截候选并转为待确认，现已改为降级放行留痕。
- 独立关系的核验证据覆盖要求（曾要求引用池中每条旧记忆来源）被本决定第 1 条替代。
- `noop` 的逐字相同判定被第 2 条替代；`add / keep` 仅接受 `independent` 的限制被第 2 条替代（`add` 仍要求独立）。
- [ADR-085](085-source-verified-automatic-adoption.md) 的来源核验、主体归属与删除路径不变；未自动采纳路径（手动采纳、拒绝）不受影响。结构与现行规格一致性见该规格第 1、4、5、7 条修订。

## 残留风险

- 模型把真实两读句子写成自由文本 `alternatives` 时会被放行。缓解：来源核验逐字有效、记忆标 `auto` 可撤销，采纳事件含 `adopted_with_alternatives` 可追溯。
- 独立关系覆盖放宽后，模型误判「独立」可能漏掉重复或矛盾。缓解：`kind` 与 `claim_changed / condition_changed` 判断不变；`unresolved_conflict` 仍拦截；11 条方案测试与离线重放显示既有关系判断未被放大。
- `noop` 放宽以正文长度作信息量代理，极端同长改写可能被跳过（来源并入受限于现有引用模型，只记事件）。缓解：目标须为非保护 `auto` 且关系核验通过。

## 回退方式

四个提交可按步骤独立回退：恢复 `relationCovered` 原判断（01）、恢复逐字相同与 `keep` 独立限制（02）、恢复 `alternatives` 整体拦截与事件整体拦截（03）、恢复提示原文并移除 0.5 阈值（04）。已自动采纳的记忆为 `auto`、可撤销，不回滚数据；原因码旧值仅在历史事件中保留，界面按未知码兜底显示。
