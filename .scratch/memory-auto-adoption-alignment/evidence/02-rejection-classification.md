# 证据 02：R2 核验拒绝细分（任务 A，离线只读）

日期：2026-11-06。依据 `.scratch/memory-auto-adoption-alignment/followup.md` 第 2 节。零外发（不调用模型），两份副本均以 `sqlite3 "file:<path>?mode=ro&immutable=1"` 打开；未访问真实库 `~/Library/Application Support/NotAloneDesktop`。分类脚本与原始查询在仓库外（`/tmp/rejection_classify.py`、`/tmp/rejection-result.json`、`/tmp/rejection_counts.sql`、`/tmp/rejection_verify.sql`）；副本路径与 run id 由任务派发单给出、不入库，此处只留口径与计数。

## 1. 数据源与打开方式

| 组 | 副本 | 提取提示 |
| --- | --- | --- |
| 基线 | 仓库外私有基线副本（旧提取提示，基线 run） | 旧 |
| R2 | 仓库外私有 R2 副本（新提取提示，三个 run 合计） | 新 |

- R2 副本中另有同批次一个 run 无任务与事件（不计入）；基线副本中本轮之外的 run 已按 run 过滤排除。
- 两份副本来自不同时间备份，不是同一数据库切片；对照前提是同窗口重提取的窗口内容等价（验收记录已说明）。

## 2. 事件与映射口径

- 映射链：`execution_event.step_attempt_id` → `step_attempt.step_id` → `processing_step.task_id` → `processing_task.run_id`；`processing_task.scope_kind` 区分 contact/self 任务。
- 总拒绝数：`kind='stage_result'` 事件 `payload.rejected` 按 run 求和（该值由 `backend-ts/src/memory/sqlite/execution.ts:195` 从提取流程的 `rejected_count` 落库）。
- 细分：`kind='verification'` 事件（`backend-ts/src/memory/extraction/flow.ts:190`）：
  - `payload.disposition`：`continue` / `unverified_rejected` / `unsupported_rejected`（映射见 `flow.ts:191`）；
  - `payload.result.issues`：结构原因码数组；
  - `payload.before`：候选字段（`subject`、`category`、`source_message_ids`、`confidence`、`alternatives` 等）；
  - `payload.candidateTraceId`：候选追踪 id（去重键）；
  - `payload.result.model_claim_check.parts[].attribution`：`verdict` / `scope_subject` / `actor_kind` / `resolution` / `subject_mentions`。
- 归属：`before.subject` 枚举 `self` / `contact` / `shared`；按产品口径 `shared` 属 contact 范围（`backend-ts/src/memory/extraction/multimodal.ts:27`；核验期望 scope 见 `verification/complete-claim.ts:189`）。被拒候选没有 `memory_candidate` 行，只能取候选自身的 `subject`。
- 来源消息数：`before.source_message_ids` 长度，`>= 2` 记「合并」，`= 1` 记「单句」。
- 发送者兜底：`model_claim_check.parts[0].attribution.subject_mentions` 长度为 0 且 `resolution='unique_context'`（判定逻辑 `complete-claim.ts:120-130`）。
- 结构拒绝：`kind='parse'` 事件 `payload.status='rejected'` 且 `disposition='structure_rejected'`（`flow.ts:151-153`；解析规则 `protocol.ts:123-158`），此类候选未进入核验，无 verdict/issues；其 `candidate_raw.fields` 提供 `subject` / `source_message_ids` / `confidence`。

## 3. 去重口径与重试检查

- 口径：以 `(run, candidateTraceId)` 为一条候选；同一候选的核验结论只保留一个 `verification` 事件。
- 复核（SQL 见第 6 节 Q2）：基线 `22` 个事件 / `22` 个不同 `candidateTraceId`；R2 `22` / `22`（两个 run 各 `11` / `11`）；三 run 之间无重复 trace；所有目标事件的 `reused_call_id` 均为空。因此本次目标 run 不存在「重试/reused call 造成同一候选多事件」的重复，无需人工合并。
- 若未来出现重复：表现为同一 `candidateTraceId` 的多个 `verification` 事件（可同 `verificationInputEventId` 且 `created_at`/`reused_call_id` 不同），应按 trace 去重并保留最终 disposition。

