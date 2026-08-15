# 领域与数据契约

> 状态：已采纳的产品约束；云端 PostgreSQL 是权威业务库，具体字段类型和表结构仍待实现时确定。

## 核心原则

1. 每次回复请求由用户明确选择一个联系人，服务端不得根据消息正文、昵称或历史猜测联系人。
2. 所有联系人范围的读写均先以 `owner_id + contact_id` 过滤，再做内容检索或排序。
3. 原始资料、规范化消息、模型候选资料、已采纳关系资料和表达样本必须分层保存。
4. 长期资料必须保留来源、证据类型、创建时间、采纳状态和删除入口。
5. 即使部署初期只服务一个用户，也必须显式持久化 `owner` 与 `owner_id`，以保证数据隔离和未来多用户演进不需要迁移核心数据模型。

## 数据对象

| 对象 | 必要职责 | 关键关联 |
| --- | --- | --- |
| `owner` | 资料所属用户。 | `owner_id` 是所有私密数据的第一层隔离键。 |
| `owner_preference` | 用户（owner）自身的全局偏好、表达习惯与通用禁忌，跨联系人生效。 | 属于 owner，不绑定 `contact_id`；与联系人常驻卡一起进入生成上下文。 |
| `contact` | 用户手动创建或选择的具体联系人。 | 稳定 `contact_id`；昵称、备注是可变展示字段。 |
| `conversation_binding` | 用户确认的桌面聊天会话与联系人的绑定。 | 保存聊天 App、账号范围、会话定位线索、绑定状态与最近验证时间；不能仅用昵称自动匹配。 |
| `source_document` | 一次原始导入的文本、截图或语音原始引用。 | 属于一个联系人；保留来源定位、导入时间、删除状态。 |
| `session_capture` | 前台会话同步中一次画面变化产生的端侧 OCR 来源记录。 | 已归属时显式冗余 `owner_id + contact_id` 并关联 `conversation_binding`；记录 `capture_mode`（live/user_backfill）与连续性状态；未归属时为仅含 `owner_id` 的临时态（见隔离与查询约束）。云端只保存最小化的文本来源与解析状态，默认不保留或上传原始视觉帧。 |
| `background_task` | 一次完整的长时后台工作，取代独立的导入/删除/重建任务表。 | `type` 区分 import/delete/reindex；`scope` 声明作用域（account/contact/source）；状态为 `queued/running/verifying/succeeded/failed/cancelled`，记录总体进度、失败原因、重试与关联来源。删除任务不得跨越隔离边界。 |
| `background_task_step` | `background_task` 下可恢复、可重试的固定执行步骤。 | 关联父任务并保存 `step_type`、顺序、状态、尝试次数、输入/输出业务引用、错误分类和 Worker 租约；不保存完整聊天正文。只用于确实需要逐步恢复或展示进度的长任务。 |
| `message` | 统一的规范化文字消息。 | 显式冗余 `owner_id + contact_id`，并保存说话人、可用时间戳；来源字段（`source_document` 或 `session_capture`）仅用于定位与删除，不承担隔离过滤。 |
| `memory_candidate` | 模型或规则从资料中提取的待采纳关系线索。 | 关联证据消息；不能被检索为已知事实。 |
| `confirmed_memory` | 自动采纳或手动录入的共同事实、偏好、禁忌、关系资料。 | 关联一个或多个来源证据、采纳方式（auto/manual）、删除状态、分类、有效期与常驻标记（`carry`）。 |
| `style_sample` | 用户明确同意保存的最终表达样本。 | 关联联系人及其产生的回复请求；不是普通候选回复。 |
| `reply_skill` | 可按场景选择的聊天套路目录项。 | 属于 owner，可全局适用或限定一个联系人；只保存名称、简述、`when_to_use`、状态和当前版本。 |
| `reply_skill_version` | 一次不可变的聊天套路正文。 | 保存目标、步骤、禁忌、示例和 `allowed_tools`；v1 只允许 `inline` 且 `allowed_tools` 为空。 |
| `reply_request` | 一次面向已选联系人的表达生成请求。输入可以是对方的当前消息，也可以是用户尚未整理成聊天文本的原始想法；两者都必须包含用户选择的表达目标。 | 固定所属联系人，内嵌本次实际检索到的上下文快照（`retrieved_context`），并记录输入模式、实际使用的 `skill_version_id`、选择原因与置信度。 |
| `reply_candidate` | 模型给出的可编辑候选回复及风险说明。 | 关联一次回复请求；不会自动发送。 |
| `retrieved_context` | 本次回复实际使用的检索上下文快照（作为 `reply_request` 内嵌结构）。 | 含隔离键、检索条件（时间窗口、关键词、limit）、引用列表与排序分数，用于"为什么用了这些上下文"的回看。 |

