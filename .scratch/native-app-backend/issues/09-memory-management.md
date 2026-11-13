# 09 — 记忆管理（含 pending 候选确认）

Type: task

**Triage:** ready-for-agent
**State:** resolved

**What to build:** 用户在管理页查看所选联系人的关系记忆列表（正文、分类、主题、采纳标记与有效期），手动录入、修正与删除记忆；低置信的 pending 候选第一次可以人工处理：确认走与自动采纳相同的落库裁决路径并标 `manual`，丢弃使候选失效并计入删除指纹。

**Blocked by:** 05（主窗口骨架）

- [x] 记忆列表只返回当前联系人范围内 active、有效期内且仍有有效来源的关系记忆；列表含正文。
- [x] 手动录入标 `manual`（支持联系人级与 owner 级）；删除记忆后其文本指纹阻止自动复活，手动录入不受限。
- [x] pending 候选确认后成为 `manual` 记忆；丢弃后候选失效，重复提取不再自动采纳同一文本。
- [x] 记忆修正产生版本演变语义，与既有写入裁决一致；撤销后检索不可见。
- [x] 集成测试覆盖确认、丢弃、删除指纹、有效期与 owner 隔离；API 契约测试钉住 JSON 结构。

## Comments

- 来源规格：`.scratch/native-app-backend/spec.md`。
- pending 候选确认是本规格新增能力（此前未实现），落库裁决路径沿用既有写入裁决与删除指纹机制。
- 手动录入修复了既有 CLI `memory-add` 的联系人级缺陷（其 source_ids 指向 contact_id 无法通过来源校验）；新增迁移 025 允许 `manual` 来源类型并复用同一来源过滤。

## Answer

- 后端新增记忆管理端点（真实 HTTP 路径）：
  - `GET /api/contacts/{id}/memories` 联系人级记忆列表（含正文、分类、主题、采纳标记、状态、修订）；只返回 active、有效期内且仍有有效来源的记忆。
  - `GET /api/contacts/{id}/memory-candidates` pending 候选列表。
  - `POST /api/contacts/{id}/memory-candidates/{cid}/confirm` 候选确认（采纳方式标 `manual`）；`.../discard` 候选丢弃（reject 路径，候选失效）。
  - `POST /api/memories/manual-contact` / `manual-owner` 手动录入；`GET /api/memories/owner` owner 级列表；`.../correct` 修正；`.../delete` 删除（软删除保留文本指纹）。
- 新增 `application/memory_service.py` 薄服务与 `MemoryPort.create_manual_candidate`：手动录入联系人级时在同一事务创建 `manual` 来源 + 候选，再经既有确认路径落库（修复 CLI memory-add 无法通过来源校验的缺陷）；删除指纹阻止自动复活由既有 `deleted_texts` 保证。
- 新增迁移 `database/migrations/025_manual_memory_source.sql`（source_type 约束加入 `manual`）。
- Swift 主窗口右栏新增「记忆管理」页：手动录入（文本 + 分类 + 联系人级/owner 级）、待处理候选（确认/丢弃）、联系人记忆与 owner 记忆列表（分类/采纳标记/修订、删除）。
- 验证：Python 全量 594 项通过（新增 MemoryService 单测 7 项、API 契约 14 项、整链集成 3 项、store 集成 11 项）；`swift build` 与探针 `swift test` 21 项通过；真实 HTTP 冒烟手动录入联系人级/owner 级与列表通过。
- 双轴 code-review（Standards + Spec）修复：丢弃候选计入删除指纹（`discard_candidate_with_fingerprint` 同事务写 deleted 指纹行，adoption 据此拦截同文本复活，含集成测试）；CLI `memory-add` 联系人级改用 `create_manual_candidate`（修复其 source_ids 无法通过来源校验的既有缺陷）；有效期字段暴露（`valid_at`/`invalid_at` 进 JSON 与 Swift 模型）；Swift 记忆行增加「修正」入口（版本演变语义）；移除测试专用 `candidate_id_factory` 与重复声明的端口协议（复用 `memory/ports.py`）。
- 数据影响：测试使用合成 UUID/`_test` 库；新增迁移 025 只放宽 CHECK 约束，不触碰数据。
- 剩余风险：真实微信渠道下低置信候选的产生依赖提取链路（既有能力）；记忆管理页 UI 未做分页；owner 级记忆的修正入口未做（仅联系人级，后端无 owner correct 端点）。
