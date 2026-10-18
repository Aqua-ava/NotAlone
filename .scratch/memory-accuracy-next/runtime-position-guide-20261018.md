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
