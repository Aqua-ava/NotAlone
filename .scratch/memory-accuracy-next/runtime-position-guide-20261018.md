# V3位置辅助合同

真实首场source区间超出6码点，candidate区间误含开引号；原解析器正确拒绝。第二场仅响应摘要，不能归因于位置，也不声称本改动解决脱敏失败。

- 仅nullable-proof-v3请求增加position_guide，version=1、unit=unicode_codepoint、block_width=8；原messages/candidates逐字段完整保留，旧模式请求逐字不变。
- 每条来源按原message_id、每条候选按原candidate_index绑定；codepoint_length及blocks的start/end/text只从完整原字符串机械生成。汉字、补充平面字符、组合字符、引号和换行均按Python Unicode码点，不trim或归一化。
- 每8码点一个半开分块，尾块保留全部剩余字符。分块与语言语义无关，不标事件、角色、规则、引用包装或来源到候选的匹配；模型可以跨块定位。
- 辅助累计原文最多8192码点、最多1024块、序列化UTF-8值最多128KiB；完整窗口超过4条或任一文本超过4096码点亦整体省略辅助。绝不截断辅助或原请求，不改变超限UNKNOWN、完整target与正文保留规则。
- 原四槽、proof3/schema、有限规则、严格解析器、basis3/evidence4和AND门不变。标尺不授予信用、不修补任何模型输出；非法proof仍停止整批。生产放行表为空，无迁移。
- 新真实场必须冻结辅助合同、实际提示、源码与原15窗/Gold，复用正式来源runner、独立最多30HTTP、零重试、RAW→FULL及原停止门；不得借旧余额。先离线验证与双轴审查；本文不授权篡改旧结果或提前认证模型质量。

工程验证：新增实际SDK输入检查及超限完整性检查，首次在正确backend工作目录执行其中超限检查为预期红灯（缺少辅助参数）；SDK夹具的uncertain缺issues另行纠正，不作为产品红灯；首次错误工作目录的导入失败不算红灯。最终结果另记。

两项定向检查转绿后，含既有非法proof拒绝与SDK/依赖/E2检查共52项通过；Standards／Spec增量复核均0实质问题。mypy沿依赖检查报198项／45文件，不能称全库通过；`--follow-imports=silent`的改动模块检查通过。无新增模型调用，真实效果待独立冻结验证。

## 首次真实接入与修复

独立场9578bef1-00a3-4fc5-b34c-2de236cafe44冻结8ad58155及原15窗／Gold，freeze SHA256=3a1f4c87879b102a1879eaa54633e41403dd8b2c8e73f709a50773382f4d35bf。已closed1/30，只有E的1次HTTP200、V HTTP0；余29永久关闭。E输出momentary_state及程序recent_state仅为封存原件，不作未执行的正式语义评分。

停止于正式任务provider_request：生产请求已带guide，而evaluation_offline的_RecordedVerificationRuntime仍调用旧默认序列化器构造预期。实际来源冻结绑定因此在V发送前拒绝，外层deepseek_hard_stop／formal_task_first_execution_failed，trace为business_write_failed。这不是V回答失败，也没有测到标尺的真实效果。

普通来源生命周期SDK集成单例仍绿，证明它没有覆盖该评测包装器；新增实际SDK包装器预期／实际messages一致性检查先红后绿，修复只让V3包装器采用同一位置辅助选项，不放宽比较或接受额外不明字段。正式任务、预算和分阶段审核的集成单例另行验证。

本场RAW/FULL、七轴和正向依据交付均0，P01 unknown、其余14 unrun。结束收据closed=true、close_unknown=false、worker_gone=true；来源归档及13类残留0、自有数据库残留0，临时三字段配置已删除。旧两场及余额不变，不重开本场；修复后的任何验证必须另冻独立场。

修复后正式评测／bounded入口与proof、reference、core、grounded、E2相关67项测试全部通过；改动两模块`mypy --follow-imports=silent`通过。Standards／Spec复核均0实质问题。测试使用隔离来源与SDK模拟，不增加真实模型质量信用。

## 包装器修复后的独立真实场

1054af70-93d1-4d3e-bad0-de28cc275c81冻结1eb194ea，freeze SHA256=fe57ab427254b68d118505016bed9c248ac21b994fbbfed8f8ce0a803987f5b9。E/V各1次HTTP200，closed2/30、零模型重试、余28永久关闭；原15窗／Gold不变。

E将首窗标为event并编译common_fact；V实际收到位置标尺，source[0,6)正确，但atom_links及reported的candidate[6,12)仍含开引号且缺末尾句号，正文实际为[7,13)。严格proof_semantics拒绝，未执行adoption/write；不修补输出、不把E标签或HTTP成功算正式审核。该场RAW/FULL、七轴、正向依据交付均0，P01 unknown，其余14 unrun。位置标尺尚未证明有效。

