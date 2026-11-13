# 证据 07：易歧义结构代码层兜底（任务 C 级别 3，离线验证）

日期：2026-11-06。执行者：ambiguity-guard（队友）。边界：**0 次外发、未调用模型**；4 份 SQLite（合成探针库 `rx-r3-probe`、真实窗口存档副本 `rx-userdata` 基线 / `rx-userdata-r2` / `rx-r3-retest`）均以 `sqlite3 "file:...?mode=ro&immutable=1"` 只读打开；未写真实库、未 git add/commit。本文只含计数与结论，不含聊天正文、姓名或可识别 ID。

## 1. 改动点与原因码

| 位置 | 改动 |
| --- | --- |
| `backend-ts/src/memory/extraction/ambiguity-guard.ts:1-107` | 新增确定性规则模块：`AMBIGUITY_UNCONFIRMED='memory_ambiguity_unconfirmed'`、`ambiguitySignal()`（字面规则）、`unconfirmedAmbiguity()`（仅 alternatives 为空时生效） |
| `backend-ts/src/memory/sqlite/management/adjudication-actions.ts:84-87` | 裁决领取 `freeze()` 前置门槛：命中即 `fail('memory_ambiguity_unconfirmed')`，不建立裁决步骤、不发起模型调用 |
| `backend-ts/src/memory/sqlite/management/adjudication-actions.ts:251` | `claim` 捕获新码：写执行事件（kind 同名、payload 含 candidateId）并保持候选待确认；原 `memory_conditions_pending` 留痕路径改为共用 `recordCandidateGate()`，语义不变 |
| `backend-ts/src/memory/sqlite/management/actions.ts:143-146` | 系统自动采纳入口（`applyDecision`）同一兜底：**只在 system=true 且无裁决授权时生效**（`system&&!authority`），命中即降级，执行事件 payload 附 rule/token；用户手动决定（`memory.applyDecision`，system=false）不经过该分支 |
| `backend-ts/src/memory/sqlite/management/actions.ts:230` | `memory.publishRun` 捕获新码，候选保持待确认（原三个 pending 码不变） |
| `backend-ts/src/memory/sqlite/management/read.ts:30-31` | 待确认派生：`execution_event` 新 kind 映射为 `pendingStage='decision_pending'`、`pendingReason='memory_ambiguity_unconfirmed'`；`memory_conditions_pending` 映射不变 |
| `backend-ts/test/sqlite-memory-ambiguity-guard.test.mjs:1-111` | 新增 12 条测试（规则 6 条 + 集成 6 条，含手动决定不被拦截） |

规则（保守、可解释、只降级不删除）：

- 数量词省略单位：独立阿拉伯数字/中文大数，其后没有单位/量词、前导不是函数词/标点/空白、±6 字内也没有类别词时命中；`985/211/996` 等固定数字、年份、日期时间、字母数字混排、带单位或邻近类别词的数字不命中；另含「多赚点/换点钱」一类无单位模糊数量（子集）。
- 指代词无同条所指：正文中第三人称代词在没有唯一先行词（0 个或 ≥2 个不同人物）时命中；正文含 1 个唯一人物、`他（弟弟）` 这类显式注释、`其他/他人` 等词不命中；解释字段保留原话代词且正文出现 ≥2 个人物时也命中（覆盖合并后仍没消解指代的情形）。
- `alternatives` 非空一律不命中，保持既有放行与 `adopted_with_alternatives` 留痕逻辑；不改变任何已有原因码语义。

## 2. 合成探针（10 个合成窗口：5 真两读 T1–T5 + 5 细节没说 D1–D5）

| 指标 | 原始候选口径 | 进入候选口径 |
| --- | --- | --- |
| 候选数 / alternatives 非空 | 10 / 3 | 7 / 1 |
| 真两读且 alternatives 为空 | 2（对象省略型 1、指代身份型 1） | 2（同上两条，均曾被自动采纳） |
| **真两读空 alternatives 捕获率** | **2/2（100%）** | **2/2（100%）** |
| 真两读窗口最终受保护（alternatives 非空或兜底命中） | 5/5 | 3/3 进入窗口 |
| 细节没说窗口 / 候选 | 5 / 5 | 4 / 4 |
| **细节没说误报率（命中数）** | **0/5（0%）** | **0/4（0%）**，低于 20% 目标 |
| 误报明细 | 无 | 无 |

说明：T1/T2/T4 的 alternatives 已由现提示保留，兜底不需要也不应二次标注；真正漏掉保护的正是 T3（对象省略型）与 T5（指代身份型），本次两条都命中。T5 的正文在合并时已被改写成「给哥哥」，但解释字段仍保留原话「先给他了」且正文出现两个人物，规则由此命中。

## 3. 真实窗口存档（2026-03-30 10:22–10:42 窗口，隔离副本，只读）