## 4. 四维计数（R2 逐 run 拆分）

| 指标 | 基线 | R2-1 | R2-2 | R2-3 | R2 合计 |
| --- | --- | --- | --- | --- | --- |
| `stage_result.rejected` 求和 | 4 | 3 | 6 | 0 | 9 |
| `candidate_raw` 事件 | 22 | 11 | 13 | 0 | 24 |
| `verification` 事件（= 进入核验候选） | 22 | 11 | 11 | 0 | 22 |
| 核验拒绝（`disposition` 为拒绝） | 4 | 3 | 4 | 0 | 7 |
| 其中 `unverified_rejected` | 3 | 3 | 4 | 0 | 7 |
| 其中 `unsupported_rejected` | 1 | 0 | 0 | 0 | 0 |
| 结构拒绝（未进入核验，unknown） | 0 | 0 | 2 | 0 | 2 |

> 核验拒绝 7 + 结构拒绝 2 = `stage_result.rejected` 合计 9，与验收记录的 4→9 对上。

verdict / issues / 合并 / 归属四张表与 `docs/verification/memory-auto-adoption-alignment-20261106.md` 的「R2 补充」小节一致，此处不重复抄录；补充如下口径细节：

- issues 主因按互斥优先序 `subject > meaning > insufficient_evidence > 其他` 归类；多 issue 的附加出现：基线 1 条 `meaning` 主因同时带 `insufficient_evidence`；R2 1 条 `meaning` 主因同时带 `time` + `pragmatics`。
- 归属：R2 的 6 条「联系人」中含 1 条 `subject=shared`（按 contact 范围归入）；2 条结构拒绝的 `subject` 均为 `self`（用户本人）。
- R2 的 58517d52 那个 run 无候选（两个任务 `no_new_memory`），拒绝 0。

## 5. 三问回答

### 5.1 新增的 5 条拒绝主要是什么原因？

按总口径 4→9 拆解（新增 5 条）：

| 构成 | 条数 | 说明 |
| --- | --- | --- |
| 结构拒绝增量 | 2 | 解析阶段 `structure_rejected`，未进入核验；均为合并候选（来源 2 条）、`subject=self`、`confidence=0.6` |
| 核验 `subject` 增量 | 2 | 均为合并候选，`unverified_rejected`（`uncertain`） |
| 核验 `meaning` 增量 | 1 | 合并候选，`unverified_rejected`（`uncertain`） |
| verdict 端抵消 | −1 | 基线 1 条 `unsupported_rejected` 在 R2 未出现 |

要点：若严格按核验事件口径，拒绝数是 **4→7（+3）**，其中 `subject` +2、`meaning` +1；另外 2 条是解析结构拒绝，不属于「核验拒绝」，但计入 `stage_result.rejected`。因此 4→9 不能全部算作核验变严。

### 5.2 是否集中在合并候选？

- 边际构成：新增 5 条全部为合并候选；合并侧拒绝 2→7（+5），单句侧 2→2（0）。
- 但候选基数同时变化：合并候选 13→19、单句候选 9→5；拒绝率合并 2/13≈15%→7/19≈37%、单句 2/9≈22%→2/5=40%，两组都在上升。
- 主体类拒绝：合并 1→3、单句 2→2（主体拒绝增量只在合并侧，单句不变）。
- 结论：数值上「新增拒绝集中在合并候选」成立，但很大程度来自合并候选占比上升（13/22→19/24）；样本小（拒绝 4 vs 9），不能据此单独证明「合并提示让归属变难」。

### 5.3 是否与发送者兜底有关？

