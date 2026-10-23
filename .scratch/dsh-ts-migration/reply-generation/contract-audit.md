# 05 检索与模型调用合同独立核验

日期：2026-10-23；状态：只读准备完成，**05 未实现、未认领、未验收**。04 仍在其他会话实现，不以其工作树改动作为已验收基线。
旧业务固定点 `3c168296e9e8edaa43b8b323ff693e790e709069`；02 `fc8dcf50`；03 `9f39d6c2`。下述仓库源码行号指旧业务固定点，DSH 行号指下述完整 SHA；TS 02/03 证据按对应提交读取。
已读取 workflow、engineering、domain、issue-tracker、quality-diagnosis、领域索引及相关规格/ADR，遵循 ADR-102、任务05和比较协议。未改产品、任务状态、planning/execution；本文件由主会话提交。

## 一、结论与05边界

1. 02 已验证真实裁剪 profile＋DSH＋官方 provider 对本机合成 HTTP 的调用，不等于产品检索、回复、持久化和费用合同已实现。
2. **旧回复检索与本地向量召回是两条不同路径**：回复采用词法评分；BGE＋BM25＋RRF 用于记忆采纳的合并候选召回。没有旧持久向量表或向量索引可直接迁入，不能杜撰“读取旧向量已通过”。
3. 05 必须交付普通 TS 检索、模型适配、结构/引用校验、幂等保存、桌面显示及取消删除闭环；不得用隐藏 Python 调用包装为 TS 检索。后续记忆写入票承接业务采纳，但本票仍须按已定验收验证本地模型准备与跨语言兼容。
4. Python 优先级只在其进程内生效；当前没有已验证跨 TS/Python 的模型仲裁。旧 task resume、host stop、stdin pause 均不能替代可逆全局后台排空与恢复。
5. 旧台账有请求/token/时延/结果，没有实际费用金额及定价版本；05 必须明确已知、估算、未知费用，不能把 token 或诊断预留次数称为账单。
6. 只实施05基础能力；不提前实现06 Skill库、07探索、08讨论等完整迁移，但不能破坏这些仍由旧实现持有的公开合同及用户编辑。切换依赖04验收、唯一责任方、在途排空和兼容回退证据。

## 二、锁定DSH的公开接口、限制与02证据

固定版本 `0.2.1-rc.2`，官方 SHA `687f282e8625c6b8d11ff58211a90524be2e4317`；本机源码 `/tmp/notalone-dsh-official-687f282` 是源码快照、没有 `.git`，版本关联沿用02 tag/制品锁证据，不将目录名当独立commit证明。官方链接全部锁定SHA。