| 副本（口径） | 候选数 | alternatives 非空 | 命中数 | 命中率 | 命中中 alternatives 非空 |
| --- | --- | --- | --- | --- | --- |
| 基线（进入候选） | 18 | 6 | **0** | 0% | 0 |
| R2（进入候选） | 15 | 0 | **2** | 13.3% | 0 |
| R3（进入候选） | 10 | 0 | **0** | 0% | 0 |
| **进入候选合计** | **43** | 6 | **2** | **4.7%** | **0** |
| 基线（原始候选） | 22 | 7 | 1 | 4.5% | 0 |
| R2（原始候选） | 24 | 1 | 2 | 8.3% | 0 |
| R3（原始候选） | 27 | 2 | 1 | 3.7% | 0 |
| **原始候选合计** | **73** | 10 | **4** | **5.5%** | **0** |

- 命中候选状态：进入候选口径 2 条均为 `pending`（R2 已知真歧义信号），已采纳（`adopted`）候选命中 **0/8**；原始候选口径 4 条中 3 条命中已知真歧义信号族，1 条为「他们」指代（该原始候选已被核验拒绝、未进入候选）。
- 与已知真歧义信号对照：R2 的 4 条信号代理文本（数字族 2 + 收入族 2）中，兜底命中 2 条（数字族 1：独立数字无单位；收入族 1：多赚点）；未命中的 2 条经复核不是真正两读（1 条是院校层次编号、1 条是「工资高」的主观判断，均无省略数量单位）。R3 的数字族/收入族对应原始候选命中 1 条（该 run 未发布、未进入候选）。
- **误伤评估（进入候选口径）：0/43 观察到误伤**；2 条命中即 R2 报告中丢失保护的两条真歧义候选，属于期望拦截。原始候选口径 1/73 为边界误伤（「他们」的所指在窗口内可能唯一，但该候选已被核验拒绝，不进入采纳路径）。

## 4. 测试与检查

- 新增 `backend-ts/test/sqlite-memory-ambiguity-guard.test.mjs`：**12/12 通过**。覆盖：真两读空 alternatives 在裁决领取前降级为待确认且不发起裁决调用；发布入口（自动路径）同样降级；**用户手动采纳（system=false）不被兜底拦截、仍按原逻辑写入**；细节缺失但合并已补全（带单位）不降级；alternatives 非空不降级并保留 `adopted_with_alternatives`；普通候选回归。
- 回归：`sqlite-memory-adjudication-evidence` + `sqlite-memory-adjudication`、`-model-port`、`-unknown-recovery`、`-deletion` **35/35**；`extraction-protocol` + `extraction-flow` **18/18**；`sqlite-memory-auto-profile`、`sqlite-memory-candidate-history`、`sqlite-memory-content-availability`、`sqlite-memory-dsh-flow`、`extraction-policy-version` **13/13**。
- `npx tsc --noEmit` 通过。
- 已知存量失败（与本改动无关，已在 HEAD 无本改动时复现）：`sqlite-memory-candidate-admission` 3 条（旧 source_stamp 2 条、跨 memory 1 条）。

## 5. 边界、风险与上线建议

- 建议**上线为兜底**：确定性、0 外发、只降级不删除、不改变已有原因码；真实窗口进入候选口径触发率 4.7% 且 0 误伤，探针细节没说误报 0%。**手动决定不受影响**：兜底只作用于自动路径（system=true 且无裁决授权），用户在待确认卡片上「采纳原稿/修改并采纳」仍走 `memory.applyDecision`（system=false），不会被 `memory_ambiguity_unconfirmed` 拦截。
- 限制：真实样本仅一个联系人/一个窗口的 43 条逻辑候选，不能替代多窗口/多联系人误报率；规则刻意保守，只覆盖两类字面结构的子集，漏检（如指代消解不确定但没有代词线索、非金额数量省略）仍走原有核验/裁决，不会被兜底放大；指代规则依赖解释字段，若上游提示不再在解释里保留原话代词，T5 类捕获会下降。
- UI 文案缺口（未改，属其它任务未提交文件）：原因码映射在 `desktop/src/renderer/SqliteMemoryManagementPanel.tsx:36-54`，该文件当前被用户/其它任务占用，本任务未触碰；新码在界面会走未知码兜底文案「处理原因未知（memory_ambiguity_unconfirmed）」。建议该文件释放后补一行中文文案。后端 `pendingReason` 已透传（`desktop/src/main/memory/sqlite-management.ts:41`）。
- 回滚方式（不涉及数据迁移）：删除/还原 `backend-ts/src/memory/extraction/ambiguity-guard.ts` 及上述 4 个源码文件的引用与判断即可回到原行为；已产生的 `memory_ambiguity_unconfirmed` 执行事件与待确认状态不影响正文，可保留（仅展示原因），也可随候选按既有删除路径清理。本任务未 git add/commit，回滚即 `git checkout --` 这 4 个源码文件并删除新模块与测试。
