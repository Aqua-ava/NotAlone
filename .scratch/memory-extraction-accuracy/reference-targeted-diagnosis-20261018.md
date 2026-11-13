# 任务07三窗失败的定点诊断

本记录承接[完整16窗结果](reference-v-token32k-result-20261018.md)：run `67d9ff59-e8d9-41e6-a874-297fa85fd4b1`，source `28a8b0f9`，safe13／一般3、必需FULL15/18。只读使用原请求、结构化labels、候选、V结果和已封存审核；不读取已删除的推理正文，不改Gold、输出或评分，不新API。

## 已完成的离线定位基线

独立Agent在冻结源码及实际conda依赖中，将A07、A10、A16的原始labels纯内存重放。JSON规范化后，与留证候选逐字段完全相同；tuple/list落盘形态差异不误判为业务变化。90份冻结源码哈希全部一致，E/V factory提示与实际请求逐字一致。私有运行目录已保存可复现的 `diagnostic-replay.py` 与 `diagnostic-replay.json`（均为0600），显式记录 `semantic_improvement=false`。该结果证明现有编译器可复现失败，不证明模型已修复，也不是准确性绿灯。

`legacy-v4`不进入nullable proof核验（[verification.py](../../backend/src/notalone/memory_extraction/verification.py):285–289）；V实际输入已有category、source、日期及语用字段（[verification_adapters.py](../../backend/src/notalone/memory_extraction/verification_adapters.py):591–614）。不能把本场失败归因为proof丢失、字段未发送或执行不完整。

## 失败、原因与最小对照

| 捕获失败 | 确切路径或可证伪假设 | 最小动作 | 离线定点对照与通过标准 |
|---|---|---|---|
| A07：RAW正确，V无据uncertain/pragmatics | 原句“他们周末要来家里”；E plan→recent_state/plan/asserted，人物、住处未知和周末日期均保留。能证明V判断与原审核冲突，不能证明模型为何判断。现有提示已要求保留未知、不要求现实认证；假设是明确日期计划与模糊期间支持口径不对称。 | 不改E、compiler或公共V；先形成独立的字段—来源对照，确认语用、指称、现实真伪是否被混用。 | 原V响应必须继续判失败、pending不变。以明确计划、带条件计划、已完成动作、日期错配四类合成对照，独立标明哪个字段有据／无据及逐字来源。若仅凭pending或指称未知也给语用错误，对照应判错；静态文案或Mock理想响应不计修复。 |
| A10：E分类错误，V又漏检 | 原问“老李借你钱了吗？”，答“借了，小王没借。”；实际kind=event、dependency=0:0，按正常映射得common_fact。Gold两个允许分支均要求relationship_note。V supported/issues[]没有检出可见类别；不是编译器错映射或方向被偷偷消歧。 | 分类选择和V漏检分别立项；不按“借钱”关键词强制类型，不修改原标签。现有教学已含映射与借用例，不能声称只缺一句规则。 | 原labels重放仍应得到common_fact并被原Gold检出。不同人物、物品、肯定／否定、方向未明的独立对照，应区分互动关系经历与普通完成结果；方向、极性、financial/pending必须保留。V对照另检是否真正审查category，不将改E与改V捆绑归因。 |
| A16：来源契约缺项，独立叠加V语用误判 | 原问“那个面试怎么样了？”，答“过了，下周一入职。”；1:0选dependency=0:0，1:1选null，来源分别[1,0]与[1]。schema允许null/0:0/1:0，编译器只递归实际声明依赖，没有丢失已声明依赖。Gold对P2要求[0,1]。 | 先明确“理解不可缺少”与“同一事项后续安排”的通用依赖语义；不自动补前句，不改Gold。V的pragmatics误判与A07归为同一类独立问题。 | 原labels必须复现[1]且原Gold仍判来源失败。用“确实依赖事项”“可独立安排”“无关前文”三类对照先独立确认预期；仅在能区分必要依赖与背景时设计实现。不得默认每个相连分句都补context。 |

类型映射在[grounded.py](../../backend/src/notalone/memory_extraction/grounded.py):18–20、388–405；依赖闭包在同文件216–242、388–393。实际依赖选择说明在[grounded_adapter.py](../../backend/src/notalone/memory_extraction/grounded_adapter.py):53–54，类型教学在183–213。A07的模糊期间正向规则位于[verification_adapters.py](../../backend/src/notalone/memory_extraction/verification_adapters.py):108–111，更一般的明确日期支持规则位于core专用343–345，本场没有发送core规则；不能直接跨profile复制后宣称有效。

A16尚不能判定“现合同与Gold必然冲突”。现提示的“理解本句不可缺少”“不需要补全人物／事项时用null”至少有两种可检验解释：只看“下周一入职”的字面行动和时间，可能把它看作独立主张；若保留的是“该面试通过后的同一事项后续安排”，则问句及前一结果补足事项衔接，应声明依赖。Gold的[0,1]与后一解释一致，因此也可能只是模型漏判既有语义，而不是需要修改合同。当前证据只能确认null导致[1]及Gold不通过，不能裁定哪项解释是唯一根因。先以必要事项、独立安排和无关背景对照区分这两种解释，保留原Gold。

## 证据边界与后继门

目前没有已证实的编译器／proof程序缺陷，没有可提交为语义修复的运行时代码改动。原失败保持为失败；三窗重放的一致性仅是定位证据。输出上限在本场允许完成16窗，不是上述语义缺口的修复。

后继先交独立对照的明确预期与逐字段依据，区分已经证明、可证伪假设和未覆盖。公共提示／验证器及共享文件变动先报唯一负责人协调；不擅自自动补依赖、不改模型原输出追绿。只有定点证据支持必要性，才冻结独立最小实测范围，不能改一句提示后直接重跑16窗，也不能同配置重抽求过。

原Gold、一般错误≤1、假事实0／错人0／歧义不得auto及生产空放行表保持。任务未完成；不把程序重放、Mock、测试数量或待确认对照记为模型准确性通过。
