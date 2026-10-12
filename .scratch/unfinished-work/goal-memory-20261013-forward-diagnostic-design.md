# 前瞻审核校准、四窗诊断设计与工具结果（2026-10-13）

本文件初版为Root要求先提交的可执行设计，随后Root只批准工具叶与提示叶分主题实施，**未授权新预算注册或模型HTTP**。下列设计依据保留，末节另报已经执行的工具结果；两份提示当前尚未再次编辑。原[独立候选终态](goal-memory-20261013-candidate21-result.md)、全部旧sealed raw/full、原Gold21窗／28必需命题、safe-only完整门、质量门、生产默认空放行表保持原样。当前七个run全部closed，真实HTTP34／30个200／4次旧read_timeout远端未知；本文新增HTTP、注册、App、业务库、密钥读取均0。候选A05晚到的full仍不计正式；没有第四基线。

## 前瞻标签校准与实际红灯

下一份审核rubric只向前适用：`safe`表示输出忠实、边界明确；准确保留未知身份、方向或未给出的结束时间本身不等于不安全。`ambiguous`表示输出没有守住这些边界或仍不能作为确定主张；`wrong_person`、`false_fact`和`unresolved`各自原意保持。不以未来full结果回写raw标签，不用这份说明给旧A03 full0救分。

全新公开合成控制沿用完整Gold A03，重新构造E14／V4／最终去向与显式审核，未读旧模型审核。私有`forward-rubric-probe.py`实际6个方法，5绿／1红、0错误，单调0.025253417秒：忠实未知＋safe＋正确pending得到完整1；错误确定人物、原ambiguous-auto与原Gold不变控制均通过。红灯是忠实未知＋safe却被最终层强行auto：完整0但`ambiguous_auto=0,bad_auto=0`。当前`evaluation_review.py:317`只由raw标签为ambiguous触发其auto风险，前瞻定义会使这个错误仅一般失败，不能把标签澄清写成无风险的文案修补。

拟最小工具修复是保持`_complete_group`的safe-only原门，只强化机械安全计数：实际auto映射到原E的非空`alternatives`时同时计`ambiguous_auto`和`bad_auto`；这复用产品`pragmatics.py:67`已有降级语义。实际auto的已显式group.destination失败另计bad_auto，防止确定性的错误去向只报一般错误。原其他wrong／false／ambiguous／unresolved与未映射auto守卫均保留。不是新的产品采纳门，也不新增字段、语义猜测或Gold变体。该建议仍待Root批准后才实现红绿；现红证据保留，不改原报告。

## 实际失败与最小提示候选

| 来源 | 本轮正式失败 | 拟补的共性规则 |
| --- | --- | --- |
| A01 | E正文、category、speech_act、assertion_status、理由5项；V verdict/issues与语义漏检 | 否定句与“不是…而是…”不能单独证明发生过纠正；correction须有窗内明确纠正行动或有据先前主张，不能编“此前说法”。未知第三人职业陈述仍保持转述范围，不拿确定的句式覆盖report/reported。 |
| A02 | 转述邀约分支已对，但valid/invalid两槽混入未来活动期间；风险额外“见面”；V时间漏检 | 先选记录已发生邀约经历／转述还是未来安排，正文阶段、category、语用及两时间槽必须同一分支；历史邀约可以保留未来活动的相对期间，却不能用该期间充当历史事件有效期。普通见面／娱乐邀约不自动证明敏感风险；不删真实风险或改变白名单。 |
| A04 | 暂时“先”已恢复；正文缺来源日期、未知事项alternatives为空 | 来源观察日期、暂时限定与未知事项备选是三个独立槽，写“具体事项未明”不能省略alternatives；未知备选只说明本窗未定，不编事项或亲友角色。来源日出现在日期字段也不能替代跨期正文的观察日。 |
| A05（控制） | E14／V4等事后正确，full在closed后迟到 | 保留本人参与的已发生关系经历／双null控制；本轮只能作固定诊断中的新控制，不给上次formal unknown补分。 |

所有提示修改仅`adapters.py`和`verification_adapters.py`两个system常量，保留已有条件、假设、时间规则和全部排除项；不按case_id特判、不改schema／Gold／模型thinking／默认表。V仍只按当前可见字段核验，不声称认证其不可见的风险、备选、confidence或理由。字段值和confidence保留真实响应，不为了过门改0.75或制造缺失值。

## 四窗API可行性与最小接缝

现有`run_ecnu_evaluation`入口固定21窗和cap42；`_run_evaluation_batch`已支持显式cases、plan、独立预算与同值SDK／双HTTPX参数。不能假记cap8却实际注册42，也不能以离线Mock入口冒称真实渠道。`PhasedEvaluationAudit`现按stage local position直接索引完整Gold；A01／A02／A04／A05的第三、第四项会错绑原A03／A04，不能截断、重排或修改Gold回避。

建议仅评测入口增加显式`case_positions`可选参数，默认None仍为原21／42；诊断传固定tuple `(0,1,3,4)`，每个位置必须builtin int、范围有效、唯一、顺序冻结，实际预算由`2*len(selected_cases)`得到8。完整Gold21／原source hashes仍照原门核验，配置另列selected positions／case names、局部计划摘要与完整Gold摘要。无效选择先于预算／凭据／HTTP拒绝。真实协议须与PhasedAudit声明的相同选择严格一致。

PhasedAudit增加不可变的local→original Gold位置映射（默认完整原顺序），验证case_name与输入摘要后取原Gold窗；持久event／receipt仍用本stage local position，reference_case保留原Gold position及case_id。显式两位置防止错误同序假通过；重复、越界、缺失、交换、布尔与错输入均需负控。原全21入口／位置与保存能力验证照旧。没有产品调用点或新增产品API。