- 主体被拒（issues 含 `subject`）：基线 3 条、R2 5 条；其中走发送者兜底（`subject_mentions` 空且 `resolution=unique_context`）的条数 **基线 0、R2 0**。
- 主体被拒的 5 条（R2）均为 `resolution=explicit`、`subject_mentions` 长度 1–2、`attribution.verdict=supported`、`scope_subject` 与候选 `subject` 一致；按 `complete-claim.ts:163-197` 的 issue 生成逻辑，此类 `subject` issue 来自程序侧 `groundedAttribution`（`complete-claim.ts:131-162`：主体提及须在引文中唯一可定位、人称词与发送者一致）不通过，而非发送者兜底路径。
- 兜底命中候选：基线 8 条（7 `continue` + 1 条 `meaning`+`insufficient_evidence` 的 `unsupported_rejected`）；R2 6 条（5 `continue` + 1 条 `meaning` 的 `unverified_rejected`）。兜底被拒数 1→1，不构成新增拒绝来源。

## 6. 复现

前置：后端已停止；只读副本路径与 run id 从任务派发单带入（不写入仓库）。

```sh
DB_BASE='<仓库外基线副本路径>/notalone.sqlite'
DB_R2='<仓库外 R2 副本路径>/notalone.sqlite'
RUN_BASE='<基线 run id>'
RUN_R2_1='<R2 run 1>'; RUN_R2_2='<R2 run 2>'; RUN_R2_3='<R2 run 3>'
ALL_RUNS="'$RUN_BASE','$RUN_R2_1','$RUN_R2_2','$RUN_R2_3'"
```

Q1 总拒绝数（期望基线 4；R2 = 3+6+0 = 9）：

```sh
sqlite3 "file:$DB_BASE?mode=ro&immutable=1" "
SELECT t.run_id, sum(coalesce(json_extract(e.payload,'\$.rejected'),0)) rejected_sum, count(*) n
FROM execution_event e
JOIN step_attempt a ON a.owner_id=e.owner_id AND a.id=e.step_attempt_id
JOIN processing_step s ON s.owner_id=a.owner_id AND s.id=a.step_id
JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id
WHERE e.kind='stage_result' AND t.run_id IN ($ALL_RUNS)
GROUP BY t.run_id;"
```

Q2 去重检查（期望 events = traces，reused_events = 0）：

```sh
sqlite3 "file:$DB_BASE?mode=ro&immutable=1" "
SELECT t.run_id, count(*) events,
       count(DISTINCT json_extract(e.payload,'\$.candidateTraceId')) traces,
       sum(CASE WHEN e.reused_call_id IS NOT NULL THEN 1 ELSE 0 END) reused_events
FROM execution_event e
JOIN step_attempt a ON a.owner_id=e.owner_id AND a.id=e.step_attempt_id
JOIN processing_step s ON s.owner_id=a.owner_id AND s.id=a.step_id
JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id
WHERE e.kind='verification' AND t.run_id IN ($ALL_RUNS)
GROUP BY t.run_id;"
```

Q3 逐候选分类（verdict / issues / 来源数 / 归属 / 兜底；不含正文）：

```sh
sqlite3 "file:$DB_BASE?mode=ro&immutable=1" "
SELECT t.run_id,
       json_extract(e.payload,'\$.candidateTraceId') trace,
       json_extract(e.payload,'\$.disposition') verdict,
       json_extract(e.payload,'\$.result.issues') issues,
       json_array_length(json_extract(e.payload,'\$.before.source_message_ids')) nsrc,
       json_extract(e.payload,'\$.before.subject') subject,
       json_extract(e.payload,'\$.result.model_claim_check.parts[0].attribution.resolution') resolution,
       json_array_length(json_extract(e.payload,'\$.result.model_claim_check.parts[0].attribution.subject_mentions')) n_mentions
FROM execution_event e
JOIN step_attempt a ON a.owner_id=e.owner_id AND a.id=e.step_attempt_id
JOIN processing_step s ON s.owner_id=a.owner_id AND s.id=a.step_id
JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id
WHERE e.kind='verification' AND t.run_id IN ($ALL_RUNS)
ORDER BY t.run_id, e.created_at;"
```

Q4 结构拒绝（未进入核验的 2 条，期望 `status=rejected, disposition=structure_rejected`，2 条且 `fields.subject=self`、来源 2 条）：

