# TencentDB-Agent-Memory 与 NotAlone 的上下文检索研究记录

> 研究日期：2026-09-02  
> 范围：只读分析 `/Users/local-user/learn/TencentDB-Agent-Memory` 当前源码、NotAlone 当前架构文档及 TencentCloud 官方仓库页面。本文是研究记录与架构建议，不表示 NotAlone 已实现下述目标链路。

## 结论先行

TencentDB-Agent-Memory 的核心启发不是“把所有聊天变成向量”，而是把记忆拆成不同职责：L0 保留可核对的原始对话，L1 保存从对话提炼的原子事实，L2/L3 提供场景索引和画像入口。OpenClaw 的实现把动态召回结果与稳定系统上下文分开，并把较大的场景正文留给工具按需读取。来源：[TencentDB README_CN](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/main/README_CN.md#L231-L244)、[OpenClaw recall.ts](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/main/MemoryCore/openclaw-plugin/src/hooks/recall.ts)、[format.ts](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/main/MemoryCore/openclaw-plugin/src/format.ts)。

映射到 NotAlone 时，建议采用下面的边界：

```text
已验证联系人范围
  -> 硬过滤 owner_id + contact_id + 状态/有效期/删除状态
  -> 近期消息窗口（应用层直接装配）
  -> SQL/全文/向量候选集（均只在该范围内）
  -> 去重、时间邻近展开、预算控制、引用快照
  -> Skill 目录发现与最多一个 Skill 的按需读取
  -> 有界 Agent Tool loop（只读）
  -> 候选校验、用户编辑、用户亲自发送
```

这是基于 NotAlone 现有 ADR 的建议，不是 TencentDB 源码已经替 NotAlone 做出的决定。

## 1. L0/M0 原始聊天记录与 `confirmed_memory`

### 1.1 TencentDB 的 L0 是证据层，不是确认事实层

TencentDB README 将长期记忆描述为 L0 Conversation → L1 Atom → L2 Scenario → L3 Persona：L0 是原始对话，L1 是从对话提取的事实、偏好、约束和事件，L2/L3 是更高层的场景和画像。源码侧，MemoryProxy 在每轮结束时通过 `/v3/conversation/add` 写入当前轮消息；录制器还会先剥离 harness 的额外数据，只保留真实 `user_query`，避免把系统注入内容写入 L0。来源：[README_CN](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/main/README_CN.md#L234-L244)、[`client.ts` 绝对路径](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/main/MemoryProxy/src/tdai/client.ts#L91)、[`recorder.ts` 绝对路径](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/main/MemoryProxy/src/tdai/recorder.ts#L5)。

本文把问题中的 “M0” 理解为 NotAlone 的原始消息/证据层命名；TencentDB 当前公开接口使用的是 “L0 Conversation”，不是 `M0`。因此二者可作概念对照，但不能把 M0 当作 TencentDB 的正式层名。

### 1.2 NotAlone 的 `confirmed_memory` 是有证据约束的业务事实

NotAlone 的权威链路是 `source_document/session_capture -> message -> memory_candidate -> confirmed_memory`。`confirmed_memory` 不是 L0 的别名，也不是“向量命中后自动变成事实”：它必须保留来源、采纳状态、有效期和删除路径；`pending` 候选不能进入生成。来源：[`ADR-005` 绝对路径](https://github.com/Aqua-ava/NotAlone/blob/main/architecture/adr/005-explainable-retrieval-and-contact-knowledge-view.md#L31)、[同文档](https://github.com/Aqua-ava/NotAlone/blob/main/architecture/adr/005-explainable-retrieval-and-contact-knowledge-view.md#L52)。

建议关系如下：

| 层 | 作用 | 能否直接作为事实使用 |
|---|---|---|
| M0/L0 `message` | 原始或规范化聊天证据、说话人、时间、来源 | 只能作为证据和语境，不能自动等同于长期事实 |
| `memory_candidate` | 从消息提炼、待审核或待自动采纳的候选 | `pending` 不可进入生成 |
| `confirmed_memory` | 已通过 NotAlone 采纳契约的联系人事实 | 可以检索并进入上下文，但仍要带引用、状态、有效期 |
| TencentDB L1 | 通用原子记忆层 | 可作为设计参照；不能替代 NotAlone 的联系人确认和来源语义 |

## 2. 三种召回：SQL 硬过滤、全文、向量

三者不是同一层面的竞争方案：SQL 硬过滤负责“允许看哪些行”，全文和向量负责“在允许的行里找什么”。

### 2.1 SQL 硬过滤：先定边界，再谈相关性

NotAlone 必须先用已验证的 `owner_id + contact_id` 过滤，再叠加 `status`、有效期、删除状态、来源有效性和必要的类型/时间条件。排序分数、embedding 相似度和模型都不能决定联系人范围。消息以规范化单条消息为命中单位，命中后只在同一联系人下展开有限相邻轮次。来源：[`ADR-005` 绝对路径](https://github.com/Aqua-ava/NotAlone/blob/main/architecture/adr/005-explainable-retrieval-and-contact-knowledge-view.md#L15)、[NotAlone AGENTS.md](https://github.com/Aqua-ava/NotAlone/blob/main/AGENTS.md#L1)。

示意查询（研究建议，不是现有实现代码）：

```sql
SELECT ...
FROM message
WHERE owner_id = :verified_owner_id
  AND contact_id = :verified_contact_id
  AND deleted_at IS NULL
  AND source_is_valid = TRUE;
```

对 `confirmed_memory` 还应检查采纳状态、`valid_at`/`invalid_at`、来源是否仍有效。SQL 过滤的职责是安全与正确性，不是语义相关性。

### 2.2 全文/BM25：找确切词、短语和可解释命中

TencentDB 的 v3 接口把 `/conversation/search` 和 `/atomic/search` 定义为 L0/L1 关键词检索，并返回带 `score` 的结果；MemoryProxy 仅把当前身份、session/task、query 和 limit 传给 Gateway。Skill 搜索源码明确采用 SQLite FTS5/BM25，并支持按元数据生成查询；MemoryCore 的召回器还说明 keyword、embedding 和 hybrid/RRF 三种策略。来源：[v3 API 文档](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/main/MemoryCore/v3-api-memorycore-doc.md#L152-L158)、[同文档](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/main/MemoryCore/v3-api-memorycore-doc.md#L234-L240)、[`client.ts` 绝对路径](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/main/MemoryProxy/src/tdai/client.ts#L141)、[`skill-store.ts` 绝对路径](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/main/MemoryCore/src/core/skill/skill-store.ts#L555)、[`auto-recall.ts` 绝对路径](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/main/MemoryCore/src/core/hooks/auto-recall.ts#L425)。

在 NotAlone 中，全文适合联系人姓名之外的已确认别名、专有名词、事件词、原话、产品名和短语；它应该是硬过滤后的候选召回器，而不是绕过业务过滤的“grep”。来源：[`ADR-005` 绝对路径](https://github.com/Aqua-ava/NotAlone/blob/main/architecture/adr/005-explainable-retrieval-and-contact-knowledge-view.md#L15)。

### 2.3 向量：找语义相近表达，但不能决定事实

TencentDB README 明确写到，具体事实需要时可用 BM25、向量检索和 RRF 回到 L1/L0；配置和实现支持 embedding、keyword、hybrid。MemoryCore 的 hybrid 路径在本地模式下并行执行关键词与 embedding，再按 RRF 合并；TCVDB 可使用服务端 dense + sparse + RRF。来源：[README_CN](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/main/README_CN.md#L238-L244)、[`auto-recall.ts` 绝对路径](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/main/MemoryCore/src/core/hooks/auto-recall.ts#L500)、[同文件 RRF 实现](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/main/MemoryCore/src/core/hooks/auto-recall.ts#L625)、[`tcvdb.ts` 绝对路径](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/main/MemoryCore/src/core/store/tcvdb.ts#L961)。

NotAlone 当前 ADR 把向量检索定义为后续补充路径：只有关键词漏检、同义表达问题有真实证据时再评估，并先作为补充候选集比较引用正确性和覆盖率。即使启用向量，仍须先硬过滤，向量命中必须回到权威 `message` 或 `confirmed_memory` 行，并保存检索轨迹。来源：[`ADR-005` 绝对路径](https://github.com/Aqua-ava/NotAlone/blob/main/architecture/adr/005-explainable-retrieval-and-contact-knowledge-view.md#L62)。

## 3. 近期聊天窗口与 Top-K 历史片段如何合并

### 3.1 分工

- **近期窗口**：由应用层从当前已验证联系人的消息流直接读取，保留最近若干轮的顺序、角色和时间。它解决“这句短话在当前语境是什么意思”。
- **Top-K 历史片段**：对硬过滤后的消息/确认记忆做全文、向量或混合召回；命中消息后按时间邻近或同一来源有限展开，而不是把固定 token chunk 当作事实单元。
- **合并器**：去重、保留时间顺序、对命中片段扩展上下文、分配 token/字符预算，并为每项保留引用、命中方式和入选原因。

TencentDB 的 OpenClaw 插件在 `before_prompt_build` 中把当前用户输入作为 query，并行取 L1、L3 persona 和 L2 场景列表；它没有在插件中重新构造宿主的近期消息窗口，说明“当前窗口由宿主/应用提供、历史记忆另行召回”是合理边界。来源：[OpenClaw index.ts](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/main/MemoryCore/openclaw-plugin/index.ts#L178-L211)、[`recall.ts` 绝对路径](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/main/MemoryCore/openclaw-plugin/src/hooks/recall.ts#L29)。NotAlone ADR 也明确要求先直接加载近期消息，再分别检索历史消息和关系记忆。来源：[`ADR-005` 绝对路径](https://github.com/Aqua-ava/NotAlone/blob/main/architecture/adr/005-explainable-retrieval-and-contact-knowledge-view.md#L19)。

### 3.2 建议合并顺序

```text
近期窗口（稳定、完整、按时间）
  + 历史 Top-K 命中（相关性排序）
  -> 命中消息按有限邻居扩展
  -> 以 message_id / confirmed_memory_id 去重
  -> 近期窗口优先；历史片段按相关性与时间补充
  -> 超预算时先删低分历史片段，不删当前消息和硬规则
```

不能把 `confirmed_memory` 正文和原始消息重复注入；确认事实应作为带来源的短卡，原文只在需要核对时通过只读检索或工具读取。

## 4. `PromptContext` / Prompt 组装的包含与排除

### 应包含

1. 已验证的联系人上下文标识（由程序注入，不让模型自行填写）。
2. 当前待回复消息和有界近期窗口。
3. 少量有效的 `confirmed_memory`，每条带 ID/来源/状态/入选原因。
4. 历史 Top-K 片段及时间、角色、来源引用。
5. 当前用户明确的表达方向和风险/发送约束。
6. Skill 目录元数据；只有选中的一个 Skill 才按需加载正文，必要时再读受控 references/assets。
7. 可选的只读检索工具说明、调用预算和候选输出 schema。

### 应排除

- 其他联系人、未验证会话、跨 Owner 数据。
- `memory_candidate.pending`、失效/删除来源支持的资料。
- 全量历史、未命中的 L0 原文、原始截图/语音帧和无关 harness 噪声。
- 把一次候选回复策略当成长久偏好的文本。
- Skill 的脚本、任意文件路径、外部 URL 下载能力、工具/MCP/网络/发送权限声明。
- 完整 Prompt、完整 Skill 正文或聊天原文写入普通运行日志。

TencentDB 的 `formatRecallResult` 给出了一个有价值的结构：动态 L1 放 `prependContext`，稳定 Persona、Scene Navigation 和工具指南放 `appendSystemContext`；L2 只放路径索引，正文由 `tdai_read_cos` 按需读。来源：[`format.ts` 绝对路径](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/main/MemoryCore/openclaw-plugin/src/format.ts#L1)、[同文件](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/main/MemoryCore/openclaw-plugin/src/format.ts#L40)。NotAlone 应借鉴“分区和渐进加载”，但把联系人隔离、证据和删除校验放在自己的确定性外壳中。

## 5. Skill 目录与正文按需加载

TencentDB MemoryProxy 的 Skill injector 先生成当前 agent 的 `<available_skills>` 列表，并根据 agent/task 描述构造 BM25 查询；正文通过独立的 skill bridge 读取，而不是把所有 Skill 正文常驻 Prompt。来源：[`skill-injector.ts` 绝对路径](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/main/MemoryProxy/src/injection/injectors/skill-injector.ts#L1)、[同文件查询逻辑](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/main/MemoryProxy/src/injection/injectors/skill-injector.ts#L107)。

NotAlone 已采纳更严格的版本：目录只给 `name`、`description` 等元数据；运行时最多使用一个 Skill，正文和受控 references/assets 按需只读加载；Skill 不能注册 Tool 或改变联系人事实。目录缓存必须绑定 `owner_id + contact_id + skill_library_revision`，版本变化后失效。来源：[`architecture/current/skill-library.md` 绝对路径](https://github.com/Aqua-ava/NotAlone/blob/main/architecture/current/skill-library.md#L1)、[`ADR-010` 绝对路径](https://github.com/Aqua-ava/NotAlone/blob/main/architecture/adr/010-deep-agents-skills-middleware.md#L25)、[`ADR-019` 绝对路径](https://github.com/Aqua-ava/NotAlone/blob/main/architecture/adr/019-controlled-reply-skill-resources.md#L1)。

这里有一个重要取舍：TencentDB 的 injector 文案倾向于“相关就必须加载”，而 NotAlone 应保留“可选择 0/1 个 Skill”的产品边界，并由用户选择优先、系统推荐可解释。两者实现细节不能直接照搬。

## 6. 每轮重新检索组装与单轮内部工具调用

### 6.1 每轮重新组装

OpenClaw 的 `before_prompt_build` 每次收到用户输入都会执行 recall，并用当前 session 做隔离；Recall 内部并行取 L1、Persona 和场景索引。来源：[OpenClaw index.ts](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/main/MemoryCore/openclaw-plugin/index.ts#L178-L215)、[`recall.ts` 绝对路径](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/main/MemoryCore/openclaw-plugin/src/hooks/recall.ts#L34)。MemoryProxy 的通用 pipeline 则按“解析 → 执行 hooks → 序列化”处理每个请求；带 `session_init` 的 Skill/L2/L3 稳定块可以读缓存，动态 hook 仍可每轮执行。来源：[`pipeline.ts` 绝对路径](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/main/MemoryProxy/src/injection/pipeline.ts#L52)、[同文件缓存策略](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/main/MemoryProxy/src/injection/pipeline.ts#L149)。

NotAlone 建议每轮都重新生成 `PromptContext` 快照：重新校验联系人、消息水位、来源删除、记忆 revision 和 Skill revision；可缓存目录或稳定硬规则，但不能复用已经包含旧联系人/旧事实/旧 Skill 正文的完整 Prompt。生成过程中若出现新消息，现有架构要求提示上下文已更新，由用户重新生成。来源：[`ADR-011` 绝对路径](https://github.com/Aqua-ava/NotAlone/blob/main/architecture/adr/011-automatic-relationship-memory-index.md#L23)、[`core-flows.md` 绝对路径](https://github.com/Aqua-ava/NotAlone/blob/main/architecture/current/core-flows.md#L195)。

### 6.2 单轮内部 Tool loop

TencentDB OpenClaw 插件把 L0 原文搜索、L1 原子记忆搜索和 L2/L3 文件读取注册成 Agent 可调用工具，并规定两个搜索工具每轮合计最多 3 次。来源：[`format.ts` 绝对路径](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/main/MemoryCore/openclaw-plugin/src/format.ts#L24)、[`index.ts` 绝对路径](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/main/MemoryCore/openclaw-plugin/index.ts#L94)。

NotAlone 的建议是：确定性外壳先装配近期窗口和基线资料，再运行一次有界 `create_agent` Tool loop；Tool 只能只读查询当前联系人范围，参数中的 `owner_id + contact_id` 由 runtime context 注入。工具调用次数、返回条数、token、超时和重试是运行预算；最终候选必须经过引用和人工发送边界校验。来源：[`ADR-009` 绝对路径](https://github.com/Aqua-ava/NotAlone/blob/main/architecture/adr/009-langchain-create-agent-bounded-reply-loop.md#L17)。

## 7. Resource 是否需要

如果 Resource 指 MCP/框架 Resource：NotAlone v1 不需要为每轮回复预先引入一个通用 Resource 层。当前最小必要边界是 `RetrievalPort`、`SkillPort` 和只读 Tool；Resource 只有在需要把稳定、可寻址、非联系人敏感的导航材料暴露给运行时，且能复用既有权限/删除语义时才值得增加。

如果 Resource 指 Skill supporting files：需要，但必须是 ADR-019 定义的受控 `references` 和静态 `assets`，与不可变 Skill 版本绑定、按需只读读取；不接受 scripts、任意路径、外部 URL 或可执行能力。来源：[`ADR-019` 绝对路径](https://github.com/Aqua-ava/NotAlone/blob/main/architecture/adr/019-controlled-reply-skill-resources.md#L1)。

TencentDB 的 L2 Scene Navigation 体现了“索引先注入、正文后读取”的价值：OpenClaw 只把路径列表放进稳定系统上下文，`tdai_read_cos` 再读具体文件。来源：[`format.ts` 绝对路径](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/main/MemoryCore/openclaw-plugin/src/format.ts#L62)、[`read-cos.ts` 绝对路径](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/main/MemoryCore/openclaw-plugin/src/tools/read-cos.ts#L1)。NotAlone 可以采用同样的渐进披露，但联系人关系事实不能只存在 Resource 文件里；权威数据仍在 PostgreSQL 及其来源关系中。

## 8. 映射到 NotAlone 的建议架构

### 8.1 模块职责

| 模块 | 职责 | 不负责 |
|---|---|---|
| `scope` / identity | 验证 Owner、联系人、桌面会话绑定和授权 | 不让模型决定联系人 |
| `record` | 保存 M0/L0 规范消息和来源 | 不把原文自动升级为事实 |
| `memory` | 管理 candidate/confirmed 生命周期、证据、有效期、删除 | 不按相似度直接确认 |
| `retrieval` | 硬过滤、全文/向量候选、邻近展开、去重、预算和引用快照 | 不管理 Skill |
| `skills` | 目录、版本、正文、references/assets、revision 和删除 | 不注册 Tool 或读取联系人数据库 |
| `context` | 合并近期窗口、历史 Top-K、确认事实、Skill 结果 | 不持有新的事实权威 |
| `reply` | 有界 Agent loop、只读 Tool、候选校验 | 不发送外部消息 |
| `jobs` | 异步导入、提取、索引、删除与重建 | 不把后台状态塞进 Prompt |

这与 NotAlone 当前的 `RetrievalPort`、`SkillPort`、`create_agent` 确定性外壳和人工发送边界一致。来源：[`ADR-006` 绝对路径](https://github.com/Aqua-ava/NotAlone/blob/main/architecture/adr/006-agent-orchestration-and-retrieval-frameworks.md#L1)、[`ADR-009` 绝对路径](https://github.com/Aqua-ava/NotAlone/blob/main/architecture/adr/009-langchain-create-agent-bounded-reply-loop.md#L17)。

### 8.2 推荐的 `ContextRetriever` 形状

```text
ContextRetriever.retrieve(ReplyContextRequest)
  -> RetrievedContext {
       recent_messages,
       confirmed_memories,
       historical_message_windows,
       skill_catalog,
       loaded_skill_version?,
       citations,
       query_plan,
       revision_snapshot
     }
```

实现顺序应是：

1. 校验已验证联系人和所有 revision。
2. 取当前消息及有限近期窗口。
3. 在硬过滤范围内分别执行 SQL 精确条件、全文召回，必要时执行向量补充。
4. 合并 Top-K、展开邻近消息、去重并控制预算。
5. 生成可回看的 `RetrievedContext`，每条记录命中方式、来源、分数和原因。
6. 暴露 Skill 目录；选中后读取单个版本正文和必要资源。
7. 进入有界只读 Tool loop，工具结果再次做范围和引用校验。
8. 保存本次上下文快照，生成可编辑候选；用户自行发送。

### 8.3 明确不建议照搬的部分

- 不把 TencentDB 的 `team_id + agent_id + user_id` 直接当成 NotAlone 的联系人模型；NotAlone 的事实边界是 `owner_id + contact_id`，桌面会话还要经过确认绑定。
- 不把 L1/Persona 的生成结果直接当 `confirmed_memory`；必须经过 NotAlone 的 candidate/confirmed 证据契约。
- 不把 OpenClaw 的通用 `tdai_read_cos` 变成任意文件读取；Skill Resource 和关系资料都要走自己的 scope、版本和删除校验。
- 不把缓存的稳定块误认为每轮完整上下文；联系人、记忆、来源和 Skill revision 改变时必须失效。
- 不增加外部聊天发送 Tool；候选始终由用户编辑并亲自发送。

## 证据边界与未决问题

1. TencentDB 公开 README 和源码证明了 L0/L1/L2/L3、BM25/embedding/hybrid、渐进注入和工具调用方式；它们不证明 NotAlone 已集成 TencentDB，也不证明其后端检索质量适合关系回复。
2. “M0”是本文为 NotAlone 原始消息层采用的对照称呼；TencentDB 正式接口称为 L0。
3. NotAlone 当前架构已决定向量是后续补充路径，具体 PostgreSQL 中文全文方案、预算和评估数据仍需在实现前单独验证。
4. 本记录没有修改代码、架构文档或配置；只新增本文件。

## 主要来源索引

- [TencentCloud/TencentDB-Agent-Memory README_CN](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/main/README_CN.md)
- [MemoryProxy injection pipeline](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/main/MemoryProxy/src/injection/pipeline.ts)
- [MemoryProxy Skill injector](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/main/MemoryProxy/src/injection/injectors/skill-injector.ts)
- [OpenClaw recall hook](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/main/MemoryCore/openclaw-plugin/src/hooks/recall.ts)
- [OpenClaw recall formatter](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/main/MemoryCore/openclaw-plugin/src/format.ts)
- [NotAlone ADR-005：可解释检索与联系人知识视图](https://github.com/Aqua-ava/NotAlone/blob/main/architecture/adr/005-explainable-retrieval-and-contact-knowledge-view.md)
- [NotAlone ADR-009：有界候选回复循环](https://github.com/Aqua-ava/NotAlone/blob/main/architecture/adr/009-langchain-create-agent-bounded-reply-loop.md)
- [NotAlone ADR-010：SkillsMiddleware](https://github.com/Aqua-ava/NotAlone/blob/main/architecture/adr/010-deep-agents-skills-middleware.md)
- [NotAlone ADR-019：受控 Skill 辅助资源](https://github.com/Aqua-ava/NotAlone/blob/main/architecture/adr/019-controlled-reply-skill-resources.md)
