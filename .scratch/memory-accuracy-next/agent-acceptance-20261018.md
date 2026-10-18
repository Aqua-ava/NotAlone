# 原03 Agent快速验收与集成

Triage: ready-for-agent
State: claimed

工程接线与本地集成已通过相关检查；三票质量义务未完成，不能宣告goal完成。

2026-10-18用户明确授权三个新会话并行执行、由Agent验收，不等待人工。`reviewer_kind=agent`；本次改变审核执行者及调度顺序，不改变假事0、错人0、一般错误≤1、逐维度至少15窗及实际proof交付门。旧批次、Gold、失败、余额和旧审核身份保持。

## 固定范围

- 基线：`5b4153b7f2f0e10399d44b23f82b54dfe2503bac`；集成分支：`codex/memory-accuracy-integration-20261018`。
- 复用已实现的`bounded-runtime-v1`、grounded-v2、nullable-proof-v3、proof3/basis3/evidence4及071迁移；当前基线最大迁移072，不重建、不改号、不迁移业务库。
- 复用2026-10-17完整工程证据及已审15窗计划。必要新真实场仍使用原15窗完整输入、Gold、官方DeepSeek、最多30次HTTP、零重试、RAW先封存再FULL，独立冻结最终源码和实际来源/任务。不混入其他两票样例，不借旧额度，不把模型或技术未知当通过。
- 独立审核的身份记录放在绑定run/phase/case/view摘要的元数据中，保留现有严格review协议。Agent对每轴作实际判断，不从Mock或matcher自动生成质量成绩。
- 生产放行表仍空；不扩大真实联系人读取、外部发送或媒体处理。桌面验收不在本票范围。

## 快速工程检查

Conda NotAlone；显式`NOTALONE_DISABLE_DOTENV=1`、工作树`PYTHONPATH`及`-B`，不读取业务连接。

1. `python -B -m unittest tests.unit.tasks.test_runtime_config tests.unit.tasks.test_runtime_execution tests.unit.memory_extraction.test_bounded_flow tests.unit.memory_extraction.test_bounded_runtime_proof -v`：48项通过。
2. `python -B -m unittest tests.integration.tasks.test_bounded_runtime_acceptance tests.integration.tasks.test_runtime_config tests.integration.server.test_task_runtime_config_api tests.integration.tasks.test_bounded_evaluation_sources.BoundedEvaluationSourcesTest.test_actual_sdk_outputs_confirm_correct_reject_and_rebind_without_new_model_call -v`：35项通过，包含19个正式来源/任务/API控制、8个配置持久化、7个HTTP合同、1个实际SDK Mock生命周期控制。随机自有隔离库由测试删除。
3. 独立Agent只读缺口审查：基础接线与生命周期已有覆盖，未发现需要重建框架的证据；真实模型proof3交付及七轴质量仍缺。

上述83项是本轮工程检查，SDK响应为Mock；不与旧批次累加质量分母。

## 集成与真实验证