finish的closed=true、close_unknown=false、worker_gone=true，launch与worker进程均已不存在；source-finish记录13类残留0及数据库残留0。临时三字段配置已删除。自有四场已知请求累计7次，未使用113次额度永久关闭，不能当作通过样本数；第二场原关闭未知与独立核对的区别仍保留。

独立只读诊断进一步发现reference.target[0,6)误用整句，作者自指应与mention同为[0,1)。本次先在candidate主引句范围检查失败；target错误尚未被执行检查，但即使仅纠正候选范围仍不能形成basis。原输入分块正确，8码点块仍要求模型块内计数。可另评估全局通用逐码点索引，但不能解决作者锚语义，不据此自动续开相同模型场。

## v2逐码点输入辅助（尚无真实场）

当前实现升级为version=2、block_width=1；统一对全部消息及候选逐Unicode码点提供绝对start/end/text，取消块内计数。总8192码点同时意味着最多8192项，保留单条4096、窗口4及128KiB序列化预算；较长输入可能仅因辅助体积整体省略，原输入始终完整。上文v1/8码点及1024块合同属于已封存旧场，未追改其冻结。

只改变通用输入坐标，不定位事件、不产生引用链接、不修补输出；不能解决或认证作者target语义。两项实际SDK/MockTransport测试先红后绿，proof模块30项通过，正式评测与相关模块67项通过，改动及包装器两模块定向mypy通过。Standards/Spec各0实质问题。无新增模型调用；原15窗及其Gold、质量门、旧失败和关闭预算保持。

## 独立Pro交付配置：封闭接线与工程验证

依[官方配置查证](../memory-extraction-accuracy/deepseek-config-options-20261018.md)，可准备唯一显式Pro bounded15 profile，请求deepseek-v4-pro、官方endpoint不变；响应预期也须精确冻结，不符立即停止，不接受任意别名或宣称文档保证后端权重。目的仅是原15窗／Gold和六类proof合同的实际交付，不声称Flash/Pro因果优劣，无需为这一目的重跑Flash基线。

Emax/工具省略、Vnone/强制、E2/proof3、cap30、零重试、RAW→FULL、七轴、七正控交付及原停止门保持。新Pro配置额外固定E/V均max_tokens=8192，避免依赖服务端动态默认；截断仍按原未知门停止，原Flash请求字段不变。30次是调用上限，不称费用上限；输出token最多245760，实际费用还取决于输入、缓存和计费时段。逐码点v2属于当前冻结源码；结果不得分别归因模型或索引。生产默认与旧Flash配置不变，不修改资料／Gold，不借旧余额。

代码准备必须贯通provider闭集、bounded入口、records登记及摘要、offline实际SDK、owned领取、fixture prepare/validate/worker/launch、专用凭据读取；新登记版本显式绑定profile与精确model/phase，旧登记仍按旧合同核对。凭据仅读显式0600普通单链接私有文件中的API key，model/endpoint不继承环境；prepare阶段不读凭据。交叉模型、响应漂移、未知profile/phase及重算摘要绕过均须在外发前拒绝；实际SDK Mock、领取顺序、闭账与来源清理验证后方可独立冻结。该接线现已实现；尚未激活或调用真实模型。

实现采用deepseek-pro-bounded-task-v1及request_contract_version=3，同时绑定provider_profile、deepseek-v4-pro和整数max_tokens=8192；旧Flash version2不新增字段。新增prepare-bounded15-pro入口，显式私有JSON文件只接受单一api_key。Pro响应型号不符、length或content_filter均立即停止，即使携带完整工具JSON也不例外；原响应继续封存。旧Flash结束标记兼容保持。

新增注册/SDK/领取/fixture先出现预期红灯后转绿，最终6模块90项检查全部通过（33.860秒）；覆盖真正独立owned子进程、SDK MockTransport E/V请求、PG实际task/trace的Pro身份及结束后来源残留0。两轴最终复核均0剩余实质问题；主Agent另核任务07投影机械一致。以上仅证明受控工程链路，不认证供应商接受或真实proof交付，尚无新模型请求。

最终类型检查曾因SDK可变关键字的宽dict注解报40条同源错误；以仅含可选max_tokens的TypedDict修正，不改变实际请求。随后注册模块15项复查通过，五源码mypy在pipefail下明确Success、退出0；不将此前tail退出码当作类型检查成功。

## Pro独立首场：正式审核推进但正证未交付

run=18fcc800-361d-4a47-86cd-a0a82021ea39，源码90af01c2，freeze SHA256=aa459fc14226ca1883f6db54481953a649b30e2c5a75cedba6e406726d2430c9。原15/Gold及停止门不变，Emax/Vnone、各8192显式上限。E/V各一次HTTP200，响应精确模型通过；closed2/30、零重试，余28永久关闭。

