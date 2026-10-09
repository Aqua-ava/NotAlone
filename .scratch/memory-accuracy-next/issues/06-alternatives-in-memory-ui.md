# 06 — 记忆界面展示备选解释与短理由

**What to build:** 让用户在待确认候选上看到「为什么判成这样」：把提取结果已携带的 `alternatives`（备选解释）与 `interpretation_reason`（短理由）持久化到候选，并在 API 与 macOS App 的待确认列表里展示，供用户在确认或否决前判断。只做展示与读取，不改动采纳门、语用判定或候选正文。

**Triage:** ready-for-agent
**State:** resolved
**Blocked by:** 无（票 02 已结，展示入口已存在）

- [x] 备选解释与短理由随候选落库（迁移 + 持久化层），保留来源与删除路径，不复制聊天原文以外的新内容
- [x] 待确认候选 API 返回这两个字段；无值时不返回空壳字段，界面按缺失处理
- [x] App 待确认列表展示备选解释与短理由；缺失或读取失败时 fail-closed，不伪造理由
- [x] 测试覆盖：确认／否决后理由仍可追溯；字段缺失、为空与超长文本的展示边界
- [x] 复核确认这不改变「候选必须带未确认标注」的既有口径（票 02 的展示策略不变）

## Comments

- 来源：2026-10-06 用户选择「要展示，另开一张票实现」。现状是 `ExtractedFact` 已带 `alternatives` 与 `interpretation_reason`（`src/notalone/memory_extraction/models.py:104-105`），落在运行结果里；`architecture/current/pragmatic-interpretation.md` 第 72 行把「结构化的备选解释和短理由……完整记忆管理界面展示」记为后续工作；`macos_app` 的 `MemoryCandidateEntry`（`BackendModels.swift:249`）目前只有正文、分类、主体、置信度、风险与时间字段，没有这两项。
- 实现要点（待实现时确认）：候选表目前无对应列，需要一条新迁移；`MemoryCandidate`（`src/notalone/memory/models.py`）需要新增字段并在采纳／落库路径保留；App 侧沿用票 02 的 `ReplyEvidencePresentationPolicy` 分层思路，把「理由如何呈现、缺失如何降级」放进纯函数并补单测。
- 边界：理由与备选来自模型输出，属**模型自述**，不得展示成已确认事实或证据；展示不得扩大检索范围，也不得让未确认候选进入已确认资料轨。

## Answer

**已完成**（本地，无远端推送）：

1. `MemoryCandidate` 新增 `alternatives` 与 `interpretation_reason`，提取结果在进入待确认候选时完整保留；内存存储与 PostgreSQL 存储均可在确认后按原候选读取，否决路径也保留字段。
2. 新增迁移 `038_memory_candidate_interpretation.sql`，在 `memory_candidate` 保存备选解释数组和可空判断依据；API 只在有值时返回这两个字段，不为缺失值制造空壳字段。
3. macOS 待确认列表和回复依据卡片展示「判断依据」与「备选解释」；空值不展示，内容按展示层上限截断，仍保持「未确认 · 仅供参考」标注，不改变采纳、检索或确认／否决流程。
4. 补充模型生命周期、提取传递、API 缺失值、PostgreSQL 往返、确认后追溯及 macOS 展示边界测试。

验证：

- `python -m unittest discover -s tests/unit -t .`：937 项通过。
- `tests.integration.server.test_memory_api` 与迁移测试：29 项通过。
- 全新隔离 PostgreSQL 测试库执行 001–038 迁移后，`test_postgres_memory_store`：16 项通过；未修改现有未接管的 `notalone_test`。
- `swift test --package-path macos_app`：82 项通过。
- 改动的 4 个 Python 源文件 `mypy` 通过，`git diff --check` 通过。

限制：理由与备选解释仍是模型自述，未被提升为事实证据；本机完成 Swift 编译和 Core 策略测试，未进行 macOS App 人工点击验收；旧数据库需先按迁移流程应用 038，迁移工具会拒绝无接管记录的旧库。

## Comments

2026-10-06：用户确认后在本机 `notalone_dev` 执行 037、038 迁移。迁移前完成 PostgreSQL 16 自定义格式备份并校验，迁移后账本已到 038；171 条既有候选数量未变，旧候选的 `alternatives` 为空数组、`interpretation_reason` 为空值。进程内 API 读取返回 200；当前联系人没有待确认候选，因此未进行真实界面点击验收。Swift Debug 构建与展示策略测试通过。
