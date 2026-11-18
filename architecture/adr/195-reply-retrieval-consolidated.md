# ADR-195：回复检索现行合并决定

状态：已采纳（2026-11-18，现行合并）。本文把回复侧记忆与历史检索的一条替代／修订链收拢为一份现行决定，不新增、放宽或收紧任何产品规则；联系人隔离、来源可验证、删除路径与人工发送边界逐条承接，不改变。实现与验收状态仍以代码、测试和[现行回复规格](../current/reply-generation.md)为准。

合并并归档的原 ADR：[090](superseded/090-bounded-runtime-history-retrieval.md)、[028](superseded/028-lexical-memory-recall-phase-1.md)、[035](superseded/035-pending-candidate-unconfirmed-reply-reference.md)、[182](superseded/182-reply-memory-hybrid-retrieval.md)、[185](superseded/185-on-demand-reply-memory-and-history-search.md)、[186](superseded/186-full-contact-history-search.md)、[190](superseded/190-tencent-style-local-hybrid-retrieval.md)、[191](superseded/191-reply-retrieval-contract-simplification.md)。它们的正文保留为历史依据，不再单独作为现行要求；各自仍有效的条款已写入下文。

仍作为现行决定、未并入本文的相关 ADR：[ADR-005](005-explainable-retrieval-and-contact-knowledge-view.md)（可解释检索与来源回溯）、[ADR-067](067-layered-scenario-and-profile-context.md)（L2／L3 分层与预算）、[ADR-062](062-official-deepseek-reply-input-budget.md)（完整请求估算）、[ADR-183](183-auto-abandon-unknown-reply-model-calls.md)（未知调用放弃）。

## 合并范围

| 原 ADR | 并入后仍有效的约束 | 已失效的取舍 |
| --- | --- | --- |
| 090 受控历史补查 | 应用层固定范围、只读受控工具、引用经检索端口复验、不借补查恢复已删资料、不开放时间／日历／网络／Shell／写入工具 | 独立的“最多三次历史工具”预算（由共享预算替代）；`workspace_recent_only` 排除消息保守策略（逐条排除已由 ADR-165 退役） |
| 028 词法召回第一期 | 联系人最多 5 条、本人最多 3 条的独立额度且不截断单条；本人记忆以独立证据类型进入并与联系人记忆区分；召回与来源／删除复验分离；失效或过期资料先排除资格再排序；预算调整须附评测 | CJK 单／双字词法评分、0.15 阈值、200 字符头尾查询采样、固定五条查询构造、字符预算、词典序入选排序、离线评测门槛 |
| 035 待确认候选参考 | 待确认候选不进入已确认记忆集合；已保存材料的「未确认」标注、来源复验、否决与删除不变 | 独立的待确认候选检索入口、3 条／300 字符预算、向生成注入的产品行为（无正常入口，已退役） |
| 182 混合检索 | 本机向量不联网、固定本机模型 `BAAI/bge-small-zh-v1.5`、惰性加载并须先运行 `node scripts/prepare_memory_embedding.mjs` 准备；未准备或失败时降级而不阻断回复 | 0.8／0.2 综合分与 0.48 门槛、每次请求重新向量化、人工确认排序加成、向量不持久化、生成前预计算 |
| 185 按需检索 | 先读近期语境再按需检索；两只读工具、预算、材料编号、冻结、删除与 DSH 查证 | 固定最近五条构造查询、初始 L1 预注入、历史五百条候选窗口与逐条历史身份冻结 |
| 186 全部获准历史 | 当前联系人全部获准历史均可搜索，仅限耗时、返回量与次数；v2 历史范围；五秒计算预算 | 以候选条数截断范围的做法；正文逐批扫描评分实现 |
| 190 腾讯式混合检索 | BM25＋向量＋等权 RRF、jieba 分词、sqlite-vec、持久增量索引、删除与排空、性能证据 | 原逐正文扫描与不持久化向量 |
| 191 合同收敛 | 正式读者必须提供列表、物化与文档读取；已排名选择按共享检索返回的身份／版本／顺序；`scanMore` 单一继续信号；旧冻结范围兼容 | 旧综合选择器的词法回退、`includeUnconfirmed` 与整池 `read`、待确认候选选择适配、精确剩余数 |

