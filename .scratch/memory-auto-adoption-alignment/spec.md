# 记忆自动采纳对齐腾讯方案：实施规格

Status: 已实现（2026-11-06，提交 460fdf5d5／f0ad57a41／dee12e2f5／49b7b5f46／fefa2e75c）。真实小批：R1 因产品层重裁决入口缺失 0 外发（30 次额度保留，缺口待用户决策）；R2 17/20 次外发，4 指标中 2 达标 2 未达，独立判定 outcome=unknown（见 `docs/verification/memory-auto-adoption-alignment-20261106.md` 与待决策清单）。未达「已实现并验收」，R3 未授权
Triage: ready-for-human
创建：2026-11-06
依据：真实联系人副本实测（见第 2 节）、本机腾讯源码快照 `/Users/local-user/Documents/learn/TencentDB-Agent-Memory`（commit `6a4bb55`）

> 本文只含计数、原因码、代码位置与规则，不含联系人姓名、聊天正文或可识别 ID。示例一律抽象描述。

---

## 1. 目标与边界

### 1.1 目标

候选记忆产生后，**默认自动变成正式记忆**（`adoption_mode=auto`，带来源、可查看、可撤销）。「待确认」只留给系统确实无法自行取舍的少数情形，而不是模型诚实标注不确定、或检查规则过严的副产品。

### 1.2 为什么对齐腾讯

腾讯的链路是「提取 → 去重/合并 → 写入」，没有人工确认环节：

- 提取提示（`MemoryCore/src/core/prompts/l1-extraction.ts`）：
  - 第 31 行附近「宁缺毋滥」：过滤琐碎闲聊、一次性指令。
  - 「独立完整」：记忆必须离开当前对话仍成立。
  - 「归纳合并」：强关联的多条消息合并成一条完整记忆，不碎片化。
  - 用 `priority` 打分，低于阈值直接丢弃（偏好 <50、事件 <60、指令 <70）。
- 去重（`MemoryCore/src/core/prompts/l1-dedup.ts:34-38`）：只有 `store / skip / update / merge` 四个动作，全部自动落地。

结论：腾讯把「不确定」放在**提取之前和之中消化**（不提、合并、打分丢弃），而不是提取之后拦下来问人。

### 1.3 不能对齐的部分（保留）

NotAlone 比腾讯多一层**来源核验**（正文是否有原话支持、说话人归属是否正确），这是产品硬边界（来源可验证、联系人隔离），**不在本规格范围内放宽**。核验未通过的候选根本不成为候选（`unverified_rejected` / `unsupported_rejected`），它们不属于「待确认」。

### 1.4 不做的事

- 不删除或绕过来源核验、主体归属、人工保护、删除路径。
- 不让一次性回复策略成为长期偏好。
- 不改真实库，不外发聊天内容；真实模型验证只在隔离副本上做，且走问题预算账本。
- 默认不改数据库表结构；若第 2 步标记落点需要迁移，须先回到用户确认。
- 外部聊天发送不是本任务范围。

---

## 2. 实测证据（隔离副本、真实模型）

数据范围：一位联系人，2026-03-30 10:22–10:42 纯文字窗口（副本由 `prepare-rx.sh` 从真实库备份生成）。

### 2.1 本轮候选去向

| 项 | 数量 |
|---|---|
| 候选总数 | 18（联系人范围 4，用户本人范围 14） |
| 自动采纳 | 1 |
| 待确认 | 17 |

### 2.2 17 条待确认的真实原因

| 条数 | 原因 | 性质 |
|---|---|---|
| 8 | 没有任何拦截条件，只是该轮 16 次请求额度用完，裁决未发出 | 运行额度，不是规则 |
| 6 | 提取时模型把「细节没说」写进 `alternatives`，被前置门槛拦下，未进裁决 | 提示与门槛不匹配 |
| 3 | 已进裁决；模型判 `add / independent / claim_changed=false`，核验 `supported=true`，仍因证据覆盖规则被判 `memory_relation_pending` | 检查规则过严 |

### 2.3 对前一版结论的更正