## 资料分层

```text
source_document
  -> message
      -> memory_candidate
          -> confirmed_memory

conversation_binding
  -> session_capture
      -> message

reply_request（内嵌 retrieved_context 快照）
  -> reply_candidate
      -> style_sample（仅用户明确采纳时）

reply_skill
  -> reply_skill_version（发布后不可变）
      -> reply_request（记录本次实际使用的版本）

background_task
  -> background_task_step（固定步骤、独立状态与重试）
```

## 后台任务状态约束

- `background_task` 表示用户看到的一次完整工作；`background_task_step` 表示其中一个可单独恢复的执行单元。短回复和单次轻量操作不得为了统一形式强行拆步骤。
- v1 的步骤由任务类型对应的确定性模板创建，例如导入为 `parse -> normalize -> extract_memory -> index -> verify`；模型不得自由新增、删除、跳过或重排步骤。
- Worker 领取步骤时写入 `worker_id`、`lease_expires_at` 和原子状态变更。同一时刻只允许一个有效租约；Worker 崩溃后，过期租约可被重新领取。
- 步骤处理器必须使用幂等键，重复执行不得产生重复 `message`、`memory_candidate`、索引条目或删除副作用。
- 父任务只有在所有业务步骤成功后才能进入 `verifying`；验证通过才进入 `succeeded`。验证失败必须进入 `failed` 或回到明确的可重试步骤，不能由进度百分比或模型结论直接宣布成功。

- `memory_candidate` 必须有 `pending`、`confirmed`、`rejected` 或 `invalidated` 等明确状态，且候选正文与证据范围可复核。
- `confirmed_memory` 的写入路径为全自动（见 ADR-002）：模型提取的记忆自动写入，必须带来源证据、标记 `auto`、可一键撤销；用户手动录入时标记 `manual`。模型不能未经来源证据直接写入。
- `confirmed_memory` 保留候选来源链：记录从哪个 `memory_candidate` 采纳而来（`source_candidate_id`，手动创建时为空），同时保留来源证据列表；采纳后仍可回看候选证据与采纳方式。
- `rejected`/`invalidated` 候选随其来源删除，或短期保留供用户复核后清除；不长期堆积，与来源级删除语义一致。
- `style_sample` 只能由用户明确采用其最终回复后创建。用户选择某个候选不等于同意把它长期保存。
- `reply_skill` 是回复策略，不是联系人事实或表达样本。一次候选被采用不得自动沉淀为 Skill；新增或修改 Skill 必须来自产品内置版本或用户明确编辑。
- Skill 自动匹配只决定本次是否加载已存在版本，不得自动创建、改写或启用 Skill。`reply_request` 保存实际使用的 `skill_version_id` 与选择原因，保证历史可复现。
- v1 每次最多加载一个 `reply_skill_version`。完整正文不得进入常驻提示词；只有目录摘要常驻于 Skill 选择调用，选中后才按版本加载正文。

## 资料分类与有效期（v1）

`confirmed_memory` 必须携带分类枚举与可空的 `valid_at` / `invalid_at` 字段：

| 分类 | 含义 | 说明 |
| --- | --- | --- |
| `common_fact` | 共同事实 | 双方共享、长期稳定的客观事实，如家庭、工作、住址。 |
| `preference` | 偏好 | 喜欢或不喜欢的事物，如食物、话题、礼物取向。 |
| `taboo` | 禁忌 | 应避免提起的话题或雷区。 |
| `recent_state` | 近期状态 | 常有过期的临时状态，如"这个月在减肥""最近在加班"，通常设置 `invalid_at`。 |
| `relationship_note` | 关系备注 | 无法归入以上分类的备注；用户可编辑、可自定义标签。 |

- 分类枚举 v1 只取上表少量值，用户可编辑；不建立复杂本体，不为枚举之外的自由语义建模。
- 有效期字段：`valid_at` 为该资料生效时间（缺省为采纳时间），`invalid_at` 为失效时间（缺省为永不过期）。
- 排序与检索按 H2 规则使用分类与有效期：有效期内优先、无有效期视为长期有效、已过期不进入生成上下文（可在 UI 中显式展示为"已过期"供用户修正或删除）。

## 记忆自动维护机制（v1）