## 决定

### 1. 范围与装配

- 回复先提供同一联系人最近最多五十条合法聊天、本次独立输入、合法 L3 正文与 L2 目录；目录不当作已读正文。初始不自动召回 L1，也不预计算记忆向量。
- 信息不足时，模型调用 `search_relationship_memory` 搜索联系人／本人 L1，或调用 `search_relationship_history` 搜索历史原话。两工具参数只有 `query`；`owner_id`、`contact_id`、冻结范围与资格由应用层闭包固定，模型不能提供身份、来源、版本、路径、SQL、Shell、微信读取或发送能力。关闭关系背景时两工具均不装配。
- 工具查询已保存且当前可用的资料，不读取微信、不开启同步、不建立联系人、不恢复读取授权、不跨联系人。模型不自行写记忆、不修改资料、不授权新范围，也不发送外部消息；时间、日历、网络、Shell、任意文件和写入工具不因本决定开放（见 [ADR-092](092-defer-time-calendar-web-tools.md)）。
- 工具经 DSH 官方 scoped Tool 与 Agent loop 装配，不另造 Harness、provider 或手工模型循环。

### 2. 召回与排序

- L1 已采纳记忆与 L0 获准原始聊天统一使用 BM25 全文召回、本机向量召回与等权 RRF 名次融合（`RRF=Σ1/(60+排名)`，名次从一开始，等分按稳定身份决胜）。检索名次不等于事实置信度，不设余弦或融合分门槛。
- 中文写入与查询使用 `@node-rs/jieba` 搜索分词；全文侧为 SQLite FTS5 BM25，向量侧为固定本机模型与 `sqlite-vec` 余弦距离。固定依赖为 `@node-rs/jieba@2.0.1`、`sqlite-vec@0.1.7-alpha.2`；扩展只在可信装配时启用，加载后立即关闭扩展加载，模型与工具不能提供路径、SQL 或库名称。
- 在合法身份集合内先做 BM25／KNN 再取候选，不先扩大候选再过滤隔离；候选放大只属于 top-K 实现，不构成历史条数窗口。
- 共享检索 Module 位于 `backend-ts/src/retrieval/`：分词与 RRF 是无业务身份的纯算法，SQLite Adapter 负责索引、具名动作、合法集合内召回与删除，普通 TS 生命周期负责本机推理、批次与排空；L1／L0 不各造一套向量、分词、融合或后台循环。
- 缺少一路时保留可用路径：模型缺失、推理失败或查询向量超时（`index-runtime.ts` 当前为 8 秒）降级为 BM25 单路，并按诊断事件区分；不使用云端 embedding，不在运行时下载模型，未完成索引不能冒充完整未命中。
- 正式回复必须通过共享检索返回的精确身份／版本／顺序选择记忆；失效条目继续跳过并补位，不能截断正文。不再保留词法评分、字词覆盖率回退、整池读取或未确认候选选择的第二套链路。

### 3. 预算、依据与冻结

- 联系人 L1 整轮去重后最多 5 条，本人 L1 最多 3 条，额度互不占用，由同一处定义，不截断单条正文；实际入模容量仍受完整请求预算约束（[ADR-062](062-official-deepseek-reply-input-budget.md)）。
- 两搜索工具在同一请求内合计最多三次已接纳尝试，空结果、执行失败与超时占次数；参数错误、重复查询与预算拒绝不执行，保留可区分的无正文回执。Skill 降级不重置次数。补查消息（命中与邻近原话）合计最多十六条、2,048 估算 token（按 UTF-8 正文字节），完整条目放不下时跳过，不截断原话。L2 原有“最多两次成功读取”预算独立保留。
- L1 冻结当时合法范围的 ID、版本与正文摘要。历史范围使用 v2：只记录消息接纳序号上界与联系人资料代次，不复制全部消息 ID、来源 ID 或正文，覆盖该时刻已接纳的当前联系人全部获准历史；新入库、改版或跨联系人消息不混入已开始的请求。旧 v1 已保存范围继续按旧身份集合验证，不自动扩大授权，也不补造缺失范围。
- 本机按接纳序号分页遍历合法范围，分页大小只是工作批次，不是可搜索数量上限；排序只保留有机会进入剩余返回预算的候选，工作内存不随历史条数线性增长。
- 历史搜索从资格核验开始共享五秒计算截止，包含查询排队、推理与存储等待；最终追加与深资格复验处于可回滚 savepoint，越界撤销本次材料但保留已消费尝试与超时回执，不追加或返回部分结果。该截止不是单次同步数据库调用期间的精确墙钟保证。
- 实际结果和来源在同一短事务追加到候选输入并分配稳定材料编号；只有真实进入下一次模型请求的结果才可作候选依据。每次出站与保存继续复验精确来源、版本、作者和时间。目录、准备池、冻结池和工具名称不冒充已读材料。
- 未命中不证明不存在，能力失败不冒充空结果；迟到结果、取消与重试均重新核验资格。