此前口头解释称这 3 条是「与已有记忆相关但不独立」。**这是错的。** 读取存储的模型输出后确认：

- 裁决：`action=add`，`relation.kind=independent`，`claim_changed=false`，`condition_changed=false`，解释为「与所列旧资料主题和事实均无关，属全新独立事实」。
- 关系核验：`supported=true`，`claim_changed=false`，`condition_changed=false`。
- 失败点：`adjudication-actions.ts` 的 `relationCovered`（第 150-156 行）要求关系核验的证据对 `related_memory_ids` 中**每一条旧记忆**至少引用一条其来源原文。模型把参与比较的 5 条旧记忆都列进 `related_memory_ids`（它们实际无关），核验证据又只引用了候选自己的原话，于是覆盖检查必然失败。

即：对「独立」关系，要求引用无关旧记忆的原文，本身不可满足。

### 2.4 上一次（3 月后半段，含图片）样本

19 条候选：3 采纳、16 待确认，其中约 7 条标为关系核验类。是否同属 2.3 的覆盖检查误拦，**尚未核对**，是第 3 步的首个任务。

---

## 3. 总体方案与执行顺序

用户确认的四步，加上 2.3 发现的根因，对应关系如下。推荐执行顺序按「改动小、可离线验证、收益大」排列，与步骤编号不同：

| 推荐顺序 | 规格步骤 | 一句话 | 是否需模型调用验证 | 是否改规格 |
|---|---|---|---|---|
| ① | 步骤 3.1 | 修复「独立关系」的证据覆盖误拦 | 否（离线重放存储输出） | 小改（第 7 节） |
| ② | 步骤 3.2–3.4 | 裁决动作对齐腾讯四个动作 | 否（离线重放）→ 小批真实 | 要 |
| ③ | 步骤 2 | 「备选解读」等前置门槛由拦截改降级 | 否 → 小批真实 | 要 |
| ④ | 步骤 1 | 提取提示对齐腾讯 | 是（新预算） | 否 |
| ⑤ | 步骤 4 | 待确认原因白名单、界面口径、规格与 ADR | 否 | 要 |
| ⑥ | 验收 | 同窗口重跑，独立 Agent 判定 | 是 | — |

同一组文件同一时间只让一个 Agent 写。`adjudication-actions.ts` 被步骤 2、3 共同改动，必须串行。

---

## 4. 步骤 1：提取提示对齐腾讯（宁缺毋滥、独立完整、归纳合并）

### 4.1 要解决的问题

6 条被拦的候选中，约 2/3 的 `alternatives` 内容是「某动作的具体对象本窗未提到」，这是**信息缺失**，不是**两种读法**。现行 schema 描述（`backend-ts/src/memory/extraction/prompts.ts:150`）只说「其他实质歧义只能列来源支持的解释」，模型把缺失细节也当歧义填入。结果是模型越诚实越被拦。

### 4.2 改动点

文件：`backend-ts/src/memory/extraction/prompts.ts`

1. `relationshipExtractionContract`（第 10 行）追加三条原则，措辞沿用腾讯骨架并适配我们的主体/来源约束：
   - **宁缺毋滥**：寒暄、一次性指令（「这次」「本单」）、没有后续价值的零碎感叹，不输出。
   - **独立完整**：每条记忆离开当前对话仍能读懂；一句话离开上下文无法判断动作对象或所指事项时，先与相邻消息中**同一话题**的前后句合并成一条完整记忆；合并后仍无法独立成立则不输出。合并必须保留原话人物称呼、否定、条件，来源 ID 列全。
   - **归纳合并**：同一话题的连续多句（因果、前因后果、同一计划的几个侧面）合并为一条，不拆成碎片。
2. `alternatives` 的 schema 描述（第 149-150 行）改写，明确二分：
   - **填**：同一句话有两种以上**来源直接支持**的不同读法（例如数字既可能是年龄也可能是金额）；指代身份无法唯一确定（保留现有「必须非空」要求）。
   - **不填**：只是细节没提到（动作对象、范围、原因没说）。这类应通过「合并相邻句」补全，补不全就不输出该条，**不得**用 `alternatives` 记录。
