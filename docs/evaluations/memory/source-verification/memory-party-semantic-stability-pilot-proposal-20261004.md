# 直接参与者核验语义稳定性有限对照提案（2026-10-04）

状态：待用户决定；不自动执行。上一轮48次额度已经因阶段1门失败而永久关闭，本提案申请一笔全新的、独立的最多8次匿名V调用。提案只针对已复现的“人物集合判断正确，但来源`verdict`偶发返回`uncertain/pragmatics`并给Fact增加不必要`semantic:pragmatics`”问题，不把本机重放当作模型准确率。

## 已完成的诊断

阶段1的两次候选公开V输入字节级相同，SHA均为`3f4073ffd78e67b7eec7a8cdf45d6677ac1d1a8e2f79dd2054ddbc061d6efeb7`。ECNU返回却不同：第一次是`described_party=mixed`、`verdict=uncertain`、`issues=[pragmatics]`，第二次是`described_party=mixed`、`verdict=supported`、`issues=[]`。两次都报告现有ECNU的`deepseek-v4-flash`，均无`system_fingerprint`；第二次有`cache_read`，但没有服务侧追踪，不能据此断言具体根因。

本机用捕获响应重跑真实`ExtractionFlow`，没有联网、没有模型调用、没有业务写入。离线矩阵显示：

- `uncertain/pragmatics`配短引文或带句号引文，都会给Fact增加`semantic:pragmatics`；
- `supported`配短引文或带句号引文，都不会增加该风险。

因此，当前能确认的是返回的`verdict`造成编译差异，引用标点不是直接编译原因。完整诊断收据保存在仓库外私有目录，文件为`semantic-diagnosis-v1.json`，SHA256为`d9872f76c364b9bc768681720190512076c51b93d5fa35a7a64433867be4fbde`，权限为0600。收据同时记录了提示歧义、`verdict`与人物扩展字段耦合、缓存／隐藏thinking等尚未单独验证的假设。

## 只检验一个变化

候选与基线继续使用同一匿名C4窗口、同一原14字段、同一工具schema、同一`PartyGuardRuntime`、同一`ExtractionFlow`、同一现有ECNU配置。候选臂只在人物附加提示中增加以下一段，其他文本和代码不变：

> 来源支持与`described_party`是两项独立判断。`described_party`只回答事件、状态或属性的直接参与者集合，不改变来源`verdict`。`speech_act=report`且`assertion_status=reported`表示明确转述；如果候选正文、字段和来源证据均被原话支持，`verdict`应为`supported`且`issues=[]`，不能仅因`report/reported`、第三人转述或候选`subject`不是直接参与者就判`uncertain`。只有来源支持不足、真正歧义或与原话矛盾时才使用`uncertain/unsupported`。语用状态仍由候选已有字段和后续`PragmaticInterpreter`处理。

这段话不授权模型改写候选、改变主体、补日期或升级采纳；现有“不确定则只降级、不强行升级”的Flow保持不变，`supported + third_party + assertion/asserted`的窄guard也保持不变。若返回仍为`uncertain`，系统继续按现有fail-closed路径加风险并保持待确认，不在代码里把它强制改成`supported`。

## 新的独立运行范围

- 只用现有ECNU `ecnu-max`及已配置地址；不读取、不使用DeepSeek官方key或官方端点，不设置回退。
- 只读已批准的匿名C4合成窗口，不读真实聊天、actual/held留出或其他联系人，不写业务记忆、水位、旧五条资料或产品默认。
- 新建独立私有目录和新预算，最多8次公开V；不借用上一轮已关闭的44次，不重试、不调参、不补位。
- 预先冻结授权、单叶提示、输入、独立参考、配置、运行源码、隐私投影和台账；先做0API dry-run、类型／AST／SDK仅绑定和两轴预检，凭据读取必须晚于所有冻结。

### 阶段安排

| 阶段 | 固定位置 | 最大公开V | 继续条件 |
| --- | --- | ---: | --- |
| 1 | C4：r1基线／候选、r2候选／基线 | 4 | 候选`mixed`与目标证据2/2；候选完整Fact无新增`semantic:*`风险2/2；候选最终仍因`report/reported`待确认；基线至少出现1次旧`contact`错误；无坏auto |
| 2 | C4：r3基线／候选、r4候选／基线 | 4 | 与阶段1合计候选`mixed`4/4、证据4/4、完整Fact无新增语义风险4/4；基线至少出现1次旧方向错误；无坏auto、误拒或不必要降级 |

阶段1任一门失败，立即关闭余下4次；阶段1通过才开放阶段2。阶段2通过也只说明这组匿名C4在这处单叶提示下更稳定，不代表整体记忆准确率修复，不自动进入真实资料、同批自然聊天、留出或默认发布。任何运行／结构／隐私／冻结错误都立即停止并保留分母。

## 审计与结束条件

每个阶段先独审raw返回，再揭示compiled／Flow／去向；逐项记录人物标签、目标证据、原14字段、Fact风险、语用待确认、坏auto、误拒、重复和运行失败。raw与full审计、预算预约、无正文台账和关闭收据必须相互对应。失败或效果不明确时保留首返回并关闭全部余量；不以删候选、统一拒绝或增加pending换取通过。

本提案只申请上述8次匿名对照。若要修改产品提示、接口或默认路径，必须在结果通过后另行按领域文档、ADR和两轴审阅决定。