```sh
sqlite3 "file:$DB_R2?mode=ro&immutable=1" "
SELECT json_extract(e.payload,'\$.status') status,
       json_extract(e.payload,'\$.disposition') disposition, count(*) n
FROM execution_event e
JOIN step_attempt a ON a.owner_id=e.owner_id AND a.id=e.step_attempt_id
JOIN processing_step s ON s.owner_id=a.owner_id AND s.id=a.step_id
JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id
WHERE e.kind='parse' AND t.run_id IN ($ALL_RUNS)
GROUP BY 1,2;"
```

Q5（可选）用脚本复跑四维表与逐候选明细（输出只含结构字段）：

```sh
python3 /tmp/rejection_classify.py   # 结果另存 /tmp/rejection-result.json
```

完整聚合 SQL 另见 `/tmp/rejection_counts.sql`（四维计数交叉核对）与 `/tmp/rejection_verify.sql`（去重 + 总拒绝数）；两者已在基线与 R2 两库上跑通，数字与本文件及文档小节一致。

## 7. 歧义与剩余风险

1. **拒绝口径混合**：`stage_result.rejected` 是「解析结构拒绝 + 核验未准入」的总和（`flow.ts:185-198`），不是纯核验拒绝。R2 的 9 中 2 条为解析结构拒绝。R3 若继续用「rejected」比较，建议固定为：总量报 `stage_result.rejected`，细分报 `verification` 事件，结构拒绝单列；否则 4→7 与 4→9 两种口径会混用。
2. **归属维度来源**：被拒候选无 `memory_candidate` 行，归属取候选 `before.subject`；`shared` 按产品口径并入 contact 范围（1 条）。若未来要求单列 `shared`，该 1 条需从「联系人」拆出（R2 为 6 → 5 + 1）。
3. **主体被拒的精确子原因未落库**：`subject` issue 可能来自 attribution facade 不通过、scope 不匹配、actor 未知、resolution=unresolved 或 `groundedAttribution` 失败；本次 5 条（及基线 3 条）除 `groundedAttribution` 外的条件均满足，故只能记到「程序侧主体定位校验（groundedAttribution）不通过」层级，具体子条件（引文重复、人称词不匹配、候选 span 越界等）不在事件里；若需精确，需用存档 `model_claim_check` + 消息窗口做离线重放（本次不做，避免读取正文落盘）。
4. **样本小**：拒绝 4 vs 9、候选 22 vs 24，拒绝率的组间差异不足以做统计判断；「新增拒绝集中在合并候选」是按边际计数，基数变化（合并候选占比 13/22→19/24）是主要解释之一。
5. **两副本状态不同**：基线副本与 R2 副本来自不同时间备份，比较的是同窗口重提取的对照；若两副本的窗口内容等价前提发生变化，计数不可直接对比。
6. **未覆盖**：`verification` 事件之外的模型失败（`model_failure` / `verification_validation_failure`）不计入本次拒绝细分；本次目标 run 的拒绝全部由上述三路（continue / 核验拒绝 / 结构拒绝）解释，无剩余。

## 8. 代码位置（口径依据）

- 拒绝累计与三路去向：`backend-ts/src/memory/extraction/flow.ts:185-198`（legacy 流程：`rejected=parsedRejections`，未准入核验再 `rejected++`；`verification_contract` 落 `rejected_count`）。R2 的 disposition 取值（`uncertain`→`unverified_rejected`）对应 `flow.ts:190-191`。
- 候选输出/解析/低价值丢弃：`flow.ts:145-160`；解析结构拒绝规则：`backend-ts/src/memory/extraction/protocol.ts:123-158`。
- `stage_result.rejected` 落库：`backend-ts/src/memory/sqlite/execution.ts:195`。
- issue 生成与准入：`backend-ts/src/memory/extraction/verification/complete-claim.ts:163-197`；subject issue 的来源包括 `complete-claim.ts:186-192`。
- 发送者兜底：`complete-claim.ts:115-130`。
- 主体定位校验 `groundedAttribution`：`complete-claim.ts:131-162`。
- 归属范围口径：`backend-ts/src/memory/extraction/multimodal.ts:27`（`shared` 属 contact 范围）；核验期望 scope：`complete-claim.ts:189`。