3. `confidence`（第 81 行）描述追加：低价值或含糊的零碎表达给低分（建议 <0.5）。

不改：`bounded.ts:39` 的 `AMBIGUITY_NOTE`（原文指代无法唯一确定）。那是真歧义，由核验链路产生，保持现状。

### 4.3 可选的代码层兜底（第二阶段，本步骤不强制）

腾讯用 `priority` 阈值丢弃。我们已有 `confidence`。若提示改动后低价值候选仍多，可在 `protocol.ts:138` 解析处加最低置信度阈值，低于阈值的候选记录 `low_value_dropped` 执行事件后丢弃。**注意**：丢弃不得使该批次或水位判为未完成，实施前先读水位推进逻辑并写测试；阈值数值需用户定（建议起点 0.5，与腾讯偏好类阈值一致）。

### 4.4 联动检查

- `verification/complete-claim.ts:66` 与 `multimodal.ts:12,25` 的字段清单包含 `alternatives`，字段本身不变，只是预期更少为非空。逐字段核验的提示无需改。
- 提示文本变化会改变 `policyFingerprint`/策略版本。读 `backend-ts/test/extraction-policy-version.test.mjs`，按其约定更新版本，避免旧结果被误当新策略结果复用。

### 4.5 测试与验证

- 单元：`extraction-protocol.test.mjs`、`extraction-flow.test.mjs`、`extraction-policy-version.test.mjs`；新增一条用例断言提示含新增原则与新的 `alternatives` 描述（结构断言，不断言模型行为）。
- 真实：按第 8 节预算，同窗口（2026-03-30 10:22–10:42 文字）在 `prepare-rx.sh` 新建的副本上重提取。
  - 对照基线（本轮）：22 条原始候选，其中 `alternatives` 非空占比约 1/3（6/18 进入候选后）。
  - 通过标准：`alternatives` 非空占比明显下降；真歧义的两类样本（数字含义、收入对象）仍被保留为非空；候选总数不因「合并」而过度减少；核验的主体被拒数不上升。
  - 局限：提取输出非确定、单样本、窗口小，只作方向性证据，须由独立 Agent 判定。

---

## 5. 步骤 2：前置门槛由「拦截」改为「降级」

### 5.1 现状

候选在进入裁决前，`adjudication-actions.ts:78`（`freeze`）与 `actions.ts:129`（手动/系统路径）用同一组条件抛 `memory_conditions_pending`：

1. `memoryTimeEligibility !== 'eligible'`
2. `fact.alternatives` 非空
3. `fact.conditions.items` 中有 `source_supported !== true`
4. `fact.event` 存在且 `stage_verified` 为假，或 `occurrence_verified` 为假且 `occurrence_start` 非空

命中任一条，候选不进裁决，直接待确认。

### 5.2 新规则

| 条件 | 新处理 | 理由 |
|---|---|---|
| 时间不合格（1） | 保持拦截 | 涉及晚导入不得覆盖较新状态，是数据正确性 |
| `alternatives` 全为 `AMBIGUITY_NOTE`（未决指代） | 保持拦截 | 真歧义，所指不唯一 |
| `alternatives` 含其他自由文本 | **降级：继续裁决，允许自动采纳** | 腾讯无此门槛；步骤 1 之后残留的多是真两读，但已经由逐字核验背书 |
| 条件无来源支持（3） | 保持拦截 | 条件改变命题含义（「如果…就…」），无依据即可能错记 |
| 事件时间未核实（4） | **对齐现行规格第 4 条：丢弃事件标注、记 `time_unverified`、正文继续** | 现行规格已写，代码仍整体拦截，属实现与规格不一致，需先核对 |

### 5.3 「降级」的含义

自动采纳照常发生，`adoption_mode=auto`，同时留下**不确定性痕迹**，使其不会被当成毫无保留的事实：

