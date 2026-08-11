# NotAlone 架构文档

> 状态：已建立。本文档集记录当前已采纳的产品约束与 v1 架构草案；它不是已经实现的功能清单。

## 目的

NotAlone 是一个面向具体联系人的关系感知回复助手。架构的首要目标不是自动操作聊天渠道，而是让每一条长期关系资料都可说明：属于谁、属于哪位联系人、来自哪里、是否经过用户确认、何时应被修正或删除。

本目录与其他资料的边界如下：

| 位置 | 记录内容 |
| --- | --- |
| `research/` | 外部产品、组件和技术方案的事实、证据及是否采用。 |
| `architecture/` | 已决定或待决定的内部边界、数据契约和主流程。 |
| 未来产品代码 | 实际可运行的接口、存储和测试；代码与测试优先于过时的架构文档。 |

根目录 `AGENTS.md` 是最高优先级的项目约束。本目录不能改变"已确认会话绑定、资料分层、全自动采纳、人工发送"等规则。

## 阅读顺序

1. [01-domain-data.md](01-domain-data.md)：数据对象、隔离和来源规则。
2. [02-core-flows.md](02-core-flows.md)：导入、回复、采纳和删除的端到端流程。
3. [03-privacy-and-deletion.md](03-privacy-and-deletion.md)：模型调用、保留、删除和安全边界。
4. [04-improvement-proposals.md](04-improvement-proposals.md)：多维评审的架构改进建议（H1-H8、M1-M21、A1-A5 已全部采纳并落地，剩余为具体供应商/加密/指标等实现前决策）。
5. [05-cloud-engineering.md](05-cloud-engineering.md)：云端模块化单体划分、客户端形态与认证设备方案（草案）。
6. [ADR-001：Mac 微信前台会话同步](adr/001-macos-wechat-active-session-sync.md)：渠道同步范围与授权边界。
7. [ADR-002：关系提取与全自动采纳](adr/002-relationship-extraction-and-tiered-adoption.md)：全自动写入 + 发送环节把关 + 有效期字段。
8. [ADR-003：Mac 同步连续性与用户补录](adr/003-macos-sync-continuity-and-backfill.md)：不把未覆盖的手机聊天误判为完整历史；以锚点检测、用户手动补录解决缺口。
9. [ADR-004：用户自行导出的微信单联系人历史文件](adr/004-user-managed-wechat-history-export.md)：仅接受用户手动生成的单联系人导出文件作为补录来源；禁止重签名、自动同步及 Agent 直接访问。
10. [ADR-005：可解释检索与联系人知识视图](adr/005-explainable-retrieval-and-contact-knowledge-view.md)：v1 使用联系人范围内的全文检索、可审计的 LLM 查询规划和有界上下文扩展；向量检索只在量化漏检后作为补充评估。
11. [06-agent-runtime.md](06-agent-runtime.md)：LangGraph 回复图、LangChain 适配层、Tool 权限、运行状态和 Retriever 边界。
12. [ADR-006：Agent 编排与检索框架边界](adr/006-agent-orchestration-and-retrieval-frameworks.md)：固定唯一编排器、唯一业务事实库和 RAGFlow 的可选位置。

## 当前架构决策

- 采用部署在云端的模块化单体；云端 PostgreSQL 是联系人、消息、关系资料、任务和删除状态的权威业务库。客户端只承担交互、授权采集和必要的端侧处理，不以本地 SQLite 作为业务主库。
- 用户手动导入的原始文件、截图和语音等大对象可按授权保存到云端对象存储；其具体方案、加密和备份策略另行确定，且必须通过来源记录与 PostgreSQL 中的业务数据关联。Mac 微信前台会话同步产生的原始视觉帧不属于此类，默认只在端侧内存中用于 OCR。
- 当前不先拆微服务、独立向量数据库或自治 Agent Harness；这些是未来按实际负载和检索效果评估的扩展，不是当前架构前提。
- 文字是唯一的检索与生成表示；截图和语音只作为 OCR/转写输入适配器。
- 数据隔离键为 `owner_id + contact_id`；昵称和备注只能展示，不能作为稳定身份。
- 对用户已确认绑定的 Mac 微信一对一前台会话，可在同步开关开启时自动识别并增量同步可见消息；未绑定、匹配不确定、非前台或其他 App 一律不采集。
- 模型自动提取并写入记忆，必须带来源证据、标记 `auto`、可一键撤销，不再设置人工确认门槛（见 ADR-002 全自动采纳）；外部消息永远由用户手动发送，安全保险在发送环节。
- 生成回复的上下文按"五轨"组装：硬规则（代码层）+ 常驻卡（全局层与联系人 `carry` 条目）+ 按需检索 + 近期对话 + 风格样本；历史永不完整进入提示词。
- v1 先使用联系人范围内的可解释结构化/全文检索：LLM 只提出可记录的检索词与阅读计划，程序执行过滤、命中和有界上下文扩展；只有出现可测量的长历史或同义表达漏检时，才评估 embedding、向量检索与重排。
- 云端按模块化单体组织（`ingest`、`contacts`、`memory`、`retrieval`、`reply`、`jobs`、`gateway`、`sync_adapter`、`auth_device`），v1 客户端为 macOS 桌面应用，端侧负责采集/OCR/去重/展示与人工发送，云端负责解析/索引/生成/删除。
- `reply` 内使用 LangGraph 作为唯一的候选回复工作流编排器；LangChain 只用于模型、结构化输出和 Tool adapter。领域对象不依赖两个框架，外部聊天发送永远不是 Tool。
- PostgreSQL 是唯一业务事实库；LangGraph checkpoint 只保存最小运行状态。v1 检索仍由 PostgreSQL 实现，RAGFlow 当前只作参考，满足量化触发条件后才可在 `RetrievalPort` 后做 POC。
- 云端服务落地前必须决定：认证与设备绑定方案（账号/令牌、设备注册、解绑清理）、云端数据加密与密钥管理。

## 文档状态

每份架构文档顶部都应使用以下状态之一：

- `草案`：提出方案，尚未成为实现约束。
- `已采纳`：可作为实现与测试的约束。
- `已废弃`：保留历史原因，不能用于新增实现。

当一个取舍会影响数据格式、隐私、删除语义或对外接口时，应新增 `architecture/adr/` 下的一份独立决策记录，而不是悄悄改动既有约束。
