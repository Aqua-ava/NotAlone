# 03 — 按维度放行自动采纳的准则与实现

**What to build:** 把评测达标签接入自动采纳：只有评测证明可靠的维度（如本轮的主体、改写保真）允许该类事实自动采纳，其余安静待确认；放行记录可追溯，回退简单。前置：任务 10 的模型对照与提示词整合结果。

**Triage:** ready-for-agent
**State:** claimed
**Blocked by:** 无（10、01 已结）

- [x] 维度判定键落在候选上（主体/时间/转述/指代/保真/媒体），不改变现有 0.7 与风险白名单语义
- [x] 放行表与回退开关可配置，默认只放行已验证维度（本轮默认放行表=空集）
- [x] 达标签由评测工具输出（`summarize`）直接生成，不手写
- [x] 放宽门槛的准则文档化：达到"至少 15 条、假事 0、记错人 0、一般错误 ≤1"才允许新增一类

## Comments

- 2026-10-05：机制部分实现完成（默认空放行表、门槛口径对齐、可回退）。新增
  `src/notalone/memory_extraction/dimensions.py`：`dimension_key` 只用受控字段
  判定（带有效期→`time`；`assertion`+`asserted` 且主体 self/contact→`subject`；
  其余确认陈述→`truth_intent`；其他一律 `None`＝不放行）。`paraphrase`／
  `reference`／`media`／`reported` 缺必要字段、当前不可推导，已在代码注释、
  ADR-036 与放行台账写明，即使达标也不能放行。`MemoryAdoption` 增加构造参数
  `dimension_release`（默认读 `NOTALONE_MEMORY_DIMENSION_GATE`，只有显式 `0`
  才关闭门），维度放行是独立第 4 道合取项，原有三道语义未改。`summarize().meets_gate`
  对齐 ADR-027 第 2 条，语义标注覆盖改为单独报告字段。新增 ADR-036、放行台账
  `docs/memory-adoption-dimension-release-ledger.md`，并在 ADR-033 末条显式记录
  被 ADR-036 修订。**未运行任何真实评测**（需另批预算与用户批准，见
  `docs/memory-dimension-release-evaluation-proposal-20261005.md`）；因此当前没有
  任何维度放行，全部候选待确认，直到新证据产生并逐类获批。

- 2026-10-05：用户明确选择「只有测准的类型自动记」——自动采纳从整体一刀切改为按评测放行维度：达到门槛的维度才允许自动采纳，未达标签的维度安静待确认；放行表与回退开关可配置，默认只放行已验证维度。门槛沿用本票既有准则（至少 15 条、假事 0、记错人 0、一般错误 ≤1），放行结论必须由评测工具输出而非手写。`State` 由 open 改为 claimed，开始实现；未达标签维度不因本票放宽门槛。
- 2026-10-05：勘察发现两处必须先处理的冲突，已向用户说明并取得路线决定。①**ADR-033（2026-10-02 采纳，晚于 ADR-027）在「取舍与边界」明确写「不以旧去向达标签替代语义准确率，不放宽门槛或接入维度自动放行」**，与本票的「接入维度放行」直接冲突；②现有评测工具的 `meets_gate` 额外要求「该维度全部用例都带语义标注且语义场景 ≥15」，与 ADR-027 第 2 条的达标签口径不一致，按现行代码**没有任何维度能达标**，而放行台账里「主体／改写保真达标签」是 2026-09-15／16 的旧口径结论。用户据此选择 **A + B′**：默认放行表先置空（严格合规，不沿用旧台账数字），同时准备评测方案并把准确调用次数报给用户批准，跑出达标签维度后再逐类放行。因此本票实现顺序为：先做机制与门槛口径对齐（默认空放行表、可回退），再另批评测产生放行证据；实现时须新增 ADR 记录 ADR-033 该条被本次决定修订，且不得用旧数字充当新证据。
- 2026-10-06：**票面现状核对（本轮只读核对与推进说明，未改代码）**。①四条验收里三条已落实：维度判定键 `dimension_key` 只用受控字段（`dimensions.py:91`）、默认空放行表与 `NOTALONE_MEMORY_DIMENSION_GATE=0` 回退（`dimensions.py:108` 起）、达标签由 `summarize().meets_gate` 输出（`evaluation.py:339`）、门槛口径「用例数 ≥15、假事 0、记错人 0、一般错误 ≤1」写进 ADR-036 与[放行台账](../../../docs/memory-adoption-dimension-release-ledger.md)。②第 1 条验收（六类维度键）当前只覆盖 `subject`／`time`／`truth_intent` 三类，`paraphrase`／`reference`／`media`／`reported` 因提取结果缺结构化字段**当前不可能放行**——这是本票已披露的缩减，不是新遗漏，要放行需先补字段（另立 ADR 与迁移）。③**本票不能标 `resolved` 的原因**：实际放行数为 0，放行一个维度需要「可推导 + 评测达标签 + 预算获批 + 用户逐类批准」，后两项都还没发生；[评测预算提案](../../../docs/memory-dimension-release-evaluation-proposal-20261005.md)（档 A ≤80 / 档 B ≤168 / 档 C ≤280 次）仍待用户拍板。未批准前不读凭据、不联网、不运行评测。④因此当前生产行为是：所有通过原有三道门槛的候选一律走 `_create_pending_candidate` 安静待确认，`AdoptedStats.adopted` 不增加。`State` 保持 `claimed`，等待预算决定。
- 2026-10-05：两轴只读审查完成，发现并已修复的问题：**①放行路径空转（硬性）**——`from_environment()` 只回传 `gate_enabled`、把 `allowed` 丢掉，而台账规定的放行操作正是改 `DEFAULT_DIMENSION_RELEASE`，照做在生产永不生效（且 `adoption.py` 里那次导入根本没被使用）。已改为先取该常量的放行集再叠加运维开关，并补端到端测试（打补丁改默认值后，默认构造的 `MemoryAdoption` 真的自动采纳）与"默认值类型非法即报错"测试。**②现行规格漏更（硬性）**——`domain-data.md`、`core-flows.md`、`pragmatic-interpretation.md`、`CONTEXT.md` 与 `README.md` 仍写"满足置信度与风险门槛即自动写入"，已全部补上第 4 道门与 ADR-036 指针。**③误导字段**——`semantic_gate_cases` 恒为常量且无人读取，已删除；并在 ADR-036 与预算提案里写明"达标签只是必要条件，标注覆盖不足时不能据此放行"。**④重复逻辑**——`None → from_environment()` 的解析在 `adoption.py` 与 `worker.py` 各写一份，已收敛为 `DimensionRelease.resolve()`，并明确生产只传 `None`、注入是测试接缝。**⑤命名歧义**——3 门的 `can_auto_adopt` 与 4 门的 `MemoryAdoption._can_auto_adopt` 同名异义，后者改名 `_passes_all_adoption_gates`。**⑥维度串漂移**——新增测试断言"运行时键集合 ⊆ 评测维度串集合、且差集恰为评测专用的 `condition`／`quantity`"，防止枚举与评测集再次漂移。**仍如实保留的未完成项**：验收第 1 条要求的六类维度键当前只覆盖 3 类（`subject`／`time`／`truth_intent`），`paraphrase`／`reference`／`media`／`reported` 因缺结构化字段**当前不可能放行**，要放行需先补字段（另立 ADR 与迁移）——这是本票已披露的缩减，不是遗漏；`time` 维度放行只覆盖带有效期的候选，口径已记入台账。验证：单元 931 项通过、相关集成 20 项通过、mypy 在改动模块无新增问题。
