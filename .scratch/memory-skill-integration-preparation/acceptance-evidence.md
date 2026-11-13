# 固定成果的交付与验收证据

本页只核验固定S中的文档、代码及Git映射，没有重跑来源测试、读取仓库外原始日志或审阅真实模型载荷。表中计数是来源记录，不是本轮成绩，不同票的重复方法不能累加为“总测试数”。

以下任务路径统一位于 `S:.scratch/memory-skill-evolution/`。表中短提交只用于定位，所有可达提交的完整身份见[commit-index.tsv](commit-index.tsv)。

## 15项逐项核验

| 项 | 原票功能依赖 | 实际交付锚点与验证口径 | 固定文档证据 |
| --- | --- | --- | --- |
| 01 历史状态 | 无 | 原实现b02cf4ba，S整合db83d794；184/184；新页面1/1，旧阅读页面另轮9/9 | `issues/01-historical-current-status.md:37–116` |
| 02 更新事件 | 01 | d17036b6；A/B最新530及未受影响C原点65为595合格并集；页面2场景 | `issues/02-memory-event-update-dedup.md:36–42` |
| 03 纠错保护 | 无 | 14893b7d；冻结候选完整分组395/395；页面来自此前ca3adb86，P1修复后未重跑页面 | `issues/03-correction-rejection-regrowth.md:36–63,163–195` |
| 04 旧回复 | 01、03 | 页面最终142a9754，后端08bbb8e0；581单元与764集成分别完整通过；页面2/2 | `issues/04-historical-reply-evidence-change.md:42–95,158–183` |
| 05 联系人概览 | 01、02、03 | dc3e81d1；119单元+418集成合格并集；页面1/1；源060 | `issues/05-contact-relationship-overview.md:42–114` |
| 06 本人概览 | 01、02、03 | 0509b08f；119+434=553合格并集；061说明改动后只复验受影响13；HTTP3方法分轮恢复；页面1/1 | `issues/06-owner-facts-preferences-overview.md:46–79` |
| 07 实际检索 | 05、06 | 6007bac8；325单元+870数据库为1195分阶段合格；HTTP4方法分轮；页面1/1；无新DDL | `issues/07-overview-evidence-reply-retrieval.md:52–111` |
| 08 长期偏好 | 无 | 产品84d13f70、测试86ce132e；450单元及942集成均为合格并集；正式偏好21；页面2case/2场景；源062 | `issues/08-explicit-expression-preferences.md:36–46`；`validation/08-expression-preferences.md:203–224` |
| 09 学习草稿 | 无 | d0714a1f/798cac9b；本树147 PG/HTTP及补差33，纯43及补差16；不能拿外部932当本树运行；页面1/1；源063 | `issues/09-automatic-skill-drafts.md:36–44`；`validation/09-skill-learning.md:24–46` |
| 10 审核发布 | 09 | 最终产品至3cdc2117；395集成合格并集，skills43/reply325/桌面49；页面1/1；源065 | `issues/10-skill-review-scope-publication.md:47–57`；`validation/10-skill-review.md:67–79` |
| 11 更新回滚 | 10 | fc3981d1；13模块129/129单轮相关PG/HTTP；页面1/1；源066 | `validation/11-skill-lifecycle.md:26–38` |
| 12 范围反馈 | 10 | 产品527840a8、页面装配3985650f；23模块288/288单轮、纯377、桌面56；页面1/1；源067 | `validation/12-scoped-skill-feedback.md:33–48` |
| 13 资料升级 | 01、02、03 | 融合7af7e083、签收4b28f4c3；57历史恢复目标全覆盖；527唯一方法分阶段；页面1/1；源064此前承接 | `issues/13-legacy-memory-comparison-upgrade.md:45–51`；`validation/13-legacy-memory-upgrade.md:34–53` |
| 14 语义研究 | 无 | Type: research；175c945b原研究、50766c06整合；18/18是既有实验合同回归；结论不启用生产语义 | `issues/14-semantic-retrieval-gap-evaluation.md:42–121` |
| 15 同源组合 | 04、07、08、11、12、13 | 审查R；448单元单轮、612唯一集成分阶段、10组合方法分阶段；有限React页面1case | `issues/15-combined-evolution-acceptance.md:44–50`；`validation/15-combined-evolution-acceptance.md:71–110` |

15张任务顶部全部 `State: resolved`，全部有 `## Answer`，94项已勾AC、0项未勾AC。[issue-index.tsv](issue-index.tsv)保存原路径、blob、依赖和Answer起始行。顶部 `Triage: ready-for-agent` 是角色字段，不能用它推翻resolved状态。

