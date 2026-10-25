# 迁移前预注册的质量、延迟与费用比较协议

版本：`migration-comparison-v1`；日期：2026-10-23；Python基准：`3c168296`。本协议在TS迁移结果产生前冻结；本次只建立协议，不授予真实模型调用、数据库或App执行授权。指标是工程验收判据，不是用户承诺、已有实测或生产资格。02—26按前置和各票授权执行，不因本协议提前实施。

## DSH官方依据与适配理由

候选 `687f282e8625c6b8d11ff58211a90524be2e4317`（根版本0.2.1-rc.2，02固化），证据核对方法见 [运行清单](runtime-inventory.md)。[官方架构](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/docs/architecture.md#application-launch)要求profile启动；性能比较必须含真实profile后台及普通TS业务，而不是只测一个裸模型SDK。[模型文档](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/llm/llm/README.md#use-this-package)及[源码956行](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/llm/llm/src/index.ts#L956)说明模型控制默认值和路由在prepareCall解析，stream是物理尝试；故记录解析后的控制参数、实际请求及失败费用，不能只比较环境变量名称。[Agent取消源码183行](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/agent/src/runtime-types.ts#L183)只证明公开取消接口存在，不能代替迟到落库和实际HTTP计数验证。[minimal配置20行](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/bundle/sdk-minimal/cordis.patch.yml#L20)含额外会话相关插件，02须捕获合成出站和文件行为后才能进入模型对照。

本协议不调用DSH接口；结构化输出、参数等价、取消和临时会话组合尚未运行验证。

## 原有证据，不能误当新基线

| 材料／来源位置 | 原有范围和门槛 | 本轮用途／限制 |
| --- | --- | --- |
| `docs/memory-recall-evaluation-baseline.md:13`，`backend/src/notalone/retrieval/recall_cases.py:1` | 109例：15直述、15改写、15无关、15跨联系人、18失效/删除、16预算、15排序；直述≥0.90、改写≥0.60、排序≥0.90，其余违规0 | 保留所有既有断言；历史109例门槛通过不代表TS已测、向量已兼容 |
| `backend/src/notalone/memory_extraction/evaluation_cases.py:87`、`semantic_evaluation_cases.py:280` | 此基准实际123＋17＝140例；time24、subject20、truth_intent20、paraphrase20、reference19、reported17、media16、condition3、quantity1 | 全部入组，不精选成功例；有strict oracle才做自动命题判定，其余需独立语义标注 |
| `architecture/adr/027-memory-accuracy-evaluation-gate.md:25` | 旧显式协议每维≥15，假事0、记错人0、一般错误≤1；后续ADR改变生产资格前置，不抹去历史协议 | 不能将condition3/quantity1宣称维度达标；也不能把旧放行机制重新引入生产 |
| `docs/memory-extraction-evaluation-baseline.md:26` | 原24例、119次成功等是历史局部实验，存在初始非法输出与未标注语义 | 保留历史失败；不把不同模型、日期和材料的tokens/耗时拼成当前旧版基线 |
| `backend/tests/fixtures/fidelity/synthetic-v1.json:1`、`controlled-v1.json:1`；`docs/authentic-expression-offline-evaluation.md:13` | 16例，4开发＋12保留；controlled故意含14错误、1超时、1缺失，质量未验证 | 16例输入用于回复比较；controlled仅测评分器，不当旧模型输出，不用正则声称自然度 |
| `backend/README.md:50`，`backend/src/notalone/experiments/organization_quality_suite.py:12` | 既有整理协议120例（8类各15），反馈/更正支线另列；历史800物理请求为特定轮次授权 | 本轮不继承该费用授权，不读取私有suite；L2/L3/学习用下面新增合成覆盖，120正式资格另在承接票办理 |
| `backend/README.md:205`、`:225`，`backend/src/notalone/experiments/reply_comparison.py:369` | 产品生成后复核已退役；快速对照默认零调用，原上限每组6、总48 | 不恢复额外复核模型；评分用独立Agent离线审阅，不能借历史48上限授权本轮执行 |

## 固定材料、配置与重复次数

1. 冻结基准树、TS候选提交、DSH框架及插件锁文件摘要、profile最终展开配置、Python依赖锁摘要、操作系统/CPU/内存/电源模式。材料从基准Git树导出，按文件SHA-256和case ID排序生成manifest；正文、标签、提示词、schema、Skill版本、时间、owner/contact合成身份、来源版本、排序与预算均入摘要。禁止读取真实业务库，禁止运行时抽样或看结果后换case。
2. 对照两臂只改变框架/语言适配。供应商、端点、请求model、响应model/fingerprint（不可得写unknown）、temperature、top_p、thinking/reasoning、输出上限、stop、timeout、重试、工具schema、提示词、上下文、检索返回、随机种子（仅双方支持时）完全相同。源码默认 `deepseek-flash` 不是运行时认证；不能直接换成DSH示例 `deepseek-v4-flash`。如同一控制参数无法实现，02记录冲突，不能归因“框架更快”。
3. 主比较先固定上下文和检索返回，隔离模型适配差异；再经HTTP业务入口使用真实检索/PG合成资料做集成比较。二者分表，不将stub模型时间当真实模型延迟。
4. 质量主集：140提取＋16回复，每例每臂3次，共936次逻辑运行；逻辑运行可有多次物理请求。复用已公开的保留集时标记“已见回归”，不能宣称盲测。提取每次都核对提取及来源核验结果；回复每次整组候选评价，不能只挑最好一条。
5. 新增工程集（材料已冻结于 [organization-learning-cases.json](organization-learning-cases.json)，摘要与case ID见 [material-manifest.json](material-manifest.json)）：L2整理、L3画像、Skill学习各12例，每臂3次，共216逻辑运行。每域按来源充分/不足、支持/冲突、有效/删除的2×2×2组合各1例，再加跨联系人、错误主体、取消迟到、显式修正各1例。输入、来源状态、事件顺序和作者预期断言均已冻结，未使用模型输出反向造oracle。主会话可独立复核范围/删除/取消/来源版本/草稿不发布的硬断言；充分性、冲突和主体语义仍需独立复核，未完成不得声称质量已通过。不得减少分母；不替代原120例正式资格。
6. 确定性集：109召回＋现有范围/引用/删除/预算/生命周期合同全量通过；使用合成响应替身每例每臂3次。向量兼容另用140例原文与固定词法查询，双方同本机权重、分词词表、归一化和512维；不下载新模型、不发云embedding。
7. 最小阶梯：先离线评分器和单例合同，再确定性模块，再真实模型先导，最后冻结全量。默认诊断累计预算8次物理请求/30分钟，遵循 `docs/agents/quality-diagnosis.md:23`；全量1152逻辑运行显然不在默认预算内，未来必须明确授权供应商、合成材料、累计物理上限与时长后才能执行。上限由每例固定最大步数加总，两臂等额分配，失败/超时/取消均扣额度；每个子runner同时保留原更小预算，不得拆账规避。额度不足即未完成，不缩成“全量通过”。


### 迁移前材料摘要

以下SHA-256取自`git show 3c168296:<path>`，防止未来材料改变却沿用本协议；完整 [material-manifest.json](material-manifest.json) 已冻结140提取、16回复、109召回和36新增材料的case ID及逐例规范化摘要，并记录实际材料文件及定义导入依赖的SHA-256；每份旧源码均核对与基准Git blob一致。共301例。运行器须核对全部摘要后才执行，不得按运行时新定义重抽样。

| 文件 | SHA-256 |
| --- | --- |
| `backend/src/notalone/memory_extraction/evaluation_cases.py` | `e0ddbede2caa2d196a3aa33f98f59d78db099163e67758d0ed21397e14ce8327` |
| `backend/src/notalone/memory_extraction/semantic_evaluation_cases.py` | `d3224647dcdae69fc76b7e6cd33a83be38360b192278ab9081609e598201fda3` |
| `backend/src/notalone/retrieval/recall_cases.py` | `310f6102e8d0f0c1a0d971fc22436b6fa346ae1cfb462aa932f5e8bfe52b1c03` |
| `backend/tests/fixtures/fidelity/synthetic-v1.json` | `088df6b1729c5b9445e1648e495e4bde005580eb838216e84d3ba569caebe607` |
| `backend/tests/fixtures/fidelity/controlled-v1.json` | `f9c93b60f3bfe7cee8e83a28a313b76f2dde5a0cec94a0a3e13a4f1f23de6623` |

## 质量评分与判定

- 硬合同：联系人/owner越界、已删来源复活、伪造或无效引用、未授权正文出站、自动外发、取消后迟到提交、预算绕过、结构非法视成功，任何一次即阻止对应切换；质量平均分不能抵消。模型不确定性不能豁免确定性外壳。
- 提取：逐命题计主体、事实真实性、时间、否定/条件、数量、来源、去向正确性；报告precision/recall/F1、逐例通过率、假事/错人绝对数和所有未知。自动oracle仅评其明确编码字段；独立审阅其余语义，保持原旧门槛和样本不足提示。
- 回复：依据正确性、当前意图保持、无新增事实/承诺、关系适配、中文可编辑可用性分别打0/1/2分（0不可用/错误、1需实质改写、2可小改使用）。全部候选都满足事实/意图要求才算该组通过；最后两项平均分≥1.5且无0才记可用。不测“像用户本人”——没有私人风格资料。
- L2/L3：来源支持、主体/时效、矛盾不抹除、明确纠错可追溯；Skill学习：范围、方法依据、草稿状态、版本和审核前不发布。按例完整通过率、错误及未知报告。
- 盲化两臂为A/B并打散顺序；两名独立审阅者（可为Agent，但必须标Agent而非人工）先独立评，分歧由第三位复核。记录实际审阅模型/版本、理由与证据绑定摘要；不额外调用产品模型充当隐藏评审费用。不允许修改输出后评旧运行。
- **本次新工程门槛**：除既有硬门槛外，每域TS总体通过率相对旧版下降≤3个百分点，回复可用性均分下降≤0.10（0—2分）；严重假事/错人/无依据承诺新增数为0。按case聚类（3次不能当3个独立样本）做10000次paired bootstrap，固定种子102；通过率差的95%区间下界需≥−3pp，均分差下界≥−0.10。证据量不足导致区间未满足记“未定”，不能按均值宣布通过。已知旧失败完整列出，不把达到相对门槛当绝对质量合格。

## 性能、费用与噪声

| 指标 | 采集与样本 | 本次新工程退化门槛 |
| --- | --- | --- |
| 启动到业务ready | 同机器单实例，旧/新各20次交替进程冷启动；模型缓存状态固定；不宣称OS冷缓存 | 中位数、p95分别≤旧版1.20倍 |
| 空闲内存 | 每次ready后稳定60秒、每秒采样；20次启动各取中位数；统计后台整个进程树RSS，Electron另列；禁止双臂同时运行 | 运行中位数、p95≤旧版1.20倍 |
| 本地确定性HTTP延迟 | 同合成库快照、同工作负载，10次不计分预热＋每例30次；计入口接收到响应完成、持久写入完成；事务/队列时间单列 | p50≤1.15倍、p95≤1.25倍 |
| 模型端到端 | 质量主集每例3次；首事件、首token、最终持久结果分别计；区分排队、检索、网络/模型、校验和持久化 | 最终结果p50≤1.15倍、p95≤1.25倍 |
| 物理调用数 | HTTP发送边界累计，逻辑运行/工具轮/重试与物理次数分列；失败取消不退款 | 总次数≤旧版1.05倍；固定单调用合同不得新增隐蔽请求 |
| token和费用 | input/output/reasoning/cache-hit/cache-miss分别记录；按同一供应商价目快照计算两臂，同一币种及计价日期；未知不能填0 | 总token、总可比费用分别≤旧版1.10倍；每域也须通过 |

启动/内存/本地HTTP是离线宿主测试，由03/25实现有界采样，不在01启动App。模型失败样本计失败率和截至失败时间；超时按观测下界单列，不当更快成功；成功延迟另报，TS失败率不能高于旧版，硬失败单列。旧值为0时不用比值：调用/费用要求新值也为0，其余指标标不可比较并补基准，不能自行设无限容忍值。

每case三次以固定种子102安排AB/BA、AB/BA、AB/BA交错顺序，同一对尽量连续，限制并发为1；业务并发压测另用既有上限单列。固定机器、电源、版本、网络路径与数据，模型服务响应版本变化则拆分不可混算。随机缓存命中不能删除，只分层报告冷/热命中、时段与负载。报告全部观测、median/p95、配对差和bootstrap区间；性能比值95%区间上界也须不超过门槛，否则记未定。公开服务模型漂移只能声明“同请求配置”，无法辨认底层版本则模型等价结论保持有限。

禁止因性能差删除异常值或只重跑输的一臂。基础设施中断须记录事先可验证原因；保留原始失败及累计费用，新一轮两臂成对重跑且另经预算许可。连续两轮无改善/累计预算耗尽按诊断工作流停止，不事后放宽阈值或改样本。

## 可执行入口与后续适配

以下离线命令已存在，均从仓库根运行，使用合成材料；第一条只输出6例in-memory检索合同（不是109例记忆召回）：top_k命中5/6，同义表达例empty，跨联系人foreign_hit=0；延迟固定0是占位值，不能作为实测性能。109例由单独的召回测试模块验证。两者均不冒充真实模型或PG验证：

```sh
PYTHONDONTWRITEBYTECODE=1 NOTALONE_DISABLE_DOTENV=1 PYTHONPATH=backend/src "$HOME/miniconda3/envs/NotAlone/bin/python" -m notalone.retrieval.evaluation --json
PYTHONDONTWRITEBYTECODE=1 NOTALONE_DISABLE_DOTENV=1 PYTHONPATH=backend/src "$HOME/miniconda3/envs/NotAlone/bin/python" -m notalone.reply.fidelity_evaluation --dataset backend/tests/fixtures/fidelity/synthetic-v1.json --run backend/tests/fixtures/fidelity/controlled-v1.json --output /tmp/notalone-migration-fidelity.json
```

未来模型入口 `python -m notalone.memory_extraction.evaluation --case <固定名称>` 的CLI见 `evaluation.py:497`，它会调用模型，不在本次执行；没有problem总账覆盖证明前不得直接使用。快速回复 `python -m notalone.experiments.reply_comparison --input-package <冻结合成包> --output-directory <新目录>` 默认零调用；执行参数与预算见 `backend/README.md:225`。整理suite的 `create --manifest ... --directory ...` 见 `organization_quality_suite.py:12`，仅能使用未来新建合成套件，不指向历史私有suite。所有例子未来按运行机器替换解释器绝对路径。

TS成对runner尚不存在，由05/10/13/14/15/25承接；不得把上面Python命令伪称跨框架对照。runner交付需实现：只接受冻结manifest；逐次合成作用域；安全库校验；同配置；持久累计物理额度；取消与timeout；原请求/响应摘要和业务输出绑定；独立审阅；生成统一report。未完成这些适配保持待执行。

报告最少字段：protocol_version、old/new_commit、dsh_commit、lock/profile/material/config_hash、case_id、domain、arm、repeat、order、synthetic_scope_id、actual_model/fingerprint、started/ended、latency阶段、terminal_status、logical/physical_calls、usage各类、price_snapshot、cost_known/cost、citations、deterministic_checks、reviewer_type/version、semantic_scores、unknown_reason。正文仅合成证据存独立目录，不写运行日志；不保存密钥，不上报完整会话。报告附样本流转（计划/完成/失败/取消/缺失）和全部失败ID；未知覆盖率不能藏在通过率分母外。

## 本次真实验证与未完成项

主会话后续已独立复核新增36例材料的硬规则与给定语义，见 [材料复核](material-review.md)。冻结文件保留作者原始草稿声明；此补充不代表任一模型输出已经通过，原有提取集缺失的语义标注及未来输出盲评仍需完成。

只读官方固定源码与本仓基准；统计case定义确认140及维度数；静态核对CLI参数、材料来源与旧阈值，实际运行本页两条离线命令均退出0；保真报告保留16例、14语义失败、2合同失败、2未审阅、quality_verified=false，属于注入坏输出的预期结果。另在backend目录运行 `python -m unittest tests.unit.retrieval.test_recall_evaluation -v`：8个测试通过（0.011秒），覆盖109例既有门槛。文档路径与行号静态校验无无效项。本次无真实模型、数据库、embedding推理、DSH或App运行，费用与延迟全部未测。已新增36例合成材料和301例manifest并校验数量、唯一ID及摘要；这只是材料冻结，不是模型执行。旧版实际配置快照、成对runner、oracle独立语义复核、真实模型预算授权、两臂完整实测和盲化审阅均为承接票待执行项；不构成01之外工作已完成的声明。
