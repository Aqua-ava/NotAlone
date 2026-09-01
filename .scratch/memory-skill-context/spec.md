# Memory、Skill 与 Prompt 上下文规格

> 状态：方案已确定，待拆分实现任务
> 规格类型：功能与运行时设计
> 范围：NotAlone 的联系人记忆检索、TencentDB 式按需查询、回复 Skill 加载和候选回复上下文组装
> 依据：[TencentDB Agent Memory 研究笔记](../../research/tencentdb-agent-memory-context-retrieval.md)

## 1. 用户问题与目标

NotAlone 需要在用户针对一位已确认联系人生成候选回复时，能够使用当前对话、相关关系记忆和必要的历史消息，同时避免把全部聊天记录塞进 Prompt，也不能让模型直接访问数据库或跨联系人读取资料。

本规格借鉴 TencentDB Agent Memory 的以下机制：

- 原始聊天记录按需通过对话查询工具读取；
- 相关性搜索与按时间顺序读取分成两个工具；
- Skill 先提供目录，需要时再加载完整正文；
- 稳定内容可以会话级缓存，动态记忆每轮重新组装；
- 模型在确定性应用外壳内进行有界、只读的 Tool loop。

本规格不引入 TencentDB 运行时依赖，不复制其完整 MemoryProxy，也不改变 NotAlone 的联系人确认、来源证据、删除级联和用户手动发送边界。

## 2. 术语与层级

本规格使用 TencentDB 的层级名称作对照。NotAlone 的权威领域对象仍是 `Message`、`memory_candidate`、`confirmed_memory` 和 `contact_memory_index`。

| 层/对象 | 在本规格中的含义 | 事实地位 |
| --- | --- | --- |
| L0 | 原始聊天/规范消息证据层，保留角色、时间、联系人、会话和来源 | 只能作为原文证据与语境，不能自动等同于长期事实 |
| `memory_candidate` | 从真实消息提取出的待处理候选 | `pending` 不进入默认回复上下文 |
| L1 | `confirmed_memory`，带来源、状态和有效期的已采纳联系人记忆 | 可以作为当前回复的事实资料 |
| L2 | `contact_memory_index` 以及按场景/主题生成的精简索引或摘要 | 可重建的检索导航，不是新的事实源 |
| L3 | 更高层稳定画像/人格资料 | 本轮暂不实现；不得把未确认推断写入其中 |
| Skill | 独立的回复策略 | 不是 Memory 层，不保存联系人事实 |
| Resource | Skill 的可选受控辅助资源 | 不是独立记忆层；只在 Skill 需要时读取 |

L0 是本规格与 TencentDB 对照时使用的名称，不替代 NotAlone 的领域词汇“规范消息（Message）”。全文不得使用其他容易与 L0 混淆的层级名称。

## 3. 总体架构决定

### 3.1 采用与不采用

采用：

1. 保留现有 PostgreSQL 作为联系人、消息、记忆、回复和删除状态的权威业务库。
2. 保留现有 `ReplyContext`、`RetrievalPort`、`SkillPort` 和 Reply Runtime seam，通过适配器接入检索和 Skill。
3. 用一个统一的 `ContextBuilder/InjectionPipeline` 组装每轮上下文。
4. 由程序先做确定性基础检索，模型只在信息不足或用户明确要求历史时调用只读工具补查。
5. 初始版本先使用联系人范围内的 SQL/全文检索；向量检索作为经过评测后再启用的补充路径。
6. L0、L1、L2 的派生索引和缓存均支持删除失效、幂等重建和版本校验。

不采用：

1. 运行时直接依赖 TencentDB 或照搬其完整服务、表结构和代理层。
2. 引入独立 Resource 记忆层或把聊天数据库包装成通用 Resource。
3. 把全量历史记录、全部 L1 或全部 Skill 正文默认放入 Prompt。
4. 允许模型执行 SQL、写入记忆、修改权限、执行脚本或发送聊天消息。
5. 把 L0 原文、模型草稿或未确认候选直接升级为长期关系事实。

### 3.2 每轮运行流程