## 有限审核、视图与停止

实际full视图约94KB，包含整套21窗reference与重复layers；raw视图约23–26KB。当前PhasedAudit view本来没有provider response内部思考，不能宣称新桥首次去除了思考。拟另保存可逆核对的compact投影：raw只显式当前window、完整E14、当前Gold窗／全部相关规则与完整视图SHA；full只在raw持久封存后显式当前E／实际V输入／V4／final去向／lineage索引与sealed raw摘要。完整视图和原证据仍保存，投影字段缺失、摘要不符或跨phase泄露应停止。

私有新桥将phase上限从300改为固定600秒，并保留读前／读后monotonic边界、raw封存后full、绝对总场次SIGALRM和每HTTP起发至少300＋45秒。每phase计时与可控阶段错误码只保存元数据，不能靠删困难审核或晚到文件救签。不得在待full审核时扩展独立分析；先显式逐字段完成本phase后再事后诊断。600秒属于审核操作期限，不放宽语义门；完整/late、unsafe/unknown、源码或载荷漂移、非法工具、预算/持久化/cleanup未知仍立即停止闭账。

## 拟新分配与验证范围

仅把此前从未激活的预留9分8给**新唯一UUID**的固定最多4窗诊断，余1不启；全量280不启。新immutable amendment保留v1–v4、原index与七closed34、所有关闭余额及永久退役12，完整表仍480；不注册补位UUID、不给第四基线、不自动继续。具体UUID／唯一固定起止窗口待Root选择此设计后一次冻结；每HTTP最后起发点为总截止前345秒，不滚动延长。

四窗局部分母为5个必需命题，原21／28分母与未选17窗单列；不能用4窗签≥15达标签、完整当前基线、140窗回归或自动放行。A01/A02/A04只有既有正式历史结果可对照，A05旧formal未知明确保留，新控制不虚造paired；prompt修复效果必须以新真实输出而非离线测试判定。

最小工具源码范围：`evaluation_review.py`、`evaluation_phased_audit.py`、`evaluation_ecnu.py`及相应两个unit／一个integration模块，另因显式选择须持久冻结而经Root批准在`evaluation_records.py`配置键白名单仅加`selected_case_positions`一项；两个E/V提示常量为后续独立主题。私有新桥／selftest／compact装配与immutable计划在0700／0600目录，不修改旧bridge或封存。工具完成后仍须Standards／Spec独立只读、独立主题本地提交与Root最后SHA/source/blob/versions/budget核验；当前没有新调用授权。

证据根`/private/tmp/notalone-memory-goal-20261013-ac04d687/`：所有新脚本、回归与状态证据均0600；Root与审查者只需公开Gold、合成控制和既有允许视图元数据，不读取任何内部思考、私人资料或密钥。当前真实模型总计仍34。

## 工具叶实际红绿与边界

Root批准后先新增6个公开回归方法，原源码下实际exit1：2个安全计数断言fail，21个选择接口不存在的subcase error；unittest 0.805秒，外层单调1.088027292秒。不是模型语义测试。两次查找ECNU测试文件的路径错误另由工具输出保留，均未到测试，不计产品red。

实际最小修复保持safe-only完整门；仅actual-auto＋非空原E alternatives及显式错误group去向强化安全计数。显式选择最多4个唯一builtin int原位置，stage plan仍local0…N-1；PhasedAudit保存不可变tuple映射，验原窗名称／输入摘要后使用完整原Gold。实际ECNU入口要求选项与该映射完全相同；错形状、bool／重复／越界／缺失local／错输入／错名称／互换位置在预算、凭据或raw揭示前拒绝。默认None仍全21／cap42／P1，默认冻结config没有新字段；只有显式diagnostic添加选择位置，持久键白名单未扩大正文、响应、秘密或续发能力。

四个最小相关模块（review、phased、ECNU integration、records）实际**79／79通过**，unittest **5.693秒**、外层单调 **6.033537250秒**，exit0。精确SDK Mock四窗均E/V各一次，持久cap8／预约8、SDK及双HTTPX300/0，原输入摘要及完整Gold计划绑定保持；该8是隔离临时HOME中的合成预约，不是新真实HTTP。真实transport、socket与DNS由既有integration守卫禁止，根`.env`保持禁读，临时预算随自有TemporaryDirectory清理。

原全新Gold A03六控制复制回放，唯一改变输出文件名，原红脚本／结果未覆盖：实际**6／6绿**，单调0.024542541秒，HTTP0、旧模型审核读取0。正确未知＋safe＋pending完整1，错误人物及未知／ambiguous auto都保留安全计数；原Gold文件SHA未变，没有给旧A03重新计分。四个修改源码mypy实际exit0／1.317967250秒；`git diff --check`通过。证据为`four-window-tool-{red,green-attempt,mypy}`文本及各自status JSON、`forward-rubric-{probe,replay}.py`及各自result JSON。新增HTTP／业务库／App均0，质量认证false，提示修复／compact600桥／新预算尚未运行。

Standards与Spec以固定`ccf6fddd`精确八路径各独立只读核验，最终未解决均0；实际源／测试七SHA与私有验证快照一致，未代跑供应商或替代语义质量。79项与四源码mypy之后，review仅补rubric注释和局部变量命名；因此对最终字节另执行3个相关安全计数方法／0.004秒、外层0.082754250秒，以及单review源码mypy／0.325283125秒，均exit0，前后SHA均`7b0df754bd58fe3242fd6815a3faa9c01b3b297b2af8e2fdc259e191e173ea9c`。不重跑79全集，不把后续样式调整冒作原验证时点；证据`four-window-tool-final-review-check.{txt,json}`。Root统一安排只含本主题的本地提交；两份提示将在新的独立主题文档记录。