| 事项 | 官方原始依据 | 核验及05适配含义 |
| --- | --- | --- |
| 单次调用 | [llm README](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/llm/llm/README.md#use-this-package)、[prepareCall:956](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/llm/llm/src/index.ts#L956) | `ctx.llm.prepareCall(config, signal, configure)` 冻结解析后配置；返回stream只能派发一次。`ctx.llm.stream(options)` 本身不重试、不限流；调用者核验终态并负责业务资格。记录默认值解析后的参数，不能只比较环境变量。 |
| provider/协议 | [adapter:64](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/llm/llm-deepseek/src/adapter.ts#L64)、[发送:138](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/llm/llm-deepseek/src/adapter.ts#L138) | 官方 DeepSeek adapter 使用 Messages/SSE；idle watchdog 不是整轮绝对时限。业务应合并取消/截止signal，保留等待队列与实际执行期限的区别。匿名user/session头属于额外元数据，02已显式记录，不能宣称只有正文出站。 |
| 请求控制 | [GenerateOptions:529](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/llm/llm/src/types.ts#L529) | 有model/provider/reasoningEffort/messages/system/tools/temperature/maxTokens/stop/signal；无公开`response_format`、`tool_choice`、`top_p`字段，不能凭空传入。旧Chat Completions协议与Messages协议输入计量须分别证明等价；不能沿用旧计量profile冒充已覆盖。 |
| Agent生命周期 | [Agent示例:30](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/agent/README.md#use-this-package)、[create signal:98](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/agent/src/index.ts#L98)、[dispose:541](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/agent-loop/src/index.ts#L541) | create/setup后followup；创建signal仅覆盖创建。运行时cancel、whenIdle和handle.dispose分开；dispose等待不合作Promise，不能据此保证及时退出或PG回滚。 |
| tools/结构输出 | [tools示例](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/tools/README.md#register-a-tool)、[register:1071/guard:1144](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/tools/src/index.ts#L1071) | scope内defineTool/register/guard；身份绑定闭包，不接受模型切换owner/contact。严格文本JSON可行但仍需完整产品schema和来源校验；若用输出工具则校验成功终态、重复提交和最终事务。不能deep-import私有subagent structured helper。 |
| 用量/费用 | [TokenUsage:175](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/llm/llm/src/types.ts#L175)、[translate:159](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/llm/llm-deepseek/src/translate.ts#L159) | inputTokens为未缓存输入，cacheRead/cacheWrite互斥计数另加；不能直接当旧总prompt_tokens。正常message_stop才发最终usage，断流可能没有；未返回usage不等于0。框架usage不是价格账本。 |

02实证来源：`.scratch/dsh-ts-migration/runtime-validation/progress.md:30`、`tests.txt:1`、`interface-crosscheck.json:1`；记录14/14通过，但本次未复跑。02的允许清单见 `backend-ts/profile/cordis.patch.yml:1`；不启用retry、compaction、title、JSONL、Shell或外发工具。
`backend-ts/src/runtime.ts:4` 单次语义、`:23`三次有界循环；`business.ts:4`仅四个合成范围Map，`:14`校验 `{text,evidence}`。`lookup_source`不是产品历史检索，合成删除不是PG来源删除，`deepseek-v4-flash/maxTokens256`不是产品模型配置。
02真实网络只到本机Messages替身；取消、429/500/断流、未知范围、伪造参数、强制退出均有证据。目录快照仅临时配置和匿名ID，不是OS沙箱证明。03生产宿主 `backend-ts/profile/host.patch.yml:1` 没有模型provider；模型业务目前仍由旧后端执行。
旧 `reply/adapters/deepseek_provider.py:13` 默认 `deepseek-flash`、60秒、temperature0；`:78`通用构造器重试默认2，但生产 `server/reply_wiring.py:144`显式0，`:209`拒绝缓存/隐藏重试。05不能将02示例模型或协议直接当等价替换。

## 三、本地embedding、分词、排序与准备门禁

| 边界 | 固定源码证据 | 实际行为及普通TS风险 |
| --- | --- | --- |
| 模型/准备 | `backend/pyproject.toml:12`；`scripts/prepare_memory_embedding.py:9`；`backend/src/notalone/memory_extraction/recall.py:22` | FastEmbed==0.9.0，BAAI/bge-small-zh-v1.5，Qdrant snapshot `46fbe35fd4374a00fee7de77dfddaeb6dd6a2c59`；显式准备脚本允许下载JSON/TXT/ONNX并自检512维。运行仅固定snapshot、local_files_only、threads2；缺文件/推理失败报embedding_unavailable，无云端或词法静默兜底。 |
| 输入与向量 | `memory_extraction/recall.py:36`、`:46` | 同次embed包含所有query及完整pool正文，未额外加query指令或手工截断。运行只核验同维、非空、finite，不强制512；准备脚本512维断言不可误报为运行门禁。 |
| 持久化/索引 | `memory_extraction/recall.py:1`、`:46`；`memory_extraction/adoption.py:762` | 模型对象缓存，向量/语料只属一次调用，未保存向量；database中vector/embedding/hnsw/ivfflat检索无命中。现有“旧向量读取”应先记录不适用，再验证同一已准备权重和同输入数值/排名；不能凭空增建向量索引。 |
| BM25/融合 | `memory_extraction/recall.py:42`、`:77`、`:82` | tokenizer后过滤长度<2，query去重；BM25 k1=1.2,b=.75；词法仅正分，语义包含0/负cosine。余弦显式除范数，零范数得0；每路top5，RRF k=60，最终top5，同分按memory UUID字符串。没有cross-encoder重排模型。 |
| 回复词法 | `retrieval/lexical.py:13`、`:57`、`:112`；`retrieval/ranking.py:228` | NFKC+casefold、中文uni/bigram、Latin词；查询取Unicode码点首尾100并隔开接缝。回复按相关度、人工采纳、置信度、时间、UUID稳定排序；不是上述RRF。JS lowerCase、UTF16 slice、localeCompare不能直接当等价实现。 |

额外只读实现证据（不当新的官方依赖采纳）：本机 `$HOME/miniconda3/envs/NotAlone/lib/python3.12/site-packages/fastembed-0.9.0.dist-info/METADATA:3`为0.9.0；其 `fastembed/text/onnx_embedding.py:80`声明中文512维/512 token，`:366`对3D输出取CLS后normalize；`common/utils.py:18`为L2、eps=1e-12；`common/preprocessor_utils.py:74`从模型文件加载tokenizer、截断配置，`:114`批内最长padding；`text/onnx_text_model.py:88`为int64 IDs/mask、token_type_ids全0。这里只读库源码，未读模型权重或执行推理。
底层numpy/onnxruntime/tokenizers在FastEmbed元数据中仍是版本范围，仓库只固定FastEmbed并不足以冻结全部数值环境。05需记录实际版本、模型文件摘要、token IDs/mask/pooling/归一化及浮点容差，再比较向量和排序；现有材料不证明任何TS运行库能直接复现。
本审计不推荐或采纳新TS依赖。后续选择必须先给固定官方版本/本地ONNX与tokenizer支持证据，再做同权重合成对照；任何尚未运行的支持声明只能标“未实测”。禁止隐藏调用旧Python、运行时下载、云embedding或偷换权重。
最小反例：`ß`的casefold为`ss`而JS lowerCase仍`ß`；`𠀀`的UTF16截断；全角`ＴＥＡ`；长文首尾接缝假bigram；同分UUID；零/负向量；相同正文不同ID；更换pool后重算DF；模型文件缺失时零下载且明确失败。

## 四、基础回复公开合同

以下路径省略 `backend/src/notalone/`；`server/app.py`行号严格来自旧固定点（当前04正在改此文件）。

| 边界 | 源码 | 05必须保持 |
| --- | --- | --- |
| HTTP/范围 | `application/reply_request.py:29`、`reply_service.py:121`；`server/app.py:1708` | idempotency_key/contact_id/content与三种input_mode；owner来自宿主。先历史覆盖，再手动确认或真实绑定核验；同键改输入为reply_input_conflict，坏引用为reply_candidates_rejected；不能只接任意contact_id。 |
| 输入/无历史 | `reply/context.py:436`、`:500`；`reply/adapters/langchain_runtime.py:1020` | 仅model_visible证据出站，保留ID/kind/factual_role/speaker/status/selection_reason/time；pending必须保留未确认语义。无历史可有user_purpose输入证据，不捏造历史。 |
| 输出/引用 | `reply/generator.py:429`、`:467`、`:228`；`reply/adapters/langchain_runtime.py:868` | 校验预算回执、usage、工具轨迹、1–3候选、非空正文/basis/UUID、消息组一致性/risk_notes；引用必须在本次合并快照且仍有效。旧ToolStrategy handle_errors=False；不能隐式追加格式修复或语义复核请求。 |
| 幂等/提交 | `reply/generator.py:117`、`:146`、`:164`、`:207`、`:248`；`persistence/reply_store.py:142`、`:421`、`:450`、`:484` | 完成重放不调用模型，在途重复冲突；发送前/返回后/最终事务复验。owner锁、request锁、attempt/租约、失效键及来源/讨论/记忆/Skill版本都是提交条件；DSH cancel不替代事务栅栏。 |
| 编辑/选择 | `server/assistant_candidate_versions.py:25`、`:110`；`persistence/assistant_candidate_versions.py:157`、`:333`、`:349` | versions/selections路由与edit_key/parent_version_id保持；1–8条消息组，版本追加不可变，同key改正文冲突；编辑不调用模型、不自动选择。责任交接保留用户版本与选择，旧重放不能恢复原稿覆盖修改。 |
| 删除/晚结果 | `persistence/reply_store.py:450`；ADR-068 | 删除、取消、租约失效后晚响应不得写入或复活来源/讨论；已经发生的物理调用仍记账。生成后不增加语义复核，不提供外部发送工具。 |

最小反例：A请求引用B的合法UUID；同key“明天见”换“后天见”；text与messages正文矛盾；唯一来源删除后放行模型；旧attempt取消后新请求成功再收到旧响应；edit_key E已保存V2后重放V1。分别断言拒绝/幂等、零额外调用、无迟到提交、用户修改保留；不能只看HTTP 200。

## 五、物理预算、费用与跨进程仲裁

- `reply/adapters/input_budget_middleware.py:105`、`:140`绑定实际模型、计量最终输入/工具schema和输出预留，禁止路由与嵌套输入覆盖；不可测/超预算在发送前失败。DSH token-meter或预估字符数不能自动证明旧协议等价。
- `reply/adapters/langchain_runtime.py:674`为最多20秒生成期限；`:882`逐轮计量；`:915`的`16 + 2 × scenario.call_limit`是图递归上限，不能称物理请求预算；`:946`退出补结未完成台账。
- `reply/adapters/model_call_ledger.py:25`按run_id记录成功/异常，取消补记pending、迟到回调去重；`:62`固定provider=deepseek，移植不能盲沿用。`ledger/models.py:20`、`:47`仅token/时延/计数，无金额/币种/定价版本/账单核对。05需物理attempt身份与实际发送数对照，缺usage/费用明确unknown。
- `application/model_priority.py:36`通过进程内Condition/Event共享；前台登记后阻止新后台，等在途后台结算，再整轮独占；后台每次物理请求领取许可。`:429`在生成器/租约/20秒计时之前等待。`:61`stop不可resume；调用方超时不能当供应商已停止。
- `application/import_service.py:300`停host并关连接；旧`server/app.py:2504`恢复单个memory-processing task；`application/layered_memory_service.py:201`pause/continue只覆盖整理任务。没有证据说明它们能暂停全部提取、核验、裁决和Skill学习物理请求。
- 03的`backend-ts/src/host-plugin.ts:26` stdin.resume及收尾pause属于寿命管道；`legacy-backend.ts:71`是shutdown，不是模型许可。当前TS源码没有已验证统一模型仲裁。05应实现共享许可或覆盖全部后台的可逆暂停/排空/恢复，并验证进程崩溃/取消后的许可归属；本审计不擅自确定其架构。
- `docs/agents/quality-diagnosis.md:23`问题总账默认8预留/30分钟，只约束绑定的诊断路径；无suite旧transport不受它覆盖，预留失败不退款且不等于实际HTTP/金额。不得借本审计授权模型执行或用新账本重置累计预算。

最小并发反例：Python B1已发送挂起→TS前台F登记→Python B2就绪；B2不得发，F等B1真实结算后整轮独占，结束后B2才发。两边各限流1却总在途2必须失败。另测排队超过20秒后仍有完整生成期限、首轮工具返回导致第二轮超预算仅一次发送、取消后晚usage只记一次、429隐藏重试使真实发送数大于账本数必须失败。

## 六、具名复用测试及05最小验证顺序

以下均为**已存在但本次未运行**的Python选择器；从backend执行工程约定的`python -m unittest <selector> -v`，05移植其外部断言，不继续依赖LangChain fake model作为TS实现。

```text
tests.unit.retrieval.test_lexical.TokenizeTest.test_non_bmp_cjk_is_tokenized
tests.unit.retrieval.test_lexical.QueryTokensTest.test_head_tail_seam_does_not_create_false_bigram
tests.unit.retrieval.test_ranking.RankMemoriesTest.test_memory_id_breaks_remaining_ties
tests.unit.memory_extraction.test_recall.HybridRecallTest.test_semantic_zero_and_negative_scores_remain_candidates
tests.unit.memory_extraction.test_recall.HybridRecallTest.test_top_k_preserves_each_ranking_slice_and_final_id_ties
tests.unit.memory_extraction.test_recall.HybridRecallTest.test_unavailable_embedding_propagates_without_fallback
tests.unit.memory_extraction.test_recall.Bm25RecallTest.test_chinese_bigrams_unicode_normalization_and_short_token_filter
tests.unit.retrieval.test_recall_evaluation.RecallEvaluationGateTest.test_all_dimensions_meet_gate
tests.unit.reply.test_generator.ReplyGeneratorTest.test_rejects_candidate_with_reference_outside_context_snapshot
tests.unit.reply.test_generator.ReplyGeneratorTest.test_rejects_context_that_becomes_stale_after_model_run
tests.integration.server.test_reply_api.ReplyApiContractTest.test_history_gate_cannot_be_bypassed_by_direct_api
tests.integration.persistence.test_postgres_reply_store.PostgresReplyStoreTest.test_same_key_conflict_and_valid_lease_are_atomic
tests.integration.server.test_reply_message_groups.ReplyMessageGroupHttpTest.test_groups_replay_with_stable_message_identity_in_both_scenes
tests.integration.server.test_assistant_candidate_versions.AssistantCandidateVersionsHttpTest.test_scope_parent_group_and_selection_key_conflicts_keep_existing_history
tests.integration.server.test_assistant_candidate_versions.AssistantCandidateVersionsHttpTest.test_source_pending_and_deletion_erase_current_without_reviving_old_selection
tests.integration.server.test_assistant_generation_lifecycle.AssistantGenerationInterruptionHttpTest.test_quit_invalidates_running_generation_and_late_response_cannot_replace_explicit_retry
tests.integration.persistence.test_source_reply_deletion.SourceReplyDeletionTest.test_in_flight_reply_cannot_restore_deleted_source
tests.integration.server.test_model_priority_lifecycle.ModelPriorityLifecycleHttpTest.test_reply_waits_for_active_extraction_then_holds_priority_until_complete
tests.integration.server.test_model_priority_lifecycle.ModelPriorityLifecycleHttpTest.test_foreground_wait_longer_than_runtime_and_request_lease_still_succeeds
tests.integration.server.test_model_priority_lifecycle.ModelPriorityLifecycleHttpTest.test_stopped_late_extraction_retains_one_minimal_outbound_record
tests.integration.server.test_assistant_input_budget.AssistantInputBudgetHttpTest.test_tool_material_exceeds_limit_before_second_actual_model_call
tests.integration.server.test_assistant_input_budget.AssistantInputBudgetHttpTest.test_unknown_measurement_returns_explicit_metadata_and_zero_model_calls
tests.unit.reply.test_input_budget_provider_boundary.InputBudgetProviderBoundaryTest.test_sdk_invalid_tool_calls_remain_counted_before_second_model_round
```

05先静态锁定输入/模型/配置→最小词法/结构反例→同权重本地向量对照→HTTP合成PG持久化/删除/编辑→TS+Python跨进程物理请求仲裁→按协议进行有授权的模型与桌面验收。不是在本审计执行上述步骤。
使用 `baseline/evaluation-protocol.md:22` 的冻结材料/参数/分母；109召回、140提取、16回复等不能缩为精选成功样例。协议规定的完整模型对照不在默认诊断8次预算内；需要按原授权边界办理，不能将02本机替身延迟当真实模型性能。

## 七、本次验证、数据影响与限制

已执行只读 `rg/sed/nl`、`git show`、`git diff <旧基线> --stat -- <相关源码>`；核心reply/retrieval/recall、持久化及优先级证据无业务差异，当前04改动单列排除。读取02报告/测试源码、锁定DSH文档/源码/官方示例；打开固定SHA官方types页面核验公开来源；读取本机FastEmbed库源码，未导入运行。
使用指定NotAlone Python作AST静态校验：23个测试选择器（含1个继承方法）、37处路径/行号和12条固定官方链接均可定位，无尾随空白；首次通用python命令不可用，改用指定绝对路径完成。已完成本文源码路径/行号及具名测试的静态校验；这只证明引用可定位，不证明业务测试通过。02历史14/14、01既有109例门槛通过均不是本次重跑。
未执行测试、DSH、App、微信、模型、数据库；未读取.env、凭据、私聊或真实DB；未安装依赖、下载模型、打包或push；未add/commit。只新增本审计文件，无产品数据处理或删除，无运行时缓存/进程需清理。
剩余风险：TS分词/ONNX数值尚未实测；Messages与旧Chat Completions参数/预算等价尚未证明；跨进程仲裁、费用账与PG迟到提交仍是05交付项；04未验收，本文不解锁05实现，也不承担05最终验收。