```text
验证当前联系人范围
  -> 写入当前真实消息的 L0/Message
  -> 读取当前消息与有限近期窗口
  -> 程序检索少量有效 L1，并利用 L2 缩小范围
  -> 注入系统规则、工具说明和 Skill 目录
  -> 用户或模型选择 0/1 个 Skill，按需加载一个版本
  -> 模型需要时调用 L0/L1 只读工具
  -> 工具结果作为同一轮上下文继续生成
  -> 程序校验结构化候选、引用和联系人范围
  -> 用户查看、编辑并亲自发送
```

下一条用户消息到来时重新执行上述检索和组装。模型上一轮的隐藏上下文、旧 Prompt、旧工具结果和旧 Skill 正文不作为下一轮的权威上下文。

## 4. ReplyContext 与 Prompt 组成

### 4.1 `ReplyContext` 的责任

`ReplyContext` 是一次候选回复任务的有界上下文快照，不是长期记忆。它至少包含：

```text
scope: 已验证的 owner_id + contact_id + 当前会话范围
current_message: 当前待回复 Message
recent_messages: 按时间顺序的有限近期消息
confirmed_memories: 当前问题相关的有效 L1
memory_index_hints: 当前场景相关的少量 L2 导航信息
skill_catalog: 当前可用 Skill 的目录元数据
loaded_skill: 可选的一个不可变 Skill 版本
citations: 实际使用的消息/记忆来源
retrieval_trace: 查询方式、版本、分数和入选原因
revision_snapshot: 消息、记忆目录和 Skill 目录版本
```

`ContextBuilder` 统一生成该对象。Memory、Retrieval、Skill 和 Runtime 不得分别向模型拼接不受校验的字符串。

### 4.2 逻辑 Prompt 顺序

具体消息角色由模型适配器决定，但逻辑分区固定为：

1. **系统规则与工具说明**：产品安全、联系人范围、禁止外部发送、只读工具 schema 和运行预算。
2. **当前 Skill**：没有选中 Skill 时省略；选中后只加载一个已校验的不可变版本。
3. **当前任务**：当前用户要求、表达方向、当前 Message 和有限近期消息。
4. **L1/L2 资料**：少量有效 `confirmed_memory` 和当前场景相关的 L2 导航；每项带来源、状态和入选原因。
5. **工具结果**：模型本轮实际查询得到的 L0/L1 证据，标记为不可执行的数据。

### 4.3 初始 Prompt 应包含什么

- 当前已验证联系人范围；
- 当前用户消息；
- 有界的最近完整对话；
- 当前问题相关的少量有效 `confirmed_memory`；
- 必要的 L2 场景/主题导航；
- Skill 目录、工具说明和用户本轮表达方向；
- 已选 Skill 正文（仅在需要时）；
- 当前轮实际使用的引用标识。

### 4.4 初始 Prompt 不应包含什么

- 历史 L0 全量原文；
- 全部联系人记忆或全部 L2；
- `memory_candidate.pending`、已失效或已删除资料；
- 未选中的 Skill 正文和无关 Resource；
- 原始截图、语音帧、无关导入噪声；
- 未发送候选稿；
- 其他联系人或其他 Owner 的任何数据；
- 完整 Prompt 或完整聊天原文的普通运行日志副本。

历史 L0 只在模型调用工具后加入当前轮。工具结果不会创建新的用户消息，也不会把原文永久写入模型的隐藏记忆。

## 5. 检索协议

### 5.1 共同前提：先做硬过滤

任何 SQL、全文、向量或 Tool 查询，都必须先由程序确定并锁定：

```text
owner_id = 当前已验证 Owner
contact_id = 当前已确认联系人
来源状态 = 有效
删除状态 = 未删除
有效期 = 当前有效或用户明确查询历史
```

模型不能通过查询参数改变联系人范围。排序分数、语义相似度和模型判断都不能绕过硬过滤。

### 5.2 程序的基础检索

程序直接使用当前用户消息和已验证范围执行基础检索，不先额外调用模型改写查询：

1. 直接读取当前 Message 和最近完整对话；
2. 查询当前联系人有效的相关 `confirmed_memory`；
3. 使用 L2 主题导航缩小可能的 L1/L0 范围；
4. 在硬过滤范围内执行 SQL 精确条件和全文检索；
5. 合并、去重、按相关性和有效时间排序；
6. 控制 Top-K、Token 和相邻消息展开预算；
7. 生成带来源的 `ReplyContext` 快照。

