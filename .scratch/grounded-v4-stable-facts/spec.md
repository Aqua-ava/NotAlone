# 显式v4稳定事实的受控类型补全

Triage: ready-for-agent
State: resolved

## 问题和目标

完整140混合场 `5a6c08fa-c123-4fb7-8acd-cd2dccdd7acc` 已closed6／280；R002用户大三身份、目前所读专业正文保留，但实际state编译为recent_state及来源日valid_at，违反冻结common_fact／双null分支，V漏检后评测auto2形成bad_auto2并停止。独立只读回放已逐值重现E及真实Flow；原RAW／FULL与Gold保持封存。当前event定义为已完成动作，state为当前知情／决策或持续期未知状态，缺少稳定身份资料的诚实标签。

在显式离线grounded-v4增加一个闭合 `stable_fact`，承接原文明示的稳定身份、职业、专业等常识事实，编译既有common_fact／assertion／asserted／literal和双null。不从来源观察日猜真实开始日，不凭该标签认证永久有效或现实身份。模型仍只判断受控类型、资料归属、主题、依赖、风险和歧义，不生成正文、日期或任意语用组合。

## 实现决定

1. 仅v4允许该叶；v2／v3的提示、schema、编译行为及生产默认不变。新增值进入v4工具schema与v4专属说明，精确源码／提示／schema摘要在未来独立freeze中体现；不修补或重新解释任何已关闭run。
2. 复用现有V4_KIND_EXTENSIONS的完整四元映射，不修改全部state，不加字词命中分类器，不引用案例名、Gold或历史结果。stable_fact不进入observed_kinds或period_kinds，正文仍完整引用来源，保留既有隔离／source／依赖／歧义／风险及解释。
3. 提示明确稳定事实不是已完成动作，不因“目前”自动转临时state；知情、决策、近况、短期身体状况、瞬时状态及未来计划继续使用各自原类型。标签只是模型判断，不升级来源可信性或typed依据。
4. 记录本补全与ADR-059原四个未知叶的区别；只扩同一离线受控类型边界，不修改现行领域分类、有效期含义或采纳政策，不需要引入新领域概念。规范与具体实施／验证保持各自职责。

## 测试决定

在真实compile_labels_v4和实际adapter/schema边界先红后绿：合成的稳定用户／联系人身份、职业或专业产生完整引用、common_fact、双null且无观察日前缀，14字段与来源保持；来源时间缺失和非UTC亦不注入日期。旧v2／v3拒绝该新叶；state、momentary_state、计划及v4其他叶负控保持原日期／分类，未知类型、条件不相容和歧义规则继续严格。

保留本场R002原payload重放仍重现原错误的证据；正确标签的纯编译或合成Flow通过不证明模型会选择该标签，也不证明V已能拒绝错误字段。最小测试后运行完整相关grounded／评测回归、类型检查、Standards／Spec独立审查，本地提交及历史扫描。

## 范围外

不修改Gold、旧审核、任何闭账、V提示／schema／nullable判定、typed包装待决策、0.7／风险／语用／逐维度合取／整组去向／bad_auto门及产品空放行表。此次仅离线代码，不自动创建真实预算或启动后继，不改三张原票State／AC、不读取真实聊天、不涉及桌面或外部发送。


## Answer

已实现单一v4 stable_fact完整叶及专属指导，最小红→绿、旧协议字节负控、Root75项grounded／193项评测单元和集成112项逐条通过，mypy两源码通过；集成另有1测试及2组环境准备跳过。独立代码审查Standards／Spec均0，具体命令、真实错误保留与质量限制见[result](result-20261016.md)。此规格仅离线表达能力，原三票及真实质量保持未完成；无新真实调用或业务变更。
