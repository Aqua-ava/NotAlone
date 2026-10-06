# 06 — 记忆界面展示备选解释与短理由

**What to build:** 让用户在待确认候选上看到「为什么判成这样」：把提取结果已携带的 `alternatives`（备选解释）与 `interpretation_reason`（短理由）持久化到候选，并在 API 与 macOS App 的待确认列表里展示，供用户在确认或否决前判断。只做展示与读取，不改动采纳门、语用判定或候选正文。

**Triage:** ready-for-agent
**State:** open
**Blocked by:** 无（票 02 已结，展示入口已存在）

- [ ] 备选解释与短理由随候选落库（迁移 + 持久化层），保留来源与删除路径，不复制聊天原文以外的新内容
- [ ] 待确认候选 API 返回这两个字段；无值时不返回空壳字段，界面按缺失处理
- [ ] App 待确认列表展示备选解释与短理由；缺失或读取失败时 fail-closed，不伪造理由
- [ ] 测试覆盖：确认／否决后理由仍可追溯；字段缺失、为空与超长文本的展示边界
- [ ] 复核确认这不改变「候选必须带未确认标注」的既有口径（票 02 的展示策略不变）

## Comments

- 来源：2026-10-06 用户选择「要展示，另开一张票实现」。现状是 `ExtractedFact` 已带 `alternatives` 与 `interpretation_reason`（`src/notalone/memory_extraction/models.py:104-105`），落在运行结果里；`architecture/current/pragmatic-interpretation.md` 第 72 行把「结构化的备选解释和短理由……完整记忆管理界面展示」记为后续工作；`macos_app` 的 `MemoryCandidateEntry`（`BackendModels.swift:249`）目前只有正文、分类、主体、置信度、风险与时间字段，没有这两项。
- 实现要点（待实现时确认）：候选表目前无对应列，需要一条新迁移；`MemoryCandidate`（`src/notalone/memory/models.py`）需要新增字段并在采纳／落库路径保留；App 侧沿用票 02 的 `ReplyEvidencePresentationPolicy` 分层思路，把「理由如何呈现、缺失如何降级」放进纯函数并补单测。
- 边界：理由与备选来自模型输出，属**模型自述**，不得展示成已确认事实或证据；展示不得扩大检索范围，也不得让未确认候选进入已确认资料轨。
