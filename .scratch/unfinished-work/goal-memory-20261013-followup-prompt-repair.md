# 正式局部失败对应的第二片最小提示修复（2026-10-13）

本片基点为工具主题`ebdd06ad`，只修改两个既有system常量：[E](../../backend/src/notalone/memory_extraction/adapters.py)与[V](../../backend/src/notalone/memory_extraction/verification_adapters.py)。真实red来自[独立候选正式结果](goal-memory-20261013-candidate21-result.md)的A01／A02／A04，不是新构造的提示文字断言。原21窗Gold、全部难例、旧sealed raw/full与完整0、A05 late formal unknown、三次旧基线与关闭余额继续保留；新增真实HTTP0，当前七closed累计34。不能以本片合成绿称记忆质量已通过或提示收益已成立。

| 正式实测失败 | 共性最小修补 |
| --- | --- |
| A01 E5字段失败，V漏检无据纠正动作／分支 | 否定句不是纠正动作，须有窗内明确纠正或有据先前说法，不能编“此前说法”；未知第三人职业／部门主张保持relationship_note及report/reported，V正文无据行动与语用错分别核。 |
| A02已补人物来源，历史转述分支仍混未来两日期，额外“见面”风险；V漏检时间 | 已发生邀约／收到或转述邀约，与内容中的未来活动分阶段；历史分支双null，另存未来安排须完整沿plan／recent_state，保留原Gold所有可接受变体。风险只来自实际主张，普通娱乐见面不自动证明敏感风险，真实借款等风险仍留；未改风险白名单。 |
| A04“先”及观察日期字段已正确，正文缺来源日、未知事项备选为空 | 暂时限定、正文观察日期与未知备选独立核对；日期字段不能代替跨期正文时间，正文写事项未明不能代替非空alternatives，仍不猜亲友／职业／事项角色。V只核可见正文、时间与标签。 |
| A05本人参与历史经历控制 | 保留既有assertion/asserted、relationship_note与双null，不因出现亲友一概reported；上一run full晚到只能事后，不能给它补正式分。 |

已核domain-data、pragmatic-interpretation、core-flows、隐私和ADR033／036现行约束；核验只降不升、来源边界、字段、原置信与风险／语用三门、默认维度空表均不变。没有caseID特判、删难例、改答案、typed字段、DDL、产品发送或联系人范围扩展。V不接收risk_flags／alternatives／confidence／理由，故不宣称核验了这些不可见槽，也不能由supported救E14完整评分。

以AST去掉准确的两个提示赋值后，两文件与`ebdd06ad`完整一致；schema／parser／factory／storage／gates零差异。实际E源码SHA`f20c164835686ab7b068cee0dc98338c83e9c635b600a50d9cd424f7bfa63e2f`，V源码SHA`6f7e3c64821bb4da73d9d24c732910e3fb3349a53d78221a3227694183f63e64`，测试前后相同。两新prompt规范JSON摘要分别`36253b034964f4cf2a495697ebd50198a3ee991914bc304b48cf84e3257d5bf0`／`379ab5fad97a0571f62badd512e46c9df81e962dd6c82aa9875e11e470dfb4f9`；不与原字符串字节摘要混用。

Conda `NotAlone`、禁dotenv／bytecode及现有socket／DNS／真实transport守卫，最小相关8模块实际**114／114**（unittest **2.586秒**，外层单调 **4.502448708秒**）exit0：E/V适配器、原转述提示契约、Flow、语用、采纳、维度及ECNU受控SDK integration。两源码mypy **exit0／0.832937958秒**。没有新增镜像实现的提示文字准确率测试；本片无新的真实语义绿。首次多文件补丁因V物理行上下文未匹配而整体未写入，工具失败保留，修正为实际整行后应用；该失败未到测试，不作产品red。

证据根`/private/tmp/notalone-memory-goal-20261013-ac04d687/`（0700／0600）：`diagnostic4-prompt-projection.json`、`diagnostic4-prompt-minimal-tests.{txt,status.json}`、`diagnostic4-prompt-mypy.{txt,status.json}`。Root要求工具叶与提示叶分主题；精确三路径独立Standards与Spec最终未解决各0，固定diff／源码摘要与允许回归证据由两轴另核，未代跑模型。本片交Root安排独立本地提交。私有compact600／新8次最多4窗只作后续工具准备，完整原视图继续保存，原Gold安全门不松；新UUID预算仍未注册或供应商调用，后续全量280及余1不得自动启动。
