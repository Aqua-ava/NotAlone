# E2普通事实标签的稳定资料指导

Triage: ready-for-agent

本片归属[原07](issues/07-reference-resolution.md)允许的提示及字段语义修复，已完成离线实现与工程验证；独立两轴审查及真实模型验收仍待完成。完整140纯映射中的`event→common_fact/双null`，不证明按旧“已完成普通动作”定义能够合法表达稳定本人职业或身份；[既有真实局部失败](../grounded-evaluation/full140-mixed-v-off-result-20261016.md)也不能靠旧给定标签见证签为已解决。

## 选择与边界

仅对未来E2请求澄清既有`event`标签：它用于对话一方的普通可复用事实，包含已完成动作及没有短期期间的稳定身份、职业、专业。标签名称沿用既有wire值，以保持schema兼容；不是由程序把state提升为事实，也不提供来源证明。模型仍选择kind、主体和来源依赖，V仍独立核验；程序映射、正文、日期、风险及采纳门不改。

“目前／现在”仅表示陈述时点时，不凭此把稳定资料当临时state；明确短期期间、当前知情／决策、身体近况和未来安排继续各自原类型。不从稳定资料推真实开始日、永久有效、能力或成果；第三方身份仍用third_party_fact，猜测、否定、引语和未知不能借此变成已证身份。

与[ADR-059](../../architecture/adr/059-closed-unknown-kinds-and-calendar-month.md)历史修订中“event只表示已完成动作、旧E2保持”的局部约定有差异。本片按原07的普通提示语义修复更新**未来E2标签指导**；旧冻结、旧候选、旧评分不重解释，显式v4继续使用stable_fact且不将其身份改标event。不是新增kind、切换默认版本、升级proof或放宽自动采纳。架构记录须如实续接这一差异。

不选择新增E2 kind或切换全局v4：前者改变schema，后者超出保留默认grounded-v2的范围。本片保留现有公开Runtime／评测Interface；新增一个模式专属常量GROUNDED_V2_PROMPT，由现有E2 Runtime及extraction_contract共用。原GROUNDED_PROMPT作为v3/v4派生基底保持字节，旧v1/v3/v4的提示、schema及同标签编译行为保持。本片不新增profile、wrapper、DTO或模型调用。

E2 prompt摘要将改变，E2 schema及同标签编译载荷不改；未来真实场必须从实际新提示和源码重新冻结，不能沿用已关闭场或把新prompt冒充旧默认字节。与核心及E2有限字段策略的独立修复集成时，按实际组合重新核摘要，不以本片基线摘要覆盖其他改动。

## 测试Seam与交付

在已有实际SDK→GroundedExtractionRuntime和extraction_contract接缝做红绿：原句稳定职业／专业、已完成动作、当前状态、明确短期期间、未来计划及第三方身份只用非Gold公开合成数据；模型响应给定原有合法标签，核wire新指导、唯一请求、原工具/schema及E14正文/类别/阶段/日期。给定响应不证明模型会遵守指导，也不签任何质量门。

独立核对v1/v3/v4原prompt/schema和140给定标签编译字节不变；E2同给定标签140编译结果不变、schema不变，仅wire指导及其冻结摘要变化。保留已有SDK/评测合同，先最小相关、再完整相关回归及mypy；本地中文提交固定待审diff，由主Agent安排独立Standards/Spec审查作为集成前条件。无真实HTTP、凭据、DB、桌面、旧资料回填或远端Git；本片不关闭原票。

## 本地实施与验证结果（2026-10-17）

Runtime与`extraction_contract`已共用`GROUNDED_V2_PROMPT`。原`GROUNDED_PROMPT`基底及v3/v4派生提示保持；未修改编译器、字段映射或kind枚举。ADR-051与ADR-059已续记未来E2指导的局部差异，不重解释旧合同。

稳定职业SDK控制由主Agent在新增指导前复现红灯。接管后补齐新SDK测试的独立禁socket、禁dotenv、假环境和类型标注；必要的离线评测冻结漂移控制也先红：仍修改旧基底时误发到第二次请求。仅将该控制改为实际E2常量后，恢复首请求之后检测漂移并停止的原行为；未放宽冻结门或重签v3/v4摘要。

全部Python验证在Conda `NotAlone`中，以本树`backend/src`和`backend`的绝对路径设置`PYTHONPATH`，启用`-B`及禁dotenv，并核对实际模块来源。测试使用精确`MockTransport`及禁socket；评测记录控制仅使用测试自建临时目录，不接真实凭据、业务库或既有运行登记。

| 验证 | 实际结果 |
| --- | --- |
| 最小5模块 | `test_e2_stable_fact_guidance`、`test_grounded_v3_runtime`、`test_grounded_v4`、`test_grounded_v4_runtime`及`test_evaluation_extraction`，60／60通过 |
| 新SDK控制 | 2个测试、9个给定标签组合；核实际E2指导、唯一请求、原工具及schema、正文／类别／阶段／日期保持 |
| 完整相关回归 | extraction 613＋memory 17＋provider 13＋Mock integration 114，共757／757通过；Mock integration为`test_evaluation_offline`、`test_evaluation_wire_contract`、`test_evaluation_sdk_budget`和`test_evaluation_ecnu` |
| 类型检查 | `python -B -m mypy`核`grounded_adapter.py`与`evaluation_extraction.py`，2个源码通过 |
| 固定父逐字比较 | 对固定`4fe1cf9526b903e127b9baa2e00bd8a21242a8f9`的git-show代码重新加载，140窗×6种给定kind×v1/v2/v3/v4＝3360载荷相同，420份schema相同；编译源码、原基底、v3、v4默认及v4唯一性提示均相同 |

当前E2提示SHA256为`1d39b3792c53329d9f87d4f1ba726532e9779894b21cc5157e6206a527691499`。该摘要只对应本片独立基线；与其他修复组合后必须重新核实际合同。比较及Mock证明表示与接线，不能证明模型会正确选择稳定资料标签。

数据处理只改变未来E2对既有标签的指导；不新增读取、持久层、模型轮次或来源信用。来源、删除、0.7／风险／语用门及默认空放行表保持，真实模型HTTP／凭据／业务库／桌面／远端Git操作均为0。原07至少15窗的假事0、错人0、一般错误≤1以及全140真实回归仍待独立有界场次验收；旧失败、Gold及封存不改，不以工程通过关闭原票。
