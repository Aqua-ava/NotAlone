# 05 — 短期时效记忆自动过期

**What to build:** 给短期有效的关系记忆（临时状态、近期日程、短期安排）一个可推算的失效时间，到期后自动不参与检索与回复，替代"永久保留"或"一律不存"。检索层已支持按 `invalid_at` 过滤（`contact_memory_index`、`owner_memory_store._is_effective`），本票补的是提取口径与验证：模型按 occurred_at 推算短期记忆的失效时间并填写，只有真正长期有效的事实才留空。

**Triage:** ready-for-agent
**State:** resolved
**Blocked by:** 无

- [x] 待用户决策口径：哪些类型必须带短期有效期（临时状态、当天/次日日程、短期安排）；"还没吃饭"这类秒级状态是否仍不值得存
- [x] 提取提示词给出可泛化的推算规则，不按句子特判
- [x] 合成用例：短期与长期记忆各若干条，过期后不出现在检索与回复依据
- [x] 与上一轮时间维度既有口径（invalid_at 只在消息明确说明失效时间时填写）的修订记录进放行台账

## Comments

- 来源：真实找错发现"联系人还没吃饭""用户明天有面试"这类短期信息被自动采纳并永久保留；用户提出"过两天没有意义的东西应该打个时间节点"。
- 现状：`valid_at`/`invalid_at` 已在落库与检索过滤中生效，过期的记忆不再参与检索；缺口在提取时对短期记忆的失效推算，以及"哪些类型必须带时效"的口径确认。
- 与票 01 的关系：提示词整合时保留本条所需字段口径，不预设结论。
- 2026-10-05：用户明确选择「存，但到期自动失效」——短期信息仍入库，但必须带可推算的失效时间，到期后自动退出检索与回复。据此确认口径：临时状态、当天／次日日程与短期安排必须带有效期；「还没吃饭」这类瞬时状态仍可入库，但有效期不超过当天；只有真正长期有效的事实才留空。本次修订（原口径为「invalid_at 只在消息明确说明失效时间时填写」）须记入放行台账。`Triage` 由 ready-for-human 改为 ready-for-agent、`State` 由 open 改为 claimed，开始实现。
- 2026-10-06：口径、提示词、schema、用例与文档口径均已落地（`0c4575a`，两轴审查修复见票 11 的复核修订），四条验收全部落实，`State` 改为 `resolved`；依据见下方 Answer。**仍未做真实模型评测**，模型是否遵守新推算规则未验证，这一项由票 03 的评测预算决定承接。

## Answer

**已完成**（提交 `0c4575a`，本地，无远端推送）：

1. **口径已由用户拍板**（2026-10-05）：短期信息仍入库但必须带可推算的失效时间；临时状态、当天／次日日程与短期安排必须带有效期；瞬时状态（如「还没吃饭」）仍可入库但有效期不超过 `occurred_at` 当天；只有真正长期有效的事实才留空。
2. **提示词与 schema 给出可泛化规则**：`src/notalone/memory_extraction/adapters.py` 的 `invalid_at` 段（第 90 行起）按来源 `occurred_at` 自带 UTC 偏移推算「当天／次日／本周」，来源缺失、naive 或无法核实时不推算、留空；`EXTRACTION_SCHEMA` 的 `valid_at`／`invalid_at` description 同步同一口径。两轴审查发现的歧义（「该日」既可指 `occurred_at` 当天也可指日程所指日期）已改为「取该日程所指日期的次日零点（当地）」，并用 `tests/unit/memory_extraction/test_expiry_prompt_contract.py` 先红后绿钉住新表述、断言旧歧义表述不再出现。没有按句子特判的规则，也没有按分类给固定 TTL 的确定性兜底（有意不做，理由见票 11 复核修订）。
3. **合成用例与可判别性**：`evaluation_cases.py` 时间维度新增「短期：次日日程」「短期：当天瞬时状态」「长期：稳定习惯留空有效期」三条，并把「临时借住」「出差中」补成必须填失效时间，用例总数 120 → 123。离线验证过判别性：短期用例在 `invalid_at` 留空时 `validity_ok=False`、填了可推算失效时间时通过；长期用例相反。瞬时状态用例原句曾逐字复用提示词内联举例，已换成不同措辞（`test_semantic_evaluation_cases.py` 新增断言防止再次特判）。
4. **过期退出检索**：过滤在数据层已生效并保持不变——`contact_memory_index.py` 的查询条件为 `memory.invalid_at IS NULL OR now() < memory.invalid_at`（第 626、680 行），`owner_memory_store._is_effective` 同口径；本票未改写检索语义，只补提取口径。行为由既有测试钉住：`tests/integration/persistence/test_contact_memory_index.py` 的 `test_rebuild_filters_expired_memories_and_caps_topics`（过期记忆不入索引）与 `tests/unit/reply/test_context_retrieval.py` 的 `test_expired_memory_with_invalid_at_never_enters_the_reply_basis`（过期记忆不进入回复依据，但记忆本身仍在库里）。
5. **修订记录已入台账与现行文档**：口径修订记在票 11 的「复核修订（2026-10-05 短期时效口径）」与「复核修订（2026-10-05 两轴审查修复）」；`architecture/current/domain-data.md` 第 127 行新增实现状态条目，明确「模型遵守率尚未实测、当前没有确定性兜底」。`can_auto_adopt`、0.7 置信度门槛、风险白名单、语用与核验规则、输出协议字段本轮零改动。

**验证（本票收口时实际运行）**：`python -m unittest discover -s tests/unit -t .` 931 项全部通过（含 `test_expiry_prompt_contract.py`、`test_semantic_evaluation_cases.py`）；过期过滤路径由既有检索与索引测试覆盖。

**限制（如实保留）**：① **模型遵守率未验证**——只证明提示词与 schema 写了规则、评测口径能区分输出，不证明 `ecnu-max` 会照做；未跑 `notalone-memory-evaluate --dimension time`，因此短期记忆仍可能被永久保留。② 「这两天」「这几天」这类模糊期间的推算仍靠模型，无统一行为保证。③ `valid_at` 继续不参与自动采纳判断，短期事实若给出未来 `valid_at` 仍按既有 `pragmatic:future_validity` 进待确认。

**后续归属**：模型遵守率验证需要 `NOTALONE_EVALUATION_API_KEY` 评测预算，范围与上限见[按维度放行的评测预算提案](../../../docs/memory-dimension-release-evaluation-proposal-20261005.md)（`time` 维度 24 条、上限 48 次），由票 03 的预算决定承接；未批准前不读凭据、不联网、不运行评测。

**数据影响**：只改提示词文本、schema 描述与合成用例；未连接数据库、未读取 `.env` 或真实聊天、未写入业务记忆、未运行真实模型。