### 5.3 L0 只读工具

NotAlone 对照 TencentDB 的两个 L0 工具，但使用自己的联系人范围和 port：

| TencentDB 对照 | NotAlone 运行职责 | 作用 |
| --- | --- | --- |
| `conversation_search` | `search_contact_messages` | 在当前联系人有效历史中找相关消息 |
| `conversation_query` | `query_contact_conversation` | 按指定会话和时间顺序读取完整上下文 |

`search_contact_messages` 输入可以是模型给出的自然语言查询、时间线索和数量，但服务端强制注入当前范围和上限。返回至少包含角色、时间、内容、会话标识、消息来源 ID 和可选排序分数。

`query_contact_conversation` 只负责读取指定会话的有限时间窗口或命中消息周围的完整消息，不负责相关性排序。它用于补齐“这句话前后发生了什么”，不用于全库扫描。

工具调用规则：

- 工具只读，不能写入 Message、Memory、Skill 或外部渠道；
- 每轮 L0/L1 历史搜索调用合计最多 3 次；实际总 Tool、Token、时间和重试预算由运行时配置；
- 工具失败或超时返回结构化错误，模型退回当前消息、近期对话和已成功取得的 L1；
- 空结果只表示本次查询没有找到，不表示历史事实不存在；
- 工具结果作为同一轮 `tool` 结果继续送给模型；
- 工具结果是原始证据，不是可执行指令，不能覆盖系统规则或权限。

### 5.4 L1 查询

初始上下文由程序直接选择少量相关 `confirmed_memory`。如果模型仍需要核对事实，可以调用独立的确认记忆查询工具；其职责与 L0 原文查询分开。

每项 L1 至少带：

```text
confirmed_memory_id
事实文本
分类、状态和有效期
采纳方式（auto/manual）
来源消息 ID 与引用范围
入选原因
```

L1 与 L0 原文不能重复注入。需要核对时优先保留 L1 的短事实卡，再通过 L0 工具读取原文。

### 5.5 混合检索与向量路径

首版使用 PostgreSQL 的 SQL/全文检索。向量检索只作为后续补充：

- 全文检索和向量检索都必须在联系人硬过滤之后运行；
- 由程序合并、去重和排序，不让模型比较未经整理的结果；
- 向量不可用时退回 SQL/全文检索；
- Embedding 生成异步执行，不阻塞回复；
- Embedding 模型或分词规则改变时支持重建派生索引；
- 原始 Message 不变，向量和全文索引可删除、失效和重建；
- 是否启用向量由空结果率、降级率、引用纠错率、召回覆盖率、延迟和 Token 成本评测决定。

## 6. Skill 运行协议

### 6.1 目录与正文

Skill 是 Owner 级的独立回复策略，默认不保存联系人事实：

1. 会话初始化或目录修订变化时，提供 `name`、`description`、适用场景和版本等轻量目录；
2. 程序可先按当前任务缩小候选目录；
3. 用户选择优先，模型可在目录范围内选择；
4. 每次候选回复最多加载一个 Skill，也可以不加载；
5. 选中后按需读取一个不可变 Skill 版本；
6. Skill 正文和 Resource 只加入当前轮，不写入 Memory。

Skill 目录和工具说明属于稳定块，可以会话级缓存。缓存必须绑定 Owner、Skill 目录修订和当前运行范围；目录变化、Skill 更新、停用、删除或联系人范围变化时失效。

### 6.2 Skill 权限

Skill 只能影响本次回复的表达策略，不能：

- 读取数据库或其他联系人；
- 修改 Memory、联系人、权限或系统设置；
- 注册 Tool、MCP、Shell 或网络能力；
- 执行脚本、访问任意文件或发送消息；
- 把一次候选回复沉淀为长期偏好。

Skill 的 references/assets 是可选、版本绑定、包内相对路径的受控辅助资源。它们不构成独立 Resource 记忆层；未被选中的 Skill 资源不加载。

### 6.3 没有匹配 Skill