## 提交与来源映射

01原b02cf4ba不在S祖先链，实际db83d794带cherry-pick来源；时间模块、当前状态模块、HTTP测试及任务文件与原成果无差异。14原175c945b同样不在祖先链，50766c06的3份reports与原研究相同，Issue14:117–121记录整合复算与18/18。它们不属于“缺失实现”，也不应再次重复实现。

R→S仅一个签收提交，变更 `integration.md`、`planning.md`、`spec.md`、Issue15和Validation15五份文档，产品、测试、SQL零差异。源第15项最终Standards硬0/possible0、Spec0/0/0审查范围为 `4b28f4c3→c30a4051`（Validation15:106），此前各票沿用各自审查记录，并非在R重新审查整个B→S差异。M×S兼容代码尚未形成，不能继承为已审查。

137个S独有提交包括实现、兼容修复、测试、研究、领取/暂停/验收过程，不是137个独立功能。原任务的产品依赖也不是完整集成图：06实现复用05投影；02实际复用03防纠错；13的064外键依赖09的063；12 SQL依赖11复合键。详见[集成方案](integration-plan.md)。

## 旧记录与当前状态的区分

| 材料 | 读法 |
| --- | --- |
| S planning/integration中“14/15”“15 open/claimed”“暂停”“09未签收”等段落 | 保留的历史过程；最终顶栏、票Answer和文末15签收才是固定S状态。不据旧段落重领旧票 |
| S `architecture/README.md:27`“仅发布规格与任务，尚未据此实现” | 未同步旧状态；不能覆盖实际工程交付，也不能反向把架构描述当运行证据 |
| S ADR-048:3、末尾“待实现/尚未运行验证” | ADR目标约束仍有效；实现状态说明需要后续定向对齐，不修改历史决策原因 |
| S `backend/database/README.md:308`的064待验收 | 旧阶段说明；迁移真实签收以13/15 Answer及验证记录为证，canonical移号后另写新说明 |
| M前台/交付验收记录 | 只证明M实际覆盖的App/单联系人范围，不能移作新增记忆/Skill/准备快照组合验收 |
| S之后源树的提交主题 | 代表本批之外已有独立修复工作；未读取其真实载荷或结果，不在本轮作质量裁决 |

本轮不修改上述原材料，避免替其他会话更新索引或把旧证据改成新运行。未来集成时同步当前状态入口，并明确区分源验收、集成验收和真实环境验收。

## 必须保留的验收限制

**612不是单轮全绿。** 原599轮涉及45个唯一失败目标，之后准确恢复，再增加2并发与11个版本传输方法，形成612唯一方法分阶段通过。原空库准备、过窄守卫、macOS沙盒地址语法和旧GET故障预期失败保留。448单元才是最终单次通过；桌面类型、安全44、组合/学习/升级63、补充272分别通过，不能合成一个从未执行的总轮次。

**13的间歇HTTP超时根因未解决。** `validation/13-legacy-memory-upgrade.md:36–49`保留485/42/59等原轮失败，之后原代码、原10秒阈值下3/3及原顺序37/37恢复；没有确定锁死或夹具串扰根因。后续集成若再出现，应保留精确方法和轮次诊断，不能放宽阈值掩盖。

**15的升级链是保留人工决定的空动作。** `validation/15-combined-evolution-acceptance.md:45–46,60,108`说明同源链比较/确认/幂等/恢复/删除已验，但没有在该组合验证新增事实成功。后续应同时覆盖“合法新增”和“人工保护导致无新增”，不能只重复空动作。

**语义研究保持不启用。** 14记录的历史向量改写召回提高，但质量组误注入15/95→36/95，未通过。后续判别器只是研究提案，未实现或评测，不改变ADR-028生产词法基线。

**默认质量门与实际配置分开。** S `memory_extraction/dimensions.py:240–241,321–322`默认allowed为空、gate_enabled=True；`:315–318`支持显式=0运维回退。本轮未读环境，不能说实际配置已核验。新增schema、事件字段、语义支持、工程通过均不放行维度。

**真实环境不在S签收范围。** 真实模型质量、真实App/微信/原生权限、真实业务资料升级、业务迁移、外部发送、部署和远端发布均未在这批工程签收中验收。真实HTTP/隔离PostgreSQL与生产React页面中的“真实”指工程边界，模型仍受控、资料为合成，不能改写为真人效果或生产验证。

本准备只读核验这些记录，不能进一步证明原始运行日志的完整性、外部副本删除、正式数据可恢复性或main集成可用。