1. 正文：提取提示已要求保留不确定性，采纳正文原样保留。
2. 执行事件：采纳时在事件 payload 记录 `adopted_with_alternatives`（保留的 `alternatives` 原文）。**默认只改 payload 内容，不加表、不加列。**
3. 若要在记忆管理页或回复里标「低把握」，需要持久字段。实施前先读 `memory_version`（`provenance_state` 等）与 `execution_event` 的类型约束，再选：
   - 方案 A（默认）：只记事件 payload，界面通过追踪查看。
   - 方案 B：新增持久标记列，需要迁移与删除闭包核对，**须回到用户确认后再做**。

### 5.4 改动点

- `adjudication-actions.ts:78`：把单个 `if(...) fail('memory_conditions_pending')` 拆成逐条判断；`alternatives` 判断改为「是否含 `AMBIGUITY_NOTE`」。常量需从 `extraction/bounded.ts:39` 导出，避免复制字符串。
- `actions.ts:129`：系统路径同样拆分，行为与上面一致；手动采纳路径（用户亲自点采纳）不受此门槛约束，保持现状。
- 采纳写入处（`actions.ts` 的 `auto_accept` 分支）带上 `adopted_with_alternatives`。
- 事件时间：先写一条失败用例复现「事件未核实时整体被拦」，再对齐规格第 4 条。

### 5.5 测试

- 新增或扩展 `backend-ts/test/sqlite-memory-dsh-flow.test.mjs` 用例：
  - 自由文本 `alternatives` → 进入裁决并自动采纳，payload 含 `adopted_with_alternatives`。
  - `AMBIGUITY_NOTE` → 仍 `memory_conditions_pending`。
  - 条件无来源 → 仍拦截。
  - 事件未核实 → 采纳但无事件标注，记 `time_unverified`。
- 回归：已有 `sqlite-memory-adjudication-evidence.test.mjs` 全绿。

### 5.6 风险

模型把真正的两读句子填了自由文本，被降级放行。缓解：来源核验仍逐字有效；记忆标 `auto` 可撤销；`adopted_with_alternatives` 可追溯。接受该残留风险需用户确认。

---

## 6. 步骤 3：裁决动作对齐腾讯四个动作

腾讯：`store`（新增）/`skip`（无增量）/`update`（更好或纠错）/`merge`（互补）。我们的动作：`add / keep / noop / update / merge`，关系：`independent / supplement / state_change / error_correction / historical_supplement / unresolved_conflict`。问题不在动作种类，在于**自动条件过窄**。

### 6.1 首要任务：核对并修复「独立关系」覆盖误拦（根因）

- 位置：`adjudication-actions.ts:150-156`（`relationCovered`）与 `:173`。
- 现行为：对 `relation.related_memory_ids` 中每一条，若该旧记忆有可用来源，则关系核验证据必须引用其中至少一条来源消息。
- 问题：`independent` 关系下，模型按提示（`adjudication-dsh.ts:171`）把比较池全部列入 `related_memory_ids`，核验自然只引用候选原话。
- 改法：
  - `relation.kind==='independent'`：只要求 `evidenceSupported` 为真，且证据至少引用一条候选来源；**不**要求覆盖旧记忆来源。
  - 其他关系类型（补充、状态变化、纠错、历史补充）：保持现状覆盖要求，因为这些确实声称与某条旧记忆存在具体联系。
- 先做的核对（只读、不调用模型）：对 2.2 的 3 条和 2.4 的约 7 条，读存储的 `adjudication_output` 与关系核验输出，按新规则重算原因，统计有几条会由 `memory_relation_pending` 变为自动采纳。结果写入本目录 `evidence/`（仓库外私有目录保存明细，仓库内只留计数）。

### 6.2 `keep`（相关并存）

- 现行为：`add` 与 `keep` 一律要求 `independent` 且 `claim_changed=false` 且 `condition_changed=false`（`:175-177`）。
- 问题：`keep` 的定义就是「相关但应并存」，模型给出的关系类型往往是 `supplement` 或 `historical_supplement`，必然被判待确认，等于 `keep` 永远不能自动。
- 改法：`keep` 允许 `independent | supplement | historical_supplement`，仍要求两个 `changed` 均为假；`state_change / error_correction / unresolved_conflict` 仍走各自分支或待确认。对应腾讯的 `store`。