没有适用 Skill、Skill 被停用、版本不可用或加载失败时，使用系统默认回复策略继续生成。不能强行套用随机 Skill，也不能因为 Skill 失败而读取任意文件或外部 Resource。

## 7. Memory 生命周期

### 7.1 L0 写入

- 当前真实收到的消息和用户实际发送的最终消息进入 L0/Message；
- 模型生成但用户没有发送的候选稿单独保存，不进入 L0；
- 记忆提取只读取已经成功提交的真实 Message；
- 历史导入和实时同步使用同一 L0 写入接口；
- 按来源 ID、消息 ID 或等价幂等键去重；
- L0 只追加，修正写入上层资料，用户要求删除时走删除流程。

### 7.2 异步记忆提取

消息事务提交后创建异步提取和索引任务：

```text
Message 已提交
  -> 提取 memory_candidate
  -> 校验来源、范围、风险和置信度
  -> 按采纳规则写入 confirmed_memory
  -> 更新或重建 contact_memory_index
  -> 更新全文/向量派生索引
```

任务必须可重试、幂等，不阻塞当前回复，也不因提取失败回滚已经写入的 Message。

本次方案采用以下采纳边界：

- 低风险、明确表达且符合 allowlist 的事实或偏好可以自动采纳，必须标记 `auto`、保留来源且可撤销；
- 敏感关系推断和高风险资料先作为候选，必须经过用户确认才进入默认 Prompt；
- 用户主动纠正的记忆以用户确认版本为最高优先级，旧版本保留为失效历史；
- 过期记忆从默认 Prompt 排除，但仍可在明确历史查询时读取。

### 7.3 L2 索引

L2 由真实 L0/L1 异步生成：

- 只记录少量主题入口、检索提示和 `confirmed_memory` 引用；
- 不复制全部聊天正文；
- 不根据未发送候选稿或未确认候选生成；
- 底层 L0/L1 删除、失效、修正或重新分类后立即失效；
- 目录版本必须与当前 `memory_revision` 一致才能使用；
- 新目录完成验证前可以暂时保留旧目录，但旧目录不得引用已删除资料；
- 重建由确定性代码完成，不把 L2 当作新的事实源。

## 8. 删除、冲突与故障

### 8.1 删除

删除 L0、来源、L1、L2 或 Skill 后，相关派生内容都必须失效：

```text
权威记录删除/失效
  -> 计算引用影响范围
  -> 失效 memory_candidate / confirmed_memory / L2
  -> 删除全文、向量、缓存和 Tool 结果
  -> 使 ReplyContext 快照与 checkpoint 失效
  -> 重建受影响联系人索引
  -> 验证删除后不可检索
```

删除任务必须有明确状态、幂等键、重试和失败原因。普通运行日志不保留可恢复的聊天正文。

### 8.2 冲突

新 L0 证据与现有 L1 冲突时：

- 不静默覆盖旧 L1；
- 建立新的候选或版本；
- 保留新旧来源和有效时间；
- 在无法确定时向用户提示不确定性；
- 只有规则或用户确认后才更新默认使用的 L1。

### 8.3 失败降级

- L0/L1 工具失败：继续使用当前消息、近期对话和已成功取得的资料；
- Skill 加载失败：继续使用默认策略；
- 结构化候选解析失败：按运行时策略重试一次，仍失败则返回受控失败，不发送；
- 联系人范围或来源校验失败：fail closed，不生成使用该资料的候选；
- 没有检索结果：不编造历史事实，必要时请用户补充。

## 9. 候选回复输出与人工发送

模型返回结构化候选，至少包含：

```text
text
evidence_ids
skill_id?
skill_version_id?
uncertainty?
clarification_needed?
```

程序必须验证：

- `evidence_ids` 来自本轮实际读取的结果；
- 所有依据属于当前 Owner 和联系人；
- 依据未被删除、未失效且仍在当前版本范围；
- Skill ID/版本确实是本轮加载的版本；
- 文本不包含其他联系人信息、内部检索字段或不可见 Prompt；
- 候选不触发外部发送。

候选依据在应用内可查看，最终文本由用户修改并亲自发送。只有实际发送的最终文本才可以进入 L0；未发送候选稿不能参与长期记忆提取。

## 10. 模块与 Interface/Seam