### 4. 本人记忆与未确认候选

- 本人 L1 沿 owner 范围读取，以独立的 `owner_memory` 证据类型进入上下文，提示与依据中区分“关于联系人”和“关于用户本人”的资料；历史原话只属于当前 `owner_id + contact_id`。
- 待确认候选不属于已确认记忆集合，当前没有向新回复注入它们的入口；若以后开放新的生成入口，须另立决定并重新明确合同，不能把未确认资料当作已确认事实。待确认资料的管理、采纳、否决与删除不变。已保存的 `pending_candidate` 材料继续携带「未确认」标注、原时间快照与来源，经原快照、来源、否决和删除合同回看与复验；已否决候选不再出现，不改写旧请求。

### 5. 索引生命周期与删除

- 索引与业务资料共用受管 SQLite：迁移 56 登记既有资料身份，迁移 57 追加有界扫描游标并兼容已知旧删除清单，已应用迁移及校验和不改写；旧资料分批回填，新写入／修订通过 TEMP dirty 聚合在同一事务的受控 flush 中更新 FTS；SQL 触发器不调用 JS 分词或 `vec0`。来源、时间、状态与版本仍在领取、查询与实际出站时复验。
- 正文向量按“实体＋正文摘要＋模型表示指纹”复用。指纹含固定本机模型、revision、512 维、CLS pooling、L2 归一化、f32 与正文截断规则；正文未变的元数据修订不重算，正文变化、撤下或删除使旧表示失效。查询向量与逐次得分不持久化，不建立跨联系人的正文 hash 缓存。
- 复用本机 embedding 生命周期，单 lane 小批回填并让查询优先：启动先处理 L1 小池，查询按当前联系人与层级有界唤醒，再继续全局 L0；层级范围用独立游标，推理不持有 SQLite 事务；提交重新核对摘要、版本／资格、资料代次与模型指纹，迟到结果不能复活旧资料。启动不等待全量回填，不读取微信，不调用外部 embedding。模型放在项目目录 `.models/memory-embedding`（被 git 忽略）。
- 索引领取与文本回填只用必填 `scanMore` 表达本轮是否还有后续页，不返回调度未使用的精确剩余数；文本回填合并排队与旧分词身份，最多多探测一项；`retrieval.pending` 继续提供诊断计数。`scanMore:false` 只表示当前批次或游标结束，不是全局永久完成。
- FTS、向量、待回填身份与扫描游标并入既有删除 domain：FTS 启用独立 secure-delete，`sqlite-vec` 删除前先通过正式 UPDATE 覆写向量槽位，仍须沿现有 checkpoint／VACUUM／校验完成物理清理。在途正文与查询通过 ActiveHolders 登记，删除与关闭等待真实推理结束（CAS 拒绝不等于已排空）。
- 搜索池与票据只存身份、版本与摘要，不复制正文或查询文字，也不是实际使用依赖；删除时在原事务定向剪除受影响锚点，保留次数与无正文状态，不因删除未使用资料撤下无关候选。实际使用的资料沿既有闭包清除候选、运行记录与恢复副本。检索表示不能成为事实源，原始资料不被改写。
- 不迁移、删除或改写已有业务资料；历史材料沿原快照读取。

