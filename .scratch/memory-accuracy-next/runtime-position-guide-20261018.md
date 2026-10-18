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

## 下一项独立交付配置：前置接线（未实现）

依[官方配置查证](../memory-extraction-accuracy/deepseek-config-options-20261018.md)，可准备唯一显式Pro bounded15 profile，请求deepseek-v4-pro、官方endpoint不变；响应预期也须精确冻结，不符立即停止，不接受任意别名或宣称文档保证后端权重。目的仅是原15窗／Gold和六类proof合同的实际交付，不声称Flash/Pro因果优劣，无需为这一目的重跑Flash基线。

Emax/工具省略、Vnone/强制、E2/proof3、cap30、零重试、RAW→FULL、七轴、七正控交付及原停止门保持。逐码点v2属于当前冻结源码；结果不得分别归因模型或索引。生产默认与旧Flash配置不变，不修改资料／Gold，不借旧余额。

代码准备必须贯通provider闭集、bounded入口、records登记及摘要、offline实际SDK、owned领取、fixture prepare/validate/worker/launch、专用凭据读取；新登记版本显式绑定profile与精确model/phase，旧登记仍按旧合同核对。凭据仅读显式0600普通单链接私有文件中的API key，model/endpoint不继承环境；prepare阶段不读凭据。交叉模型、响应漂移、未知profile/phase及重算摘要绕过均须在外发前拒绝；实际SDK Mock、领取顺序、闭账与来源清理验证后方可独立冻结。当前没有新profile实现、激活或模型调用。