| 模块 | 主要职责 | 关键边界 |
| --- | --- | --- |
| scope/identity | 验证 Owner、联系人和会话绑定 | 模型不能决定联系人范围 |
| message/record | 保存 L0/Message、来源和去重 | 不把原文自动升级为事实 |
| memory | 管理 candidate、confirmed、有效期、来源和删除 | 不以相似度直接确认事实 |
| retrieval | SQL 硬过滤、全文/向量候选、时间展开、引用和预算 | 不管理 Skill，不绕过 scope |
| context | 生成 `ReplyContext` 和 Prompt 分区 | 不成为新的事实权威 |
| skills | 目录、版本、受控资源和缓存失效 | 不保存联系人事实，不注册能力 |
| reply/runtime | 有界模型-Tool loop、结构化输出和校验 | 不写长期 Memory，不发送消息 |
| jobs | 异步提取、索引、删除、重建 | 不把聊天正文写入任务状态 |

建议保留或扩展以下框架无关接口：

```text
RetrievalPort
  get_recent_messages(scope, window)
  search_confirmed_memories(scope, query, limit)
  search_contact_messages(scope, query, limit, filters)
  query_contact_conversation(scope, conversation, window)

SkillPort
  catalog(owner_scope)
  load_version(owner_scope, skill_version_id)
  read_resource(owner_scope, skill_version_id, relative_path)

ContextBuilder
  build(reply_request) -> ReplyContext

ReplyRuntime
  run(reply_context, read_only_tools) -> CandidateReply
```

实际数据库访问只能出现在 persistence/adapter 中；模型适配器只接收已经通过范围和预算校验的 `ReplyContext`。

## 11. 运行缓存与追踪

可以缓存：

- 系统硬规则和工具说明；
- Skill 目录元数据；
- 不含联系人私密正文的版本信息。

不得缓存为跨轮事实：

- 完整历史 L0；
- 包含旧联系人资料的完整 Prompt；
- 已删除或旧版本 Skill 正文；
- 已失效的 L1/L2 资料；
- 模型上一轮的隐藏上下文。

每轮记录最小追踪信息：

```text
reply_request_id
scope revision
memory revision
skill library revision / skill version
使用的 L0/L1/L2 ID
检索方式、查询计划版本、排序信息
Tool 调用次数、结果状态、延迟和 Token
```

不在普通运行日志中复制完整 Prompt、完整聊天原文、Skill 正文或联系人名称。检索记录和出站台账按现有隐私与删除生命周期管理。

## 12. 测试决定

### 12.1 必须覆盖

1. 正常链路：当前消息、近期窗口、相关 L1、Skill 和按需 L0 查询能组成候选。
2. 无结果：L0/L1 为空时不编造历史事实。
3. 跨联系人：查询词包含其他联系人信息时仍然拒绝读取。
4. L0 工具：相关性搜索与时间顺序查询职责分离，结果字段和数量受限。
5. L1：过期、失效、冲突、删除和来源不完整的资料不能错误进入 Prompt。
6. L2：版本不一致、底层资料删除和重建期间不会使用旧目录。
7. Skill：目录优先、最多一个版本、正文按需、无 Skill 回退、Resource 路径越权拒绝。
8. 输出：无效 `evidence_ids`、跨联系人引用、错误 Skill 版本和结构化输出失败都会被拒绝。
9. 生命周期：重复导入、异步任务重试、索引重建和删除任务均幂等。
10. 人工发送：候选不写入外部聊天输入框，未发送候选不进入 L0 或记忆提取。

### 12.2 质量指标

- 跨联系人泄露：必须为 0；
- 依据 ID 的联系人和来源校验失败率；
- 空结果率和降级率；
- Top-K 命中与引用纠错率；
- Prompt Token、Tool 次数、延迟和失败率；
- Skill 目录命中、加载失败和用户改选率。

具体 Top-K、Token、时间和重试数值在实现和合成评测中确定，不把未经评测的数字写成不可变领域规则。

## 13. 实施顺序

### 阶段一：核心闭环

- 核对并扩展现有 L0/Message 写入和去重；
- 接通当前联系人近期窗口与相关 L1 基础检索；
- 提供 `search_contact_messages` 和 `query_contact_conversation` 只读接口；
- 将结果统一转换为 `ReplyContext`；
- 保持现有候选回复和人工发送边界。

