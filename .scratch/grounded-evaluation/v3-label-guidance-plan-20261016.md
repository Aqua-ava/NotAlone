# v3标签选择指导的离线诊断与最小澄清

日期：2026-10-16。Triage: ready-for-agent。State: resolved。离线诊断与提示澄清完成；实际收益未实测。

本片仅处理显式grounded-v3提示的`ambiguity_codes`多选与`sensitivity=financial`语义。固定审查基线为`8171d7c033cf96389913c05caffb07d7e52c6619`；不改生产默认、v2提示、编译器、schema、Gold、审核、评分、旧冻结或任何已闭账记录。不创建预算、不调用模型、不处理真实聊天或GUI，不启动后继场。

## 问题与证据

沿[已闭账两窗结果](typed-ambiguity-v3-pilot-result-20261016.md)，run `580343d0-6bfe-4dd4-9fd6-b214022d6452`已closed4／4，两窗均general_error，完整必需信用1／3。只读原provider事件允许字段得到：A07事件3的`0:0`为`unresolved=true, ambiguity_codes=[entity_identity], sensitivity=none`；A10事件16的`1:0`为`borrowing_direction/financial`，`1:1`为`borrowing_direction/none`。不读取或公开模型推理正文。字段审核已判A07漏地点归属未知、A10第二条漏金融敏感性；程序按实际标签编译，没有补码或补风险。

实际请求事件2／15都含“同时存在的类别必须列全；其他未知不能替代应列的具体类别”。因此A07不是没有任何多选指令；目前只能提出“还可更直接写明非互斥、逐类核对”这一改进假设，不能认定漏码由提示含糊造成。相同请求将financial定义为“真实金钱风险”，并要求“不增加原文没有的风险”；这可能让否定借款被理解为没有实际风险，但没有受控比较能证明因果。此次不将提示澄清写成模型漏标已修复。

## Implementation Decisions

只在显式v3提示中澄清两条共通选择规则：

1. `ambiguity_codes`是非互斥多选，逐类核对已有来源；身份、地点归属、借贷方向同时未定时全部选择。不能以具体词命中补猜未知，不能以other替代适用的具体类别。
2. financial表示来源涉及借贷、负债、还款等金融敏感事项，即使来源否定发生也保留；该标签不认定交易发生或已有负债。普通物品借用、商品报价本身不扩大金融敏感性；继续只依据来源语义。

复用既有v3提示构造，不增加标签、模型轮次或语义解析器。v2提示UTF-8字节SHA-256基线为`8580e630bbc4d600b08beb8a607cfcc05dc3efeb7daacc98a9f95bcb6164a01b`。仅澄清模型选字段的依据，合法响应、程序固定说明、风险映射、V、proof、默认空放行表与ADR-027门槛不变；不改A03 kind/report或其他提示。

## Testing Decisions

当前任务已经指定现有v3 prompt／wire接缝，测试从真实SDK经httpx MockTransport序列化后的system消息观察指导是否到达模型边界，并以合成合法响应验证编译结果；不以Mock输出冒充模型理解或质量改善。

按一个切片一轮红→绿推进：先固定多选、来源证据与不凭词命中的提示合同，再固定否定金融事项保留及不推定负债的合同。保护v2提示的已知字节摘要；现有多码、否定方向原引句、普通物品与报价none、合法缺漏标签不被编译器补猜的行为均沿既有接口核验。执行最小相关测试、完整memory_extraction单元、ECNU／offline／SDK／wire相关集成、类型检查与独立Standards／Spec双轴。

离线测试只证明指令和原合同保持。实际漏标是否减少、是否出现过标、泛化质量或维度放行，必须等待另行预注册的新实测；本片没有真实后继计划或运行。

## Out of Scope

不改旧结果、旧标签、Gold、评分、runtime门、compiler输出、schema、kind/report分类、模型档位、confidence、来源proof、自动采纳或生产默认。不开预算、不读key、不联网、不处理真实聊天、不运行App／CLI或GUI；不恢复已关闭run，不生成后继授权。

## 验证记录

只改`grounded_adapter.py`中显式v3提示、既有`test_grounded_v3_runtime.py`及本计划，共3文件，未提交。v3派生提示替换旧financial定义，避免同一v3请求同时携带“真实金钱风险”和否定敏感事项两种定义；v2常量保持原样。其他kind、subject、topic、dependency、confidence及编译输出规则均不变。

首红为实际SDK请求system消息中缺少“非互斥”；仅补多选指导后转绿。第二轮先红于缺少“金融敏感事项”（四个合成响应子例），v2 wire摘要保护当时即通过；仅替换显式v3的financial定义后转绿。日志分别为`desktop/artifacts/v3-guidance-red-multilabel-20261016.log`、`v3-guidance-green-multilabel-20261016.log`、`v3-guidance-red-financial-20261016.log`、`v3-guidance-green-runtime-20261016.log`，均在本机忽略产物目录。

最小v3运行时5／5通过（0.373秒）；完整memory_extraction单元444／444（5.703秒），ECNU／offline／SDK／wire评测相关集成103／103（23.848秒），共547项通过；修改的源模块mypy通过，`git diff --check`通过。最终日志为`v3-guidance-final-unit-20261016.log`、`v3-guidance-final-integration-20261016.log`、`v3-guidance-final-types-20261016.log`。

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

另以只读Python AST／字节比较核对基线：v2提示UTF-8逐字相同，摘要仍为上文固定值；除`GROUNDED_V3_PROMPT`赋值外，adapter其余全部AST相同。`grounded.py`、`evaluation_review.py`、`evaluation_phased_audit.py`、原两窗计划及结果文档均与基线字节相同。wire反例保留否定借款的合法financial和合法none响应，前者只映射敏感性标签、后者不会被程序补风险；借伞及商品报价的none响应同样保持空风险。Mock预设标签没有获得真实模型质量信用，旧A07／A10错误不变。

独立Standards审查硬违规0、可能smell 0；独立Spec审查0项。两轴限定基线及本3文件，只读复核，无真实key／registry／网络／GUI。数据处理仅已授权公开合成事件的必要字段与合成Mock；未查看模型推理，没有真实后继请求、预算、授权或业务写入。