- 核心代码 `d159417d` → 集成 `2cfe0a4b`：保留显式历史／条件前件依赖和已知未决标记；核心边界测试与结果 `c42252cf` → `660cf31c`。
- 指代独立测试与Agent Gold／计划 `eeeeb0dd` → `6674c85d`，生产修改已包含在核心共享提交，未重复改写。
- E2边界提示 `3e9403d4` → `f9b8ebff`，保持旧v3/v4/schema。该版本43项运行时／依赖／SDK相关回归通过。
- 指代首场结果 `8014b750` → `5d969604`，后继完整16窗结果 `0c5a753c` → `d94d1e93`：后者safe14、一般错误2、安全错误0，必需命题18/18、完整字段17/18；仍未过≤1门。其独立Emax/Vnone原16窗场在A15因bad_auto 1安全停止，29/32次请求、前15窗一般错误3、A16未运行；结果不计入此前分母。
- E2合同顺序修订 `3f79fcea` → `973ad575`：统一纳入判定、主断言分类及必要指称检查；集成后运行时proof／指代依赖／核心依赖／grounded SDK／E2稳定事实五组50项通过。旧v3/v4及schema保持；跨措辞给定标签控制不签模型质量。
- 独立诊断计划 `59c6c131` → `2da5e564`：原16窗仍为唯一主集，另8诊断单列，不能替代核心私有留出或本票真实proof交付。
- 集成后bounded相关46项、依赖相关10项通过；v3提示澄清后proof相关27项通过。各组有重叠，不累加为唯一测试数；不重跑旧长全量。
- 本票状态澄清与v3六行提示各经Standards／Spec独立Agent审查，均0实质问题；提示改善幅度不能由代码审查推断。
- [两次独立真实场](runtime15-agent-result-20261018.md)共4次已知HTTP200、零重试：首场位置越界拒绝，次场V正文无法脱敏保存，正式审核均0。每场仅首窗unknown、后14unrun，余28分别永久关闭；七轴质量及六规则真实交付未达标。

工程修复和本地集成完成不等于原三票全部质量义务完成。核心六窗／四留出、本票15窗真实proof3／七轴门保持未覆盖，原03第一AC不勾、State继续claimed，生产放行表仍空。不会把Agent替代人工解释为降低质量门。

公开历史与当前文件扫描已执行，结果12项均来自既有工程说明的本机路径（当前／历史各6），本轮未新增；未越界改写历史。所有本票自有模型进程与测试库已清理，临时三字段凭据文件已删除；未构建App或新增大体积构建缓存。

前次集成Standards／Spec固定`5b4153b7...f9b8ebff`独立复审均0新增实质阻塞；未以此认证真实质量。

E2合同顺序增量973ad575经Standards／Spec两轴复核均0实质问题；50项集成检查全通过。后继原16主集已完整审核：safe13、一般错误3、假事实／错人／bad_auto均0，必需命题18/18、完整字段16/18，仍未达门。独立诊断6/8因bad_auto 1安全停止，D07/D08未运行；43/48额度已关闭，两组不混分母。原16质量门、旧失败及生产空表保持。

指代最终分组结果源提交5e09a433（初版badd7c7c）已接入4b3e3617并同步最终链接修正，见[真实分组结果](../memory-extraction-accuracy/reference-agent-contract-result-20261018.md)。全部7个指代实验预算已关闭，累计134个已知HTTP200；与本票2场4次请求分账，均不作为质量通过样本数。当前没有活动模型场。

## 位置辅助与正式评测接线增量

E2独立教学例21fabd17→8ad58155、测试指纹a9a00805→21900a96；指代诊断f388a8fc→07a7bcaf和计划8066ef48→0e0a6c19已集成。V3纯位置辅助e3d45d88保留完整输入与原证据门，包装器漏带辅助由1eb194ea修复，SDK一致性回归先红后绿。67项正式评测／bounded／proof／依赖／E2相关检查及两模块定向mypy通过，双轴复核0实质问题；不等于全库类型检查通过。

两场新增真实记录见[runtime位置辅助记录](runtime-position-guide-20261018.md)：第三场9578在V发送前因包装器请求不一致停止，仅E1次200；修复后第四场1054完成E/V各1次200，但V候选区间仍偏移，严格拒绝。四场共7次HTTP200、正式审核与七轴仍0，未用113次额度关闭；自有进程、隔离库及临时配置已清理。工程改动未实现本票真实质量义务，原03继续claimed、生产放行表为空。

逐码点辅助v2已提交9795f327，原位置标尺v1仅为已封存历史；新版67项相关检查、两模块mypy、双轴复核通过，无新增模型质量证据。核心资产盘点8d49fee8→376aac9f确认六窗资料仍在，四窗Gold已审但尚未执行冻结，旧第四场用户停止且闭账、source_freeze_active=false；旧runner不能认证当前版本。见核心结果文档的验收缺口，不能重开旧预算。