记忆全自动写入（见 ADR-002），由以下确定性机制维护质量，不依赖人工确认：

1. **重复才信**：一次性或低置信表达只进入 `memory_candidate` 候选池；同一主题在多次独立场合出现后，才自动采纳为长期 `confirmed_memory`。单次情绪性表达不得直接升级为长期偏好。
2. **过期自动失效**：`confirmed_memory` 携带 `valid_at`/`invalid_at`；已过期资料不进入生成上下文，仅在 UI 显式展示为"已过期"供用户修正或删除。
3. **近期对话压过旧记忆**：检索与组装时，近期 `message` 优先于旧记忆；新旧冲突时以近期对话为准，旧记忆自动降权。
4. **常驻卡（`carry`）**：`confirmed_memory` 中标记 `carry: true` 的 5-10 条为常驻卡，每次生成回复固定加载，不依赖检索；按分类与有效期取最相关的条目。
5. **全局层拼接**：`owner_preference`（你的全局偏好）与联系人常驻卡拼接进入上下文，两层不互相覆盖。

## 隔离与查询约束

任何联系人范围对象都应至少含有：

```text
owner_id
contact_id
created_at
updated_at
status
```

在数据访问层，联系人范围查询的输入必须同时提供 `owner_id` 和 `contact_id`。不允许存在“按昵称搜索所有资料后再选择”的内部便利查询；跨联系人的汇总视图也只能返回非私密、用户主动请求的聚合结果。

`message` 必须显式冗余 `owner_id + contact_id`，不得仅通过 `source_document` 或 `session_capture` 间接推导；检索过滤必须基于 `message` 自身携带的隔离键，而不是依赖来源关联。

`conversation_binding` 的创建和变更必须经用户确认。会话标题、OCR 文本或模型推断只能作为匹配线索；没有匹配或匹配不唯一时，不得将 `session_capture` 写入任何联系人。

`session_capture` 是联系人范围对象中唯一允许不携带 `contact_id` 的豁免：它存在一个“未归属临时态”，此时仅含 `owner_id`、不含 `contact_id`。该状态只出现在采集后、归属确认前的短暂窗口内，必须满足以下规则：

- 未归属的 `session_capture` 不得产生任何 `message`，也不得参与检索。
- 归属成功的 `session_capture` 必须冗余 `owner_id + contact_id` 并关联已确认的 `conversation_binding`，此后按联系人范围对象对待。
- 归属失败（匹配不唯一、绑定失效、无法可靠区分说话人或消息顺序）时，该批次必须丢弃或标记未归属，且必须按临时数据在明确时间点清理，不能静默累积或降级为“默认属于某人”。

## 来源与删除语义

- 每条 `message` 必须能定位到 `source_document` 中的原始片段或原始文件引用，或者定位到 `session_capture` 的已绑定会话、采集时间、OCR 片段与解析状态；后者不要求保存原始视觉帧。
- 每条候选和已确认资料应保存支持它的消息或来源列表，不能只保存一个无法解释的摘要。
- 删除一个 `source_document` 时，必须清除其规范化消息、仅由它支持的候选资料、索引和缓存。
- 删除一个已归属的 `session_capture` 或解除其会话绑定时，必须按相同语义清除其规范化消息、派生候选资料、索引和缓存。
- 未归属的 `session_capture` 不产生 `message` 或任何派生资料；其临时数据在归属确认超时或用户停止同步时一并清除。
- 只由被删除来源支持的 `confirmed_memory` 无条件级联删除，不存在"默认"或"视情况"保留的口子。用户若想保留内容，唯一路径是主动执行"另存为不依赖该来源的手动资料"：该操作创建一条与来源无关的新 `confirmed_memory`（来源证据列表置空、候选来源链字段置空），并切断与原来源的依赖，此后原来源的删除不再影响它。
- 去重后的 `message` 归属策略：一条 `message` 只归属一个权威来源（删除该来源即连带删除该消息），不在多个来源间共享引用。同一事实若在多个来源中出现，由候选提取层的证据合并处理，而不是让 `message` 层承担多来源引用。
- 一条已确认资料有多个来源时，删除其中之一只移除该证据；没有剩余证据时按无条件级联删除规则失效，除非用户已执行"另存为手动资料"。

## 尚未决定

- PostgreSQL 的主键格式、加密方式、备份策略，以及原始文件对应的云端对象存储目录结构。
- 高风险规则的具体关键词/类型枚举（见 ADR-002；判定放独立适配层，实现时细化）。
