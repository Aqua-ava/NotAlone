# 05 检索兼容验证

2026-10-24，合成数据、本机公开固定权重；未读业务数据库、聊天、`.env` 或凭据，未操作 App/微信，未提交 Git。

## 导出契约与集成

- `retrieval-lexical.ts`：`tokenize`、`buildQueryTokens`、`scoreTokens`、`score`、`RELEVANCE_THRESHOLD=0.15`。NFKC+固定旧 casefold、Unicode码点首尾100采样、接缝分隔、中文uni/bigram、Latin词。保留匹配顺序。
- `retrieval-ranking.ts`：`recallMemories(rows, query|null, limit)`、`rankMemories(rows,tokens,limit)`、`mergeMemoryRecalls(recalls)`。输入 snake_case DTO，关系／本人用 `memory_id`，待确认用 `candidate_id`；`valid_at` 是带时区字符串或null。相关度、人工采纳、置信度、微秒时间、UUID稳定排序；pending不冒充人工；仅评分，不在此层应用上下文阈值或字符预算。
- 调用前必须由持久适配器按 owner/contact、活动来源、版本、有效期过滤；这些纯函数不访问数据库，也不承担范围授权。调用后原上下文层继续阈值、轨道数量/字符预算与来源复验；不能把纯函数通过写成HTTP来源隔离通过。
- `retrieval-hybrid.ts`：`bm25Scores(query,texts)`、`hybridCandidates(queries,pool,embed,topK=5)`；每次独立DF、BM25 k1=1.2/b=.75、余弦所有分值、每路topK、RRF k=60、同分UUID。保留旧零/负切片行为。`embed` 一次接收queries+pool完整正文，失败不回退词法。空pool零推理。
- `retrieval-embedding.ts`：`createLocalEmbedding(snapshot?) -> {encode,embed,close}`，默认固定本机snapshot；宿主显式持有/关闭本地session，不能按请求下载。`embeddingSnapshot(cache?)` 支持明确的cache路径，不读取私密环境配置。
- 主装配已固定依赖 `@huggingface/tokenizers=0.2.0`、`onnxruntime-node=1.30.0`。本子任务未修改package/lock/host/profile，不提供隐藏Python生产调用。测试中的Python仅作为独立基线。

## DSH及依赖依据

DSH锁定 `0.2.1-rc.2` / `687f282e8625c6b8d11ff58211a90524be2e4317`。核验官方源码快照 `packages/llm/llm/README.md:13-43`：provider调用归llm服务；本组确定性检索和本机embedding不涉及DSH直接接口，不增加远程provider、重试、工具或框架核心。正式宿主/profile执行由05主装配验证。

