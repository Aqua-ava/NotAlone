# 删除逐条消息选择与排除功能

状态：方案，待实现
基线：`d144bf102d43f812a8ec75033a2bf4ed7ffa1dbf`

## 用户问题

表达工作区默认已经会使用当前联系人最近的有效聊天，但界面上仍提供逐条消息勾选和“排除本次消息”能力。该能力让用户必须理解、操作和维护另一套选择状态，却没有实际使用价值；用户要求删除逐条消息选择，让最近最多 50 条自动进入本次上下文。

本次同时要求清理关联的前端、后端、测试和现行文档，不保留“这次排除某条消息”的产品能力。

## 已确认行为

1. 表达工作区不显示逐条消息的“使用消息／不使用消息”勾选框。
2. 不显示“已排除 N 条消息”提示，不提供恢复被排除消息的操作。
3. 默认行为仍是：关系背景开启时，自动使用当前联系人最近最多 50 条有效消息。
4. “最近聊天 · 查看／补充”和“刷新最近聊天”可以保留，用于查看和补充上下文；消息列表只读，不参与逐条选择。
5. 关系背景关闭时，最近聊天、旧讨论、关系记忆和关系文档仍全部不带入；本次不改变这个总开关。
6. 本次不改变最近 50 条上限、消息排序、来源资格、联系人隔离、关系资料预算、Skill 预算和删除语义。
7. 不保留“排除消息后停用派生关系资料”的分支，因为新请求不再存在排除状态。

## 范围决定

### 保留

- “参考最近聊天和相关关系资料”关系背景总开关。
- 最近聊天列表和刷新入口，但列表只读。
- 最近 50 条消息的读取和展示能力。
- 当前候选生成、来源冻结、关系资料检索、候选编辑和手动发送边界。

### 删除

- `excludedMessageIds`／`excluded_message_ids` 在前端状态、IPC、HTTP、后端工作区和请求指纹中的字段。
- 逐条消息勾选框、排除提示、排除状态变化时的候选继续保护分支。
- 排除消息对最近聊天、关系资料召回和来源联系人集合的影响。
- 相关测试、现行规格和用户说明中的排除功能描述。

### 不删除

- 历史候选、历史请求和历史运行记录。旧数据保持可回看、可删除，不因本次改动自动清理。
- 历史 ADR。旧 ADR 只增加“部分被 ADR-165 替代”的说明，不回写成从未存在。
- 数据库表结构。当前排除信息只存在于工作区 JSON／指纹中，没有独立 SQLite 列。

## 实现决定

### 1. 工作区合同

- SQLite 工作区形状改为：

  `action + draftText + tone + instruction + contextText + includeRelationshipContext`

- 删除 `excludedMessageIds` 字段及其 UUID、数量、去重校验。
- 工作区指纹从 `version: 1` 升为 `version: 2`，明确区分不含排除字段的新合同。
- 新请求中包含旧字段 `excludedMessageIds` 或 `excluded_message_ids` 时，按输入无效拒绝，不静默忽略。
- `carriedSelectionId` 仍只能在关系背景开启时携入；删除原来基于排除数组的额外限制。

### 2. 当前 SQLite 候选链路

涉及文件：

- `backend-ts/src/reply/sqlite/candidates/workspace.ts`
- `backend-ts/src/reply/sqlite/candidates/http.ts`
- `backend-ts/src/reply/sqlite/candidates/turns.ts`
- `backend-ts/src/reply/sqlite/candidates/input.ts`
- `desktop/src/shared/sqlite-reply-candidates.ts`
- `desktop/src/renderer/SqliteReplyCandidatesPanel.tsx`

行为调整：

- `readReplyWorkspace` 只接受新工作区字段。
- `finishInput` 读取最近消息时删除“按排除 ID 过滤”的步骤；关系背景开启时直接使用最近 50 条。
- `freezeReplyInput` 的 `includeRelatedData` 只取决于关系背景开关，不再取决于是否存在排除消息。
- `replySourceContacts` 不再因排除消息跳过关系资料和携入选稿来源。
- HTTP 层拒绝旧字段，避免旧客户端把排除语义发送到新服务。
- 前端默认请求不再构造 `excludedMessageIds: []`；刷新最近聊天只刷新只读列表。
- 逐条消息列表不再渲染 checkbox；关系背景总开关仍保留。
- “以此版本继续”只在关系背景关闭时禁用，不再检查排除列表。

### 3. 旧桌面回复链路

涉及文件：

- `desktop/src/shared/reply-bridge.ts`
- `desktop/src/main/reply/bridge.ts`
- `desktop/src/main/reply/client.ts`
- `desktop/src/main/reply/pasted-input.ts`
- `desktop/src/main/reply/session.ts`
- `desktop/src/renderer/UnifiedReplyWorkspace.tsx`
- `desktop/src/renderer/ReplyGenerationGuidance.tsx`

这些路径同样不得再显示逐条勾选或发送排除字段。`pasted-input` 只保留一项必要的兼容拒绝：