指代fewshot最终结果566eb3d5→bafab10c、官方配置查证a25b2cef→d1bbff6b已集成。新场41/48关闭，主16一般错误3、安全0，raw18/18、E14完整15/18、含V完整14/18；诊断6/8一般2、bad_auto1，D07/D08未运行。指代八场累计175次HTTP200，与运行时四场7次分账。独立模型配置仅为待实现的对照路径，未新增预算或外发；不将模型名称等同任务准确性。

Pro闭集接线90af01c2已完成90项相关测试、15项最终复查、五源码类型检查和双轴审查。独立18fcc800场closed2/30，首窗首次RAW/FULL封存，但E类别/有效期错误及V漏检，程序UNKNOWN/basis=null，positive_delivery_missing停；后14unrun，正向交付0/7，不签质量。位置提案合法不等于proof依据有效，见位置辅助记录。五场9次请求与141未用额度分列，隔离资源和专用key已清理。指代接口差距c48eda51→d3fad821、机械投影6a1a1a7d→82557532已接入并核等价；D8理由规则缺失，投影仍不可正式执行。


## 当前完成性复核（集成94ea9ad9）

独立只读核对决定稿、实施规格、测试源码与既有验证记录，未发现新增工程缺口：有限六类/反例见`test_bounded_runtime_acceptance.py:323`，逐维度AND见`test_dimension_evidence_flow.py:348`及`test_bounded_memory_api.py:66`；任务配置/恢复见`test_runtime_config.py:80`；版本配对、ALL与旧读取见`test_bounded_runtime_migration.py:201`、`test_all_source_persistence.py:71`；全部状态删除、确认前复核与实际SDK产物生命周期见`test_all_source_deletion.py:96`、`test_bounded_evaluation_sources.py:155`。本次复用工程结果14项来源生命周期、5项独占进程及本轮48单元/35隔离集成证据；各组重叠，不累加为新测试数，也未声称当前HEAD重跑全库。

最新合并90相关测试及7源码类型检查通过。真实新场e00279a0仅P01审核完成即触发potential bad_auto1，实际pending，后14unrun，正证0/7；前场f0e64fae的1/7只保留历史信用，不并入当前场。两场均已关闭并清理。完整质量、真实六规则依据及达标后的实际生命周期仍未完成，因此03第一AC未满足。三线集成和后续结果以runtime-integration-handoff及runtime-position-guide为准。


## 双配置统一验收（2026-10-18）

bounded依赖v3 `0a51257d` 与reference独立Vmax `41aaea33`→`241d6cab`完成合并；唯一records冲突保留精确provider校验及新增reference计划。统一926项提取单测（37.943秒）、52项共享入口/SDK/fixture相关测试和8源码mypy通过，独立合并Spec0。最初定向命令把一项integration模块误写为unit，修正模块路径后52项通过，该导入错误不是产品失败。

上一真实bounded场bcbb已closed4/30，2审safe1/safety1，正证1/7、潜在bad_auto1、13窗及生命周期unrun，清理残留0；不把新工程测试当质量信用。core同7bef源码固定6场已closed12/12、6审safe且必需完整6/6；独立闭账确认仅既有future_validity风险追加，随后才允许留出。reference retention旧场closed10/32、4审safe3/general1，A05安全留证失败unknown。新bounded/reference配置尚须新冻结后的真实质量验收；生产空表与task03未完成状态不变。


## 独立V32K集成检查

60c5e088→9c7cec88无冲突集成，主复验46项相关/SDK/owned/fixture及旧bounded/core检查（4.919秒）和6源码mypy通过；主核backend源码、测试与desktop测试逐字等于作者通过936全量的提交，不重复声称主全量重跑。仅V上限32768，E8192及所有旧profile/提示/Gold保持。新实际质量场尚未运行；bounded原15、core留出及reference质量缺口均不因此关闭。