### 6.3 `noop`（重复，对应腾讯 `skip`）

- 现行为：`:195-198` 要求候选与旧记忆在正文、分类、主题、主体、有效期、事件、条件、来源 ID 集合**全部逐字相同**，否则 `memory_duplicate_pending`。
- 问题：同一事实换个说法就不算重复，只能待确认，而腾讯的 `skip` 判断是「无增量或更模糊」。
- 改法：当模型判 `noop`、`duplicate_memory_id` 指向一条 `auto` 且未受保护的旧记忆，两个 `changed` 均为假，且旧记忆正文不比候选更少信息时，自动 `noop`；候选的新来源并入旧记忆的来源集合（若现有来源模型不支持追加，则只记执行事件 `skipped_duplicate`，不改旧记忆）。
- 实施前必读：`actions.ts` 的 `auto_noop` 分支和来源绑定逻辑，确认「并入来源」是否已有安全实现；没有就走仅记事件的最小版本。
- 人工保护的旧记忆不适用，仍待确认。

### 6.4 `update` / `merge`

- `update`：`:178-182` 的限制（候选或旧记忆有事件/条件、有效期不同时转 `memory_timeline_pending`）是防止时间线被错误覆盖，保持。
- `merge`：已经要求 `supplement` 且合并核验通过，保持。
- 这两个动作本轮不扩大。

### 6.5 仍保持待确认的关系

- `unresolved_conflict`：真实矛盾，系统无法取舍（现行规格第 3 条已写）。
- 关系核验 `supported=false`，或 `related_memory_ids` 含不在比较池中的 ID，或两处 `claim_changed/condition_changed` 不一致：说明模型自相矛盾，保持。
- 多目标（`memory_multiple_targets_pending`）、受保护目标（`memory_protected`）：保持。
- 图片参与比较（`memory_media_relation_pending`）：现行规格第 7 条已缩窄，保持。

### 6.6 提示侧补充（`adjudication-dsh.ts:169-181`）

在裁决提示追加一句：当 `relation.kind=independent` 时，`related_memory_ids` 只需列出被比较的旧记忆 ID，无需也不应为它们编造关联。同时不改变 schema，避免破坏已存结果的可重放性。

### 6.7 测试

- `sqlite-memory-adjudication-evidence.test.mjs` 增加：
  - `independent` + 证据只引候选来源 → 自动采纳。
  - `supplement` 关系的 `add/keep`：`keep` → 自动采纳；`add` 且非独立 → 仍待确认。
  - `noop` 同义不同字面 → 自动 `noop`；对受保护旧记忆 → 待确认。
  - `unresolved_conflict` → 待确认。
- 离线重放：用副本里存储的两类输出对 2.2、2.4 样本重算，报告「改前/改后」原因分布；不调用模型。

---

## 7. 步骤 4：待确认只留给真正需要人的情形

### 7.1 白名单

规则调整后，待确认只应出现在下面这些情形（原因码保持现有，便于追踪）：

| 原因码 | 含义 | 处理 |
|---|---|---|
| `memory_conditions_pending`（仅 AMBIGUITY_NOTE、时间不合格、条件无依据） | 数据正确性 | 保留 |
| `memory_relation_pending`（仅 `unresolved_conflict`、核验不支持、模型自相矛盾） | 真矛盾或不一致 | 保留，并拆出更细原因码 |
| `memory_multiple_targets_pending`、`memory_protected` | 涉及人工保护或多目标 | 保留 |
| `memory_timeline_pending` | 时间线覆盖风险 | 保留 |
| `memory_media_relation_pending` | 候选自带图片或主题无法证明无关 | 保留 |
| `memory_merge_pending`、`memory_duplicate_pending` | 合并/重复核验未通过 | 保留，范围随 6.3 缩小 |
| `memory_relationship_pending`（`actions.ts:126-127`） | 系统路径缺少授权的更新/重复，或同范围已有记忆而自动新增 | 先读逻辑，确认是否与 6.2 冲突后再定 |