## DSH 与 DeepSeek 查证

声明、锁与实际解析的 DSH 包均为 `0.2.1-rc.2`，Cordis 为 `4.0.5`；参考源码固定到 `687f282e8625c6b8d11ff58211a90524be2e4317`，用 `git show` 只读查证，未切换相邻仓库工作树；核对了公开类型与安装制品的相关编译实现，不宣称整个制品与源码可复现构建逐字一致。工具通过公开 `defineTool` 与 agent scope 的 `tools.register` 注册；`restrict` 只限制全局工具，scope guard 与模型请求白名单同时约束新工具；官方 Agent loop 保存真实 tool call／result，既有取消、排空与 dispose 保留。

依据：[官方工具扩展](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/tools/src/index.ts#L1065)、[工具事件保存](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/agent-loop/src/tool-calls.ts#L263)、[取消与释放](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/agent-loop/src/index.ts#L541)。腾讯方案依据固定提交 `42d4cde50c5a83182fced8c584f9ddb32a620615` 的[分词](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/42d4cde50c5a83182fced8c584f9ddb32a620615/MemoryCore/src/core/store/tokenize.ts#L73-L150)、[L1 双路与 RRF](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/42d4cde50c5a83182fced8c584f9ddb32a620615/MemoryCore/src/core/tools/l1-candidate-recall.ts#L77-L173)、[L0 双路](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/42d4cde50c5a83182fced8c584f9ddb32a620615/MemoryCore/src/core/tools/conversation-search.ts#L178-L279)与 [SQLite 索引](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/42d4cde50c5a83182fced8c584f9ddb32a620615/MemoryCore/src/core/store/sqlite/memory-store.ts#L943-L1023)；NotAlone 保留更严格的 `owner_id + contact_id` 与冻结成员隔离，不照搬“先扩大候选再过滤”的路径。项目普通候选使用官方 DeepSeek Messages adapter，由官方适配器完整回放 thinking、tool_use 与匹配的 tool_result，保持自动工具选择，不为检索切换 strict Beta 传输（依据 [Anthropic 兼容文档](https://api-docs.deepseek.com/guides/anthropic_api/)、[Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode/)、[Tool Calls](https://api-docs.deepseek.com/guides/tool_calls/)）。

## 已失效取舍（不得当作新增要求）

- 固定取最近五条或草稿构造 L1 查询、初始 L1 预注入、生成前预计算向量。
- 0.8／0.2 加权综合分、0.48 门槛、0.15 词法阈值、字符预算与词典序入选排序、人工确认排序加成。
- 历史五百条候选窗口与逐条历史身份冻结、逐正文扫描评分、向量不持久化。
- 独立待确认候选检索入口及其 3 条／300 字符预算、旧回复词法回退与 `includeUnconfirmed`。
- 独立的“最多三次历史工具”预算与 `workspace_recent_only` 排除消息保守策略。

这些取舍的原因与数据保留在已归档的原 ADR 中，供追溯，不再约束新实现。

## 性能证据与验证边界

同一合成工作负载（Node 24.22.2；向量为 512 维替身，不代表真实模型推理时长）：

| 历史条数 | 原逐正文扫描 | 共享索引双路热查询 | 新读取正文 |
| ---: | ---: | ---: | ---: |
| 10 | 4.59 ms | 7.92 ms | 10 条 |
| 1,000 | 101.60 ms | 13.11 ms | 16 条 |
| 10,000 | 5,506.73 ms，超时无结果 | 52.15 ms，返回 16 条 | 16 条／256 B |

十／一千／一万条初始化均为二十八次读 SQL；一次冷向量准备约 10.80／227.67／8,095.23 ms。L1 连续三个查询的重复正文向量化由池大小的三倍降为零。原 ADR-190 记录的相关合成测试与独立审查结论保留在其归档正文中：合成供应商证明正式工具循环与材料传递，不能代替真实模型召回质量、真实 ONNX 冷准备耗时或微信端到端验收；这些仍须单独核验，本文不据此宣称完成。