[固定DSH README](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/llm/llm/README.md)、[官方tokenizers 0.2.0发布制品](https://registry.npmjs.org/@huggingface/tokenizers/-/tokenizers-0.2.0.tgz)、[官方ORT 1.30.0发布制品](https://registry.npmjs.org/onnxruntime-node/-/onnxruntime-node-1.30.0.tgz)。阅读发布包README和types：Tokenizer(JSON,config)、encode、token_to_id；独立包没有padding/truncation API，固定BERT适配补CLS/SEP、正文510 token、batch-longest pad。ORT官方[create](https://onnxruntime.ai/docs/api/js/interfaces/InferenceSessionFactory.html)、[int64 Tensor](https://onnxruntime.ai/docs/api/js/interfaces/TensorConstructor.html)，并以实际安装类型检查和推理核验。

## 实际环境和模型

- Node 24.19.0 / Unicode17.0 / ICU78.3；Python Unicode15.0.0。
- Python FastEmbed0.9.0 / tokenizers0.23.3 / ONNXRuntime1.31.0 / numpy2.5.4；TS tokenizer0.2.0 / ONNXRuntime1.30.0。
- BAAI/bge-small-zh-v1.5，Qdrant固定revision `46fbe35fd4374a00fee7de77dfddaeb6dd6a2c59`。没有旧持久向量表，旧向量读取不适用。
- 明确准备命令：`HF_HUB_DISABLE_XET=1 HF_HUB_DISABLE_IMPLICIT_TOKEN=1 perl -e 'alarm 240; exec @ARGV' -- "$HOME/miniconda3/envs/NotAlone/bin/python" scripts/prepare_memory_embedding.py`。初次默认Xet下载未完成；恢复时核实无残留进程后执行上述命令，7文件完成、offline自检512维通过。仅公开匿名下载。运行时代码只有本地readFile及ORT文件加载，无fetch/download路径。
- 准备前卷可用148GiB；缓存由564KiB至103MiB，保留作运行所需公开模型。未建立新的业务向量表、正文或向量缓存。

| 文件 | bytes | SHA256 |
| --- | ---: | --- |
| model_optimized.onnx | 94781076 | 1294ea4b6331115a353d81f96b85e8c8d7fdcc284453d5b2fab5b016230aad38 |
| tokenizer.json | 439125 | 48cea5d44424912a6fd1ea647bf4fe50b55ab8b1e5879c3275f80e339e8fae26 |
| tokenizer_config.json | 367 | e6f3b96db926a37d4039995fbf5ad17de158dfb8f6343d607e4dbaad18d75f5a |
| special_tokens_map.json | 125 | b6d346be366a7d1d48332dbc9fdf3bf8960b5d879522b7799ddba59e76237ee3 |
| config.json | 739 | 9088751d39abbf86ec3d19ffca92ad62ad19075f7e59712e6c71217fa125d1d3 |
| vocab.txt | 109540 | 45bbac6b341c319adc98a532532882e91a9cefc0329aa57bac9ae761c27b291c |

## 实际验证

`"$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node" --test backend-ts/test/retrieval-*.test.mjs`：9/9通过；`node backend-ts/node_modules/typescript/bin/tsc --project backend-ts/tsconfig.json --noEmit`通过（同固定Node）。

1. 独立Python词法/BM25对照、全码点中兼容分解或大小写变化字符逐项对照。实际发现U+A7F1差异，固定37个新分解码点边界后通过；不能把JS lowercase/NFKC版本无条件视作旧Python等价。
2. 人工采纳/待确认、微秒先后、UUID、同ID最高分去重、空query、无评分复验、长query接缝及非BMP通过。
3. BM25池变化、零/负余弦仍参与、空/负topK旧切片、失败无词法回退通过。
4. 7个实际同权重合成输入：中文、全角/ß/非BMP、emoji/NUL、600字截断、特殊token、希腊/兼容字符、空串。IDs与attention mask逐项一致；int64输入、token_type_ids全0、CLS pooling、L2归一化512维；最大绝对误差 `3.690149324997449e-8`，预先门槛 `1e-5`。
5. 4查询、6条合成记忆含相同正文不同ID，实际本地embedding+BM25/RRF排名与旧Python完全一致；模型缺失抛embedding_unavailable。未以合成向量测试替代该实权重测试。

## 剩余边界

本次不是完整109例上下文召回门槛、HTTP/PG来源删除、真实质量评测或App验收；这些由05主任务继续。尚未证明不同CPU/ORT版本上的所有输入数值完全一致。Unicode表固定当前Node24/Python版本，上调运行时须重跑全码点对照。新旧检索运行责任交接与模型许可仲裁不在此纯函数模块内。

## 恢复后的完整本地冻结对照（2026-10-24）

21 的 `foreground-location-name-matching.ts` 直接依赖 `retrieval-casefold.ts` 的 `casefold` 与 `normalizationBarriers`；该静态模块无外部依赖，须包含在21归档闭包。固定 Python Unicode15 的casefold与NFKC兼容分解屏障不等同Node原生lowercase。名称匹配7例与检索Python对照2例合计9/9通过。

显式运行 `node backend-ts/test/retrieval-frozen-validation.mjs`，仅本地固定公开BGE权重和随机隔离合成PG；未启动App或DSH、未发送远端模型请求。固定 seed102 在观测前产生召回逐例AB/BA计划并打乱case顺序，每例每臂3次；向量按整批交替AB/BA，每批包含全部140原文和140固定词法查询，保持既有batch语义。完整计划及逐例结果见 [retrieval-frozen-results.json](retrieval-frozen-results.json)。

- 56份冻结材料SHA-256及109召回、140提取用例规范摘要逐项核对。
- 109召回×3：327/327与冻结旧臂精确一致，包含正文顺序、missing/unexpected、预算与order_ok；七维旧门槛两臂各3轮全部通过。
- 140原文×3：420/420 token IDs/mask精确一致，向量maxabs均低于1e-5；140查询对全池RRF排序420/420一致。
- 已见回归材料，不宣称盲测。旧臂冻结InMemory评测、新臂TS生产context加合成PG，不能据此比较性能。此项不覆盖HTTP/DSH/App或模型提取/回复质量，也不替代其他范围、取消、删除、来源资格合同测试。
- 首次运行因合成夹具重复source_locator触发数据库唯一约束，在任何有效对照结果前终止；修复为每消息唯一locator后完整重跑。没有修改材料或oracle。

实际最大向量误差：`1.1803593040482507e-07`。manifest SHA-256：`84b81a3255bffe8bc69da6f38c0dd79e1ba83510454ef8a9091c947b995b362b`；140原文及固定查询输入SHA-256：`7268f5f532dcc33da8e3f487e9b6a22e5e97b5be7a14d08c89d13880839bb3df`。
