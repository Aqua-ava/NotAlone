# v3本人经历与第三人陈述kind指导的离线方案

日期：2026-10-16。Triage: ready-for-agent。State: resolved。离线提示单叶、相关验证及独立双轴均完成；真实分类收益未实测。固定审查基线`85ca9ea782ee6272a7fbd5647d81379b7b554cf1`。本片只做显式v3提示及合成Mock验证，不提交、不发模型请求、不建预算、不读凭据、不操作桌面／CLI；后续新policy、freeze、预算及实测由主Agent另行准备。

## 问题与证据

[原公开部分基线](deepseek-public21-result-20261015.md)的A03原句为“他昨天又跟我借钱了。”。只读原A03 raw投影的`extraction_protocol`可确认模型实际选择`kind=relationship_event, subject=contact, topic=finance, dependency=null, unresolved=true, confidence=0.8, sensitivity=financial`。程序忠实映射为assertion／asserted，双null、financial、原句及未知人物保留；原Gold要求report／reported、未知第三人、借用方向及未证交付边界、双null、pending。原字段与V审核失败均保留。

这是真实模型标签与冻结契约的差异，不是假设schema缺类或确定性mapping出错。现有schema已经包含reported_event，现有映射已经是reported_event→relationship_note／report／reported。旧提示将relationship_event定义为本人已参与的关系经历（含邀请、借用、赠予），reported_event定义为第三方历史经历；原句“我”作为第三人行动的关系对象，可能与本人实际参与／交付边界混淆，但没有受控实验能证明成因。本片仅提出补充角色与阶段指导的假设，不认定提示是原因，也不声称已修复真实分类。

## Implementation Decisions

仅在显式grounded-v3提示补充现有relationship_event与reported_event的选择边界：本人明确已参与的关系经历仍可relationship_event，已收到邀请、实际接收或借用有据时不因对方身份未知一律转述；第三人行动陈述可reported_event，出现“我”作关系对象不自动证明交易完成或实际交付，也不据此升级本人经历。按来源角色与阶段判断，不按“我”、未知人物或借钱词命中强转；否定、条件、引语与未证交付保持原状。

保留已有financial和多码指导；不增加report枚举，不改共享KINDS、typed compiler、schema、默认装配、V、采纳、proof、评分或任何旧plan／Gold／冻结／结果。v2提示UTF-8摘要仍应为`8580e630bbc4d600b08beb8a607cfcc05dc3efeb7daacc98a9f95bcb6164a01b`。旧A03给定relationship_event仍必须编出原结果；显式给定reported_event只走既有映射，不能自动修旧标签。

## Testing Decisions

任务已指定既有真实SDK经MockTransport的公开提取接缝：先红灯验证新角色指导尚未进入v3 wire，再最小补提示转绿。给定标签的保护用例包括A02收到邀请、A05姐姐借车、明确本人接收、未知人但本人参与已明确、纯第三方历史、否定、条件及引语；这些Mock只证明提示到达及原合同保留，不是模型分类收益或新增质量样本。

另保护原A03给定relationship_event的v2完整输出、v2提示及动态schema；v3中同一原句给定relationship_event和reported_event分别沿原映射，保持未知人物说明、原句借用方向及未证交付、双null和pending。“跟我借”保留原句，不额外标borrowing_direction或生成反向借用读法。完整memory_extraction单元、ECNU／offline／SDK／wire相关集成、类型检查、字节／AST比较及独立Standards／Spec审查均须完成。

## Out of Scope

不改任何runner、旧预注册计划、Gold、冻结、结果、共享类型或编译器；不作关键词规则、人物消解、交付推理、评分修正、采纳放行或生产切换。不恢复已关闭预算、不自动后继，不调用真实模型／桌面／CLI。A03单窗及已知合成边界不满足ADR-027的≥15例质量门，不认证真实收益或独立泛化。

## 验证记录

准确改动为`grounded_adapter.py`显式v3提示追加四行角色／阶段指导、既有`test_grounded_v3_runtime.py`及本计划，共3文件。没有新枚举、解析器或确定性重分类；既有financial／多码指导逐字保留。

首次红灯是实际SDK Mock请求的system消息不含“原文明示本人已参与”；只追加四行v3指导后转绿。最终最小运行时8／8（0.409秒）：原5项加8个边界子例、A03两种给定kind及旧v2完整兼容保护，不能把子例数或给定标签记为质量分母。旧A03的relationship_event仍为assertion／asserted，显式reported_event为report／reported；两者均保留原引句借用方向、未证交付、金融风险、未知身份、双null及pending，不自动修复旧标签。复查Gold后收紧A03合成标签为仅entity_identity，不为“跟我借”增加方向未定标签或反向读法；生产提示和编译器没有随此夹具澄清变化。

旧v2原A03完整14槽输出canonical SHA-256保持`b4c25153f4aac09f74718d82597f12b39ca6cc352873e293e9a04009bb86d9a3`；变更前同窗动态schema canonical SHA-256保持`46d3cfb96ddecbff0c653b1200e0261c16e5de0ab0acff97060d5ca5f6eb57a7`。完整输出预期来自原封存公开投影，测试不读取本机私有旧运行目录；schema预期来自变更前基线，均为独立固定值，不从当前实现重算预期。v2 wire提示UTF-8摘要仍为上文固定值。

只读AST／字节核验显示：adapter除GROUNDED_V3_PROMPT外全部AST相同；v3字符串只有一段插入，旧financial／多码文本完全保留。`grounded.py`、生产`command.py`、`evaluation_extraction.py`选择逻辑、`runtime_config.py`、V adapter、review评分器、原runner及原指导两窗计划均与基线字节一致。此检查没有重写旧freeze或重算旧成绩。

最终完整memory_extraction单元447／447（5.644秒），ECNU／offline／SDK／wire相关集成103／103（20.961秒），合计550项通过；修改源模块的mypy及`git diff --check`通过。日志均在本机忽略目录`desktop/artifacts/`：`v3-kind-guidance-red-wire-20261016.log`、`v3-kind-guidance-green-wire-20261016.log`、`v3-kind-guidance-minimal-v2-20261016.log`、`v3-kind-guidance-final-unit-v2-20261016.log`、`v3-kind-guidance-final-integration-20261016.log`、`v3-kind-guidance-final-types-20261016.log`、`v3-kind-guidance-unchanged-contracts-20261016.log`。

全部Python命令先激活Conda `NotAlone`并设置`NOTALONE_DISABLE_DOTENV=1`。从`backend/`执行：

```sh
python -B -m unittest tests.unit.memory_extraction.test_grounded_v3_runtime -v
python -B -m unittest discover -s tests/unit/memory_extraction -t . -v
python -B -m unittest tests.integration.memory_extraction.test_evaluation_ecnu tests.integration.memory_extraction.test_evaluation_offline tests.integration.memory_extraction.test_evaluation_sdk_budget tests.integration.memory_extraction.test_evaluation_wire_contract -v
```

从根目录执行：

```sh
python -B -m mypy backend/src/notalone/memory_extraction/grounded_adapter.py --follow-imports=silent --ignore-missing-imports
git diff --check
```

Standards独立只读初审及夹具收紧增量均硬违规0／可能smell 0；Spec初审及夹具收紧增量均0项。仅读取原公开A03标签和编译投影的必要字段，未读取模型推理、凭据或真实聊天；所有新提取均为httpx MockTransport，不发真实网络。没有预算、业务写入、桌面／CLI操作、真实分类收益或质量认证；当前runner未接入新的kind policy，任何后续真实场仍由主Agent另行预注册和冻结。