P01首次完成独立RAW→FULL封存：E仍输出momentary_state，编译recent_state并附当日截止有效期（20:00至次日00:00，实际4小时），与完成事实common_fact/双null的原Gold不符；V supported且issues空，未发现该错误。本次位置及作者自指提案合法，但程序pragmatics_not_supported返回UNKNOWN、basis=null。media和truth_intent各有独立有效依据，其余五轴unknown，未误授信；实际source current/ALL/pending，未发现假事、错人或bad_auto。本窗一般错误1，正向依据交付0/7；按bounded_runtime_positive_delivery_missing停止，后14窗unrun。

完成1窗的七轴审查不等于七轴通过；summary按一般错误窗口记七维meets_gate=false，不能将media/truth_intent单项判断或合法位置提案改写为整个合同达标。RAW与FULL原判断保持，不修标签、时间、Gold或旧失败。

finish closed=true/close_unknown=false/worker_gone=true；launch与worker句柄均已不存在，source-finish为closed、13类来源残留0和自有数据库残留0；专用api-key.json已删除。仅私有暂存既有授权官方key，未创建工作树.env；初次暂存脚本因未安装dotenv在任何写入前失败，后用标准库解析单行，不是API失败/重试。自有五场累计9次已知请求、141次未用额度关闭，正式审核现在1窗，质量门仍未满足。

后续代码定位确认拒绝发生在bounded_proof的类别/言语行为/断言组合校验，早于proposal_matches，故仅能称提案形状与位置域合法，不能说整个证明已认证。非空时间为独立矛盾；0.6还会影响理想采纳门，但不与当前最先发生的类别拒绝混为一谈。


## bounded阶段教学增量：实施决定，尚未验收

首窗失败显示模型仍混淆完成动作与瞬时状态；现有提示已区分两者，因此不能将本次错误称为已证明的提示矛盾。下一步增加独立合成对照教学，只应用于显式bounded任务。微例不取原15窗口、Gold及其动作词，不规定confidence，不修补响应、编译结果或时间，也不更改质量门。

原批准规格只要求任务选择同次V，本轮补充E侧教学选择，属于保持既有协议的小范围实现改进：生产GroundedExtractionRuntime继续自身event schema/compiler，评测GroundedV2ExtractionRuntime继续原E2 schema/compiler。两者通过同一封闭提示工厂选择增量；default、核心与指代使用的E2原字节不变。实际worker、优先级装饰器及评测记录包装器必须贯通同一选择，实际请求与冻结预期同源；不能以离线注入替代真实任务接线。

任务仍持久化version/mode/rule_set_sha256三个原字段，不增加迁移或把提示摘要冒充证明规则摘要。profile内容版本化、trace记录profile和最终提示摘要；同一冻结源码内的恢复保持选择，评测源清单和调用核验拒绝漂移。三键配置不承诺任意跨代码升级恢复历史E提示，此限制不应隐藏。替换已有profile或承诺跨升级恢复须另行设计。

验收先从实际SDK/worker接缝红灯开始，覆盖两runtime的协议保留、default字节、保存配置恢复、包装记录身份及owned冻结拒错。通过相关测试、类型和双审之后才能新建真实场；当前没有新API调用或新增质量信用，旧场保持关闭。


## 阶段教学工程实现与验证

bounded-stage-teaching-v1已在双runtime、真实worker、优先级包装、评测记录及冻结请求中贯通。两协议保留各自schema/compiler，default v2/v3/v4字节hash不变；draft/compile追踪记录profile及提示摘要。没有修改Gold、原15、置信度、证明规则或三键任务配置；尚无本增量真实质量结论。

验证使用backend目录、NOTALONE_DISABLE_DOTENV=1、PYTHONDONTWRITEBYTECODE=1、PYTHONPATH=src、项目Python -B -m unittest：最高接缝先红后2绿；登记/owned/entry 33项绿；public fixture/bounded acceptance/配置恢复35项绿；新增profile、注册、wire、phased审核和两种owned SDK Mock最终60项绿（各组有重叠）。Standards及Spec审查均无实质问题，git diff --check通过。

额外任务/优先级回归40项中31项通过、旧默认测试库中的worker导入9项失败于source_processing。改用现有CoreBusinessFlowFixture创建、完整迁移和清理的本轮独立库，先单失败例1项通过，再worker全模块10项通过；没有修改旧共享库结构，也不把初次失败计为通过。一次直接调用fixture混入类在建库前因缺addClassCleanup失败，后用TestCase子类正确管理清理。所有资料为测试夹具合成，未读真实联系人或业务库。

10个修改源码mypy --follow-imports=silent通过；worker的5项类型错误在HEAD旧文件副本中同类同数量复现，故不能宣称11模块全通过。此轮没有真实API调用。下一步先集成指代Pro16独立入口并回归重叠模块，再冻结新的bounded15场。


阶段教学已提交61c102ba；指代独立Pro16入口542398af已无冲突集成为17a0efe0。合并后两路profile/SDK/登记/owned/审核/fixture共66项检查通过（28.115s），6个共享源码mypy通过。两路保持不同提示与推理配置，不因共享Pro模型而互借Gold、窗口或预算；真实质量仍各场独立验收。