- 历史载荷中出现 `excluded_message_ids` 时，不恢复为可比对的新输入，也不把它静默当作空数组；
- 返回明确的“旧输入使用了已退役的消息排除设置，请重新发起请求”。

这不是恢复功能，而是防止旧请求在删除功能后突然扩大资料范围。

### 4. 兼容与隐私

- 旧请求中可能存在用户主动排除的敏感消息。升级后不能把旧请求按“无排除项”重新发送，否则会静默把这些消息重新带入模型。
- 旧请求只能保留状态查询、候选回看和删除路径；不能继续生成。
- 新请求使用新的工作区指纹版本，旧请求重试会得到输入冲突，不会命中旧请求重放。
- 历史请求 JSON 中的旧字段可以作为不可执行的遗留数据保留；如用户要求清理历史字段，另立破坏性数据迁移任务并单独确认。
- 不新增数据库迁移；不改变联系人范围、读取授权和删除闭包。

### 5. 文档

实现时新增 `architecture/adr/165-remove-message-exclusion.md`，记录：

- 删除逐条消息排除的原因；
- 保留关系背景总开关和最近 50 条；
- 旧请求不可在新语义下重试；
- 旧资料保留、不静默扩权。

同步更新：

- `architecture/current/reply-generation.md`
- `architecture/current/core-flows.md`（只改排除功能相关表述）
- `README.md`
- `backend-ts/src/reply/sqlite/candidates/README.md`
- ADR-079 顶部增加被 ADR-165 部分替代的说明

`docs/history/**`、旧 ADR 正文和旧验收记录不删除，作为历史记录保留；旧描述不能作为当前行为依据。

## 测试 Seam

使用现有公开边界，不测试私有实现：

1. 当前 SQLite 候选 HTTP／工作区合同：新请求没有排除字段时生成成功，关系背景开启时最近最多 50 条按原顺序进入请求。
2. 当前 SQLite 候选 HTTP／工作区合同：请求携带 `excludedMessageIds` 或 `excluded_message_ids` 时被拒绝，且不创建请求、不调用模型。
3. 前端表达工作区：刷新最近聊天后没有逐条 checkbox，没有排除提示，生成命令不包含排除字段。
4. 关系背景开关：关闭时不带最近聊天和关系资料；开启时自动带最近聊天；原有 50 条上限不变。
5. 继续候选：关系背景开启时可直接继续，不再因排除数组被禁用。
6. 旧桌面回复桥：历史排除载荷不被静默接受，返回明确错误；旧候选项仍可回看。
7. 回归：来源冻结、联系人隔离、关系资料预算、删除和手动发送行为不变。

## 验收标准

- 全仓新增代码不再产生逐条消息选择状态。
- 当前 SQLite 入口和旧桌面入口都没有消息级勾选框或排除提示。
- 新请求的 workspace 契约没有 `excludedMessageIds`／`excluded_message_ids`。
- 关系背景开启时，最近最多 50 条自动进入本次请求；关闭时全部不带入。
- 旧排除请求不会被静默重发或扩大到原排除消息。
- 相关类型检查、后端测试、桌面测试和实际开发 App 交互验证通过。
- 文档只保留历史替代说明，不再把逐条排除写成当前能力。

## 不在范围

- 删除关系背景总开关。
- 改变最近 50 条的数量、排序或上下文预算。
- 删除历史候选、历史请求、旧讨论或用户资料。
- 修改 DSH Skill 加载策略、两次模型调用行为或模型供应商。
- 修复后台 SQLite 长查询造成的 30 秒生成前延迟；该项属于独立的性能任务。
- 打包、推送远端、创建 PR 或发送外部消息。

## 风险与回滚

- 风险：旧请求含敏感排除项，删除字段后直接重试会扩大出站资料范围。通过旧字段拒绝和工作区指纹版本隔离处理。
- 风险：旧客户端仍发送排除字段。新服务明确拒绝，不静默退化。
- 风险：同时存在旧桌面回复链路和当前 SQLite 链路导致行为不一致。两侧使用同一验收矩阵分别验证。
- 回滚：保留数据库和历史载荷不动；恢复旧客户端合同和 UI 即可回滚新请求，不需要数据迁移。

## 实施顺序

1. 先改工作区合同和当前 SQLite 后端，补旧字段拒绝和 50 条默认行为测试。
2. 改当前 SQLite 前端，移除逐条 checkbox、排除提示和请求字段。
3. 改旧桌面回复链路，补历史载荷兼容拒绝。
4. 更新现行文档、ADR-165 和历史替代说明。
5. 运行最小相关验证，再做实际开发 App 检查；按工作流创建只包含本任务变更的本地提交。

## 备注

本规格只定义方案，不触发代码、数据库、真实资料或模型请求。工作区当前有与本任务无关的既有改动，实施时只提交本任务路径，不带走 `desktop/src/renderer/SqliteMemoryManagementPanel.tsx`、`desktop/tests/sqlite-memory-management-view.test.mjs` 或 `.scratch/new-reply-discussion-isolation/**`。