### 7.2 拆分原因码

`memory_relation_pending` 现在混杂至少四种成因（真矛盾、证据覆盖、核验不支持、ID 不一致）。拆成独立原因码，便于以后看分布：

- `memory_relation_conflict`
- `memory_relation_evidence_incomplete`
- `memory_relation_unsupported`
- `memory_relation_inconsistent`

实施时需同步：`adjudication-actions.ts` 的 `reason=` 赋值、前端对原因码的文案映射（`desktop/src/renderer/SqliteMemoryManagementPanel.tsx`、`TracePanel.tsx`）、以及依赖原因码的测试。旧数据里已存的原因码不迁移，界面对未知码走兜底文案。

### 7.3 把「运行未完成」从「待确认」里分开

2.2 里 8 条是额度用完、未发裁决。它们不需要人决定，却和真待确认混在同一个列表。要求：

- 未裁决（无 `adjudication_result`）且无拦截条件的候选，在界面上标「处理中/未完成」，而不是「待确认」。
- 触发处理的入口使用现有「放弃未知调用并重试」，不新增后台能力。
- 实施前读两个面板的列表分组逻辑，确认候选状态字段（`memory_candidate.state`）能否区分，不能区分则由查询层派生，不改表。

### 7.4 规格与 ADR

- 新增 ADR-174《对齐腾讯方案：不确定性降级而非拦截》，状态「提议」，用户确认后改为「已采纳」。写明：决定、被替代的现行规则、残留风险、回退方式。
- 修改 `architecture/current/memory-processing.md`：
  - 第 26 行（默认自动路径）：补充「`alternatives` 中自由文本不新增人工审核门」。
  - 第 28 行（关系未知或未解决矛盾可保留待定）：限定为 `unresolved_conflict`、核验不支持、模型自相矛盾。
  - 新增一条说明独立关系的证据覆盖规则与 `keep/noop` 的自动条件。
  - 第 32 行附近第 7 条不变。
- 修改 `docs/agents/domain.md` 引用（如有章节索引变化）。
- 规格只在对应步骤**实现并验收**后改为「已实现」，之前保持「已采纳未实现」，沿用 ADR-173 的做法。

---

## 8. 验证与预算

遵循 `docs/agents/quality-diagnosis.md`：每轮只验证一个假设，共用一个问题级总账，每轮由独立 Agent 判断。

### 8.1 离线（不调用模型，先做）

| 内容 | 方法 | 通过标准 |
|---|---|---|
| 6.1 覆盖误拦 | 对 2.2 的 3 条、2.4 的约 7 条用存储输出重算 | 误拦条目转为自动采纳；其余原因分布不变 |
| 6.2–6.3 | 单元测试 + 重放 | 新用例全绿；已有 `sqlite-memory-*` 套件无回退 |
| 5.x 降级 | 单元测试 | 四类条件行为如 5.2 |

### 8.2 真实小批（新预算，仅隔离副本）

| 轮次 | 假设 | 对象 | 预计额度 |
|---|---|---|---|
| R1 | 步骤 3+2 落地后，同一批 18 个已存候选重新裁决，待确认显著下降 | 现有副本重跑裁决（放弃未知并重试） | 约 30 次，含 8 条未裁决补跑 |
| R2 | 步骤 1 落地后，同窗口重提取，`alternatives` 非空占比下降且真歧义仍保留 | `prepare-rx.sh` 新建副本，同窗口 | 约 16–20 次 |
| R3（可选） | 合并后的整条链路：提取→核验→裁决→L2/L3 | 同窗口全流程 | 约 40 次 |

- 每轮开始前在账本记录：问题 ID、唯一改动、预期信号、对照基线。
- R1 与 R2 不并行，避免互相污染副本。
- 账本与预算工具在仓库外私有目录，沿用 `quality-diagnosis.md` 的「准备总账管理工具」。

### 8.3 判定指标