### 阶段二：Skill 与 L2

- 接入现有 Skill Library 的目录、不可变版本和按需资源读取；
- 完成会话级稳定块缓存与修订失效；
- 建立 L2 `contact_memory_index` 的异步生成、版本校验和删除重建；
- 接入异步记忆提取、候选状态和来源证据。

### 阶段三：检索优化

- 先完成 PostgreSQL 全文检索的中文分词、短语和索引验证；
- 用匿名化或合成数据评测空结果、引用正确性和延迟；
- 只有评测证明全文不足时，加入同一 PostgreSQL 内或受控适配器中的向量补充；
- 为 Embedding 版本、删除和重新索引增加独立验证。

所有阶段都通过 feature flag 保留基础“当前消息 + 最近对话”回退路径。

## 14. 范围外

- TencentDB 运行时、Gateway 或完整 MemoryProxy 的直接部署；
- 独立 Resource 记忆层；
- L3 人格画像；
- Skill 脚本、任意文件访问、网络下载、MCP/Tool 自注册；
- 候选回复自动发送；
- 用未发送候选稿训练或更新长期记忆；
- 首版独立向量数据库、强制 Embedding 服务或 Rerank 服务；
- 全量历史一次性注入 Prompt；
- 关系分析任务和长周期自治 Agent。

## 15. 现有决策冲突与处理

本规格中的“敏感关系推断必须用户确认”与 [ADR-002：关系提取与全自动采纳](../../architecture/adr/002-relationship-extraction-and-tiered-adoption.md) 当前“风险字段不阻塞自动采纳”的文字存在冲突。

该冲突不能被本规格静默覆盖。实现前必须通过新增或修订 ADR 明确以下二选一：

1. 保持 ADR-002 的全自动采纳，敏感信息只在生成和发送环节做确定性提醒；或
2. 采纳本规格的风险分级确认，敏感候选在用户确认前不得进入 `confirmed_memory` 和默认 Prompt。

在 ADR 完成复审前，工程实现不得自行选择其中一条作为已采纳领域规则。

## 16. 参考来源

### TencentDB

- [TencentDB Agent Memory README_CN](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/main/README_CN.md)
- [TencentDB v3 API](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/main/MemoryCore/v3-api-memorycore-doc.md)
- [MemoryProxy injection pipeline](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/main/MemoryProxy/src/injection/pipeline.ts)
- [MemoryProxy Skill injector](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/main/MemoryProxy/src/injection/injectors/skill-injector.ts)
- [OpenClaw conversation search](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/main/MemoryCore/openclaw-plugin/src/tools/conversation-search.ts)
- [OpenClaw recall formatter](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/main/MemoryCore/openclaw-plugin/src/format.ts)

### NotAlone

- [当前领域数据规格](../../architecture/current/domain-data.md)
- [当前核心流程](../../architecture/current/core-flows.md)
- [当前 Skill 库规格](../../architecture/current/skill-library.md)
- [当前隐私与删除边界](../../architecture/current/privacy-deletion.md)
- [ADR-005：可解释检索与联系人知识视图](../../architecture/adr/005-explainable-retrieval-and-contact-knowledge-view.md)
- [ADR-006：Agent 编排与检索框架边界](../../architecture/adr/006-agent-orchestration-and-retrieval-frameworks.md)
- [ADR-009：有界候选回复循环](../../architecture/adr/009-langchain-create-agent-bounded-reply-loop.md)
- [ADR-010：SkillsMiddleware](../../architecture/adr/010-deep-agents-skills-middleware.md)
- [ADR-011：关系记忆自动管理与主题目录渐进加载](../../architecture/adr/011-automatic-relationship-memory-index.md)
- [ADR-014：历史导入的记忆提取窗口与异步任务](../../architecture/adr/014-historical-memory-extraction-window.md)
- [ADR-015：后台任务与联系人记忆目录生命周期](../../architecture/adr/015-background-task-and-memory-index-lifecycle.md)
- [ADR-019：受控 Skill 辅助资源](../../architecture/adr/019-controlled-reply-skill-resources.md)