1. 待确认占比：本轮基线 17/18（≈94%）。目标：不含真矛盾与真歧义后，残留应只剩个位数条或更少。
2. 自动采纳的归属正确率：由独立 Agent 抽查，核对主体与说话人，不要求用户逐条看。
3. 不得回退：已自动采纳的不丢失；核验被拒数不上升；`auto` 记忆均有来源且可撤销。
4. 预估（待验证，非结论）：8 条补跑裁决、3 条覆盖误拦、6 条中的约 4 条在步骤 1 后不再产生，则本批待确认可降至约 2–4 条；真实数据以实测为准。

### 8.4 报告口径

汇报分别列出：工程完成度、目标质量是否改善、是否可启用、已用/剩余预算、仍未解决的真实失败。合成测试、离线重放、真实模型三类证据分开写，不互相替代。

---

## 9. 任务拆分（供按 `docs/agents/issue-tracker.md` 建单）

文件归属说明：同一时间一个 Agent 写同一文件。

| 编号 | 标题 | 主要文件 | 前置 | 验证 |
|---|---|---|---|---|
| 01 | 核对并修复独立关系证据覆盖误拦 | `sqlite/management/adjudication-actions.ts`、`adoption/adjudication-dsh.ts` | 无 | 离线重放 + 单元 |
| 02 | `keep` 与 `noop` 自动条件对齐 | `adjudication-actions.ts`、`management/actions.ts` | 01 | 单元 |
| 03 | 前置门槛降级（`alternatives`、事件时间） | `adjudication-actions.ts`、`management/actions.ts`、`extraction/bounded.ts`（导出常量） | 02 | 单元 + R1 |
| 04 | 提取提示对齐腾讯 | `extraction/prompts.ts`、（可选）`extraction/protocol.ts` | 无，但与 03 的真实验证错开 | 单元 + R2 |
| 05 | 原因码拆分、界面口径、规格与 ADR-174 | 两个前端面板、`architecture/current/memory-processing.md`、`architecture/adr/174-*.md` | 01–03 | 视图测试 + 桌面验收 |
| 06 | 同窗口重跑与独立判定、验收记录 | `docs/verification/…`（只含计数与原因码） | 01–05 | R1–R3 |

桌面类验收（任务 05 的界面部分）使用 `pnpm run dev` 热更新实例，不打包、不运行打包版。

---

## 10. 回退与风险

| 风险 | 缓解 | 回退 |
|---|---|---|
| 降级放行后，模型对真歧义句判断错误被写入 | 来源核验不变；记忆为 `auto`、可撤销；payload 留 `adopted_with_alternatives` | 在 `actions.ts` 恢复拦截分支；已采纳记忆可批量撤销 |
| `independent` 覆盖放宽，被模型误判「独立」而漏掉重复/矛盾 | 仅放宽证据覆盖，`kind`、`claim_changed` 等判断不变；`unresolved_conflict` 仍拦 | 恢复 `relationCovered` 原判断 |
| 提示改动让候选总数大幅减少 | R2 设候选数下限的观察，不设自动通过标准 | 恢复提示并回退策略版本 |
| `noop` 放宽导致来源丢失 | 6.3 先走仅记事件的最小版本 | 恢复逐字相同条件 |
| 前端口径改动影响现有测试 | 原因码旧值保留兜底 | 回退文案映射 |

---

## 11. 待用户确认

1. **规格变更**：同意 `alternatives` 自由文本由拦截改为降级（第 5 节），并同意据此修改现行规格与新增 ADR-174。
2. **标记落点**：「低把握」标记默认只记事件 payload（方案 A）；是否需要持久字段（方案 B，会涉及迁移）。
3. **最低置信度阈值**：4.3 是否启用代码层兜底，起点 0.5 是否可以。
4. **预算**：R1 约 30 次、R2 约 16–20 次；是否按此授权（沿用「新预算、仅隔离副本、独立 Agent 判定」）。
5. **清理**：本次 L2/L3 验证用到的副本与临时文件，在 R1/R2 完成前保留；完成后再清理。
