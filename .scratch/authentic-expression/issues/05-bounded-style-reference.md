# 05：生成时有界引用表达样本

State: resolved
Triage: ready-for-agent
Blocked by: [authentic-expression/02 当前意图优先的生成与改写](02-current-intent-priority.md)；[authentic-expression/03 无依据扩写的约束与失败呈现](03-unsupported-content-boundary.md)；[authentic-expression/04 表达样本的主动保存、查看和删除](04-style-sample-lifecycle.md)

拆分标识：E05（第三版映射；执行时以本文件为准）。

## 规格与范围

[正式规格](../spec.md)；旧03；样本参考。 读取[工作流](../../../docs/agents/workflow.md)、[工程要求](../../../docs/agents/engineering.md)、[领域路由](../../../docs/agents/domain.md)、[领域语言](../../../CONTEXT.md)、[ADR-044](../../../architecture/adr/044-explicit-style-sample-retention.md)。依赖是完整交付的前置，不代表这些前置已完成；本票原自动验收范围已完成；跨规格组合状态见 E06。

## What to build

在已确认联系人生成时使用低权重有效样本，展示实际用到的项；无样本正常工作，删除后不能继续使用。

## Acceptance criteria

- [x] 已确认联系人生成仅有界选取有效样本，最多5条且计入现有输入预算，展示实际用到的样本；无样本正常工作。
- [x] 样本仅提供低权重说法参考，不提供本次事实，不覆盖当前意图，不进入方向探索；与E02/E03保真契约一致。
- [x] 删除样本或原始来源后，相关输入、派生上下文、缓存及重试副本不可复用；生成/删除竞态不能提交旧结果。
- [x] 重试重放核验来源及样本仍有效；重新连接助手会话和Skill探索载荷的跨规格组合由E06验收。
- [x] 新增路径按owner/contact隔离，保留来源及删除路径；敏感正文不进入普通日志，候选只能由用户亲自发送。
- [x] 记录实际命令、结果、数据影响及剩余风险；未执行的验收不得预填通过。

## 范围边界

样本只指导说法不提供当前事实，当前意图优先，方向探索不用样本；覆盖生成/删除竞态及派生证据清理。

## 验证与交付

使用公开页面操作 → 后端HTTP → 隔离PostgreSQL，复用真实业务控制器与存储，只替换模型、消息到达和必要宿主事件为可控合成适配器。观察公开结果、持久化重读和模型调用次数，不绑定内部调用顺序。

按工作流以TDD垂直推进，完成相关验证、Standards/Spec两轴评审与本地提交后，在本票补充Answer并据实更新状态。合成响应只证明数据和控制契约，不证明真实模型语义质量。真实App只能由主Agent在另行约定的有限窗口通过项目入口验证；页面结果不能代替原生证据。

本票不授权OCR、真实微信读取/发送、外部模型调用、部署或push；也不提前实现其他票。

## Comments

2026-10-11 A12共享来源夹具接续：总协调指出旧`test_postgres_reply_flow`内存检索只给合成UUID、隔离PG没有对应原始来源证明，模型／预算前被C中央来源守卫拒绝。本C沿原正式53随机库实际复现8项中2通过／6ERROR／0skip／0.367秒，全部在prepare_context的原始来源不可用；只为原夹具种同owner/contact的一个合成source_document、两条实际消息及各自source_ref，原生成／来源守卫及测试断言未改。原8项随后全部GREEN／0.754秒、skip0，正式53重复0、自有数据库精确剩余0。此为实际测试前置修复，不冒称产品来源放行RED或完整A历史／预算接线完成；无自动采纳、外部模型、私人资料或页面／App。

去重后的同一相关HTTP组再次实际28项GREEN／29.165秒、skip0、正式001–053，六个本轮Core库精确剩余0，原模型期间sample删除／租约拒绝诊断保留。实际入口均为Conda NotAlone、backend内、PGHOST=/tmp、NOTALONE_DISABLE_DOTENV=1、两tracing=false、PYTHONPATH=src；测试模块为`tests.integration.server.test_style_reference_api`、`test_style_samples`、`test_authentic_expression_session_deletion`、`test_authentic_expression_candidate_versions`、`test_authentic_expression_skill_exploration`、`test_style_reference_budget_api`，复用真实HTTP/正式装配和自有随机PG，仅模型与资料为合成。59项存储/codec入口由本轮显式创建的随机_test库在模块导入前设置NOTALONE_TEST_DATABASE_URL，正式53及repeat()均核对，最终逐一DROP；没有App、OCR、外部实验或隐式采纳。

总协调主树集成上述正式 `3471b181eedc6dd8a1446b149b35985f937889f1` 六文件；相关版本删除组合测试另精确取正式 `5e1ddbb306e5b810ed7e6666ff486200fb0aa761` 的单个 TEST，不重复消费已有 A053、A11 或其他任务文档。Conda `NotAlone`、关闭 dotenv／追踪、`PYTHONPATH=src:.` 环境：

- `python /private/tmp/notalone-coordinator-isolated-tests.py /Users/local-user/learn/NotAlone tests.integration.persistence.test_reply_discussion_dependencies tests.integration.persistence.test_assistant_discussion_context tests.integration.persistence.test_assistant_candidate_versions`：58 项 GREEN／11.721 秒（10 中央依赖、32 完整历史、16 版本及迁移），正式 001–053／52 升级与 fresh 重复迁移，自有根库及嵌套库残留 0。
- 同 runner 运行上文六个 server 模块：28 项真实 HTTP／正式隔离 PG GREEN／30.937 秒，自有库残留 0。首轮因主树缺上述正式 TEST 为 27 项中 26 通过、1 import ERROR／33.705 秒；补齐后原六模块复跑通过，不把 import 错误称为产品 RED，也不删原断言。运行中删除样本的既有租约失效诊断保留，拒绝和清理断言通过。
- `python -m unittest discover -s tests/unit/reply -t . -q`：283 项 GREEN／8.082 秒；权限撤回负例有既有无正文 Skill 日志。`python -m mypy --follow-imports=silent src/notalone/persistence/reply_discussion_dependencies.py src/notalone/reply/context.py src/notalone/persistence/reply_store.py`：三个源码通过，未外推为全库类型通过。差异检查和最终基础／新增 TEST 两轴审查均无新问题。

本切片完成中央基础接口的真实主树集成；完整 A 身份消费者与运行时、已明示 running 纯草稿豁免的物理擦除 RED 仍由 A／C 接续，05 继续 claimed。存储适配器的编辑／选择组合不冒充 B08 的公开编辑页面，未执行人工或原生验收。


中央guard审查发现嵌套全历史重复展开：新真实PG观察在同次读取对两个request执行三次HISTORY，严格唯一性断言genuine RED／.365秒。先前默认tuple row_factory入口ERROR不是该产品RED；修后TEST更新样本deleted但忘清final_text触发既有049 CHECK，59项中58通过＋1夹具ERROR／7.306秒，不算整组GREEN。纠正符合既有删除状态约束后，中央单次同步复验以actual connection／owner／request UUID去重，仅记录UUID集合，拒循环且finally重置，不跨调用留结果；同一连接的下一读取仍实际发现删除。最终own10＋A23＋版本16＋pure10共59项GREEN／7.713秒、skip0、正式53重复0、自有库0（版本的52升级／fresh两专用库亦0）。Standards原possible重复展开P2已关闭，最终hard0／Fowler0；Spec本C增量0，A consumer P2和既有runningfalse清理风险继续保留，不据此关闭E05。

`python -m mypy --follow-imports=silent`新helper／context／reply_store三文件GREEN。四文件首次包含style_sample_store时有两条旧错误；以3a8d53d原文件＋MYPYPATH=src复核，原_as_sample可空与类方法list遮蔽注解同样两条，未把基线写成全量type GREEN。第一次临时路径复核额外遇import-untyped是入口差异，随后正确源路径复核保留上述两条；未修改无关旧逻辑。


2026-10-11：C中央历史依赖切片复用A正式2c0 protocol，`ReplyContext.assistant_discussion`默认None且只在内存携带真实DiscussionContext。新增同连接／同owner事务ports `capture_reply_discussion_dependencies`、`require_reply_discussion_dependencies`、`reply_style_sample_dependencies`；只在既有context_snapshot记录严格version1身份SHA和独立历史sample UUID数组，raw根进入既有original_source_use。当前直接参考仍最多5完整／600，use集合与本次receipt不纳入历史样本。模型前及save用CURRENT，完成结果读取／同键重放用HISTORY；后来的当前输入不能令有效旧结果失效。没有新迁移、另一reader/codec、历史正文持久副本或模型实验。

原两项真实PG RED分别为模型前metadata缺失、删除未清历史-only新候选；实现后同两项GREEN／.499秒。随后9项实际PG／正式001–053／重复0 GREEN／1.941秒，覆盖历史manual不在本次5项、派生主动sample与turn/input正文清理、真实同key未save且FK=NULL、迟到save拒绝、新pointer仅阻旧CURRENT但完成HISTORY可读和原样重放、捕获丢弃／样本集合篡改拒绝、raw历史-only捕获与运行删除、跨owner/contact隔离、主动sample在assistant删除后独立保留及后续依赖删除。较早7项联同A23、版本16（含两schema专用场）与codec10共56GREEN／7.998秒；本主题相关28真实HTTP／正式53 GREEN／30.368秒、skip0，六个实际Core库精确剩余0；回复unit278GREEN／1.711秒。各PG自有_test库逐一DROP，未处理业务资料。

仍有明确A正式配合缺口，不能据以上结果关闭本票：A provider／完整模型history／总预算／failed-replaced输入未接。Spec新P2指出A_generation_dependencies只读direct use，须由A唯一调用本次C `reply_style_sample_dependencies`，纳入跨会话continued祖先metadata后再构造其identity SHA；C不复制A读取。另独立合成探针已实际取得1项genuine RED／.153秒：`_seed_history()`后`_prepare((), relationship=False)`，删除old sample，C请求已物理删除，但A旧independent_draft豁免仍留turn failed＋input_payload及active input；必须沿A公共清理契约区分实际history依赖和无关草稿。C已修自己的contacts按实际owner/contact/key关联未save A记录；不把sample UUID伪作raw依赖、不私改A状态投影。上述原RED与未接部分真实保留，本票继续claimed。



2026-10-11：用户认可30票复审修订后发布；表达样本独立保留规则已单独确认。尚未开始实现或执行产品验收。

## Answer（独立切片，最终预算待接续）

2026-10-11：沿正式049实现只读表达参考port，独立`ReplyContext.style_references`与`context_receipt.style_sample_ids`（默认空）。最多选择五个有效完整样本，另有600字符取数界限；不截断样本文字，不新增EvidenceKind或迁移，不把样本ID当事实citation。原始草稿未开关系语境保持不读历史／样本。样本作为低权重说法载荷，本次明确意图仍按E02/E03契约优先；这不是自动语义判定。

实际使用在runtime前、同owner锁记录到既有`reply_style_sample_use`，其当时原始来源合入049原始快照；提交复验相同使用集合。模型期间删除样本会清理running派生请求并拒绝迟到结果／同键重试；已完成结果、后继与主动保存的派生样本按实际使用关系清理。候选重读复验样本及来源，使用回执排序稳定；快照仅增加样本编号，不另存样本文字。桌面展示实际使用的项，空／失效投影不恢复旧正文。

`tests.integration.server.test_style_reference_api`真实HTTP→生产装配→正式001–050随机隔离PG共7项通过：有界／范围／重放、无样本、默认纯草稿、样本不能作事实引用、模型期间删除、派生样本与旧重放清理，以及原始来源只由样本引入时的实际五步删除。全部仅替换模型，`dimension_release=None`；数据库DROP并精确核验。首个实际RED为已保存七样本但模型输入零参考，接线后green；实际重读排序差异也已修正，断言未放宽。

同一E01报告入口交付`docs/evaluations/authentic-expression-style-reference-http-v1.json`，实际两个模型调用捕获输入、期望、输出和四维标注依据，其中一个故意改变意图并从样本扩写未来承诺的输出如实失败。两例均开发集和synthetic_fixture，真人通过0；自然度、关系适配及本人相似度未知，不证明真实模型质量。

最终相关HTTP／PG分组25＋37共62项通过、无skip，正式001–050迁移和数据库精确清理；完整reply unit186、TypeScript及safe40通过。首轮合跑的随机库名超过PG长度上限，两个类被隔离护栏拒绝；补跑入口一次迁移路径错误在测试前停止。两次失败均已清理，修正测试入口后37项green，未删减产品断言。两轴最终0：报告滞后问题用最终捕获重建并逐例复核关闭，没有为报告新增模型调用。

具名`style-reference`公开页面已准备，验证保存七项→实际使用五项展示→同键→删除→旧重放拒绝和跨联系人，但尚未执行，由总协调有限预约。最终system/messages/tools/schema/输出预留总预算尚待A12正式接口，600字符不是替代计量，不能据当前切片标该验收项通过。真实B探索、会话重连与删除的组合仍由E06按真实依赖接续；不关闭本票，不运行App/OCR/微信、外部模型、自动采纳门禁、push／发布／部署。

接续实际证据：总协调已将`c376d0a`正式集成为`37d5b70`，186回复单元、51真实HTTP／PG、type通过，隔离库剩余0；`style-reference`实际公开组exit0，七保存／五有界实际引用展示／同键0新增调用／删除及旧键拒绝／跨联系人全部到达，quiet10、active0／onscreen0、单Chrome、cleanupConfirmed=true、Electron/native=false。随后消费A08正式恢复主题后，recovery＋style-reference再次全green，quiet26且收尾确认。原待运行记录属于此前阶段，不作为最新状态。A12最终完整请求预算仍待正式接线，本票保持claimed，不把这些结果记为总预算或E06全组合完成。

完整请求预算接续：消费A12正式公共切片`c4e31ef`为`e1d2274`，实际运行时在Skill动态system生效后逐轮核验全部最终请求；未知真实供应商能力／计量保持拒绝，没有外部调用。当前5完整／600字符只限制取材，不替代总预算。新增`test_style_reference_budget_api`沿生产HTTP生成与显式绑定合成JSON/framing协议验证：无样本基础总量+1容量时，加入五完整有效样本立即502／reply_budget_exceeded、零追加模型调用；删除样本后同容量允许WARNING并正常生成。能力未知且有样本时UNAVAILABLE，计量和模型零调用、候选0；实际read_file补入完整Skill正文后的第二轮EXCEEDED，只发生第一轮Tool调用，不提交新增候选、不截断原意图或样本。

Conda NotAlone／backend内`PGHOST=/tmp NOTALONE_DISABLE_DOTENV=1 LANGSMITH_TRACING=false LANGCHAIN_TRACING_V2=false PYTHONPATH=src python -m unittest tests.integration.server.test_style_reference_budget_api -q`实际3项GREEN／4.211秒。counter完整最终载荷与真实受控模型实参逐项对照，使用实际输出reserve4096；这是合成协议的精确单位，不外推供应商token。正式001–052随机库按夹具精确清理。该公共guard原行为已满足新反例，不修改产品制造RED；相关联跑和两轴接续。完整助手讨论历史sample依赖仍待A唯一sameconn只读契约，B探索guard由B负责，E05/E06保持真实claimed状态。

相关联跑实际44项真实HTTP／正式001–052随机PG全部GREEN／71.560秒、skip0，八个本轮Core夹具数据库精确核对剩余0；含新预算／Skill组合与原C有界参考／场景／删除、B公开探索／三声明／组消息。样本竞态的既有失败标记租约诊断保留，原拒绝／候选0断言未弱化；没有新增迁移、运行时或真实模型质量结论。

2026-10-11 总协调主树接续：精确集成 C 正式 `a8946af89800592530ccf12568bc25af7641a7bc` 的来源夹具和本票记录。在 Conda `NotAlone`、关闭 dotenv／追踪、`PYTHONPATH=src:.` 环境运行 `python /private/tmp/notalone-coordinator-isolated-tests.py /Users/local-user/learn/NotAlone tests.integration.server.test_assistant_input_budget tests.integration.reply.test_postgres_reply_flow tests.integration.server.test_assistant_session_api`：43 项全部 GREEN／37.857 秒（35 真实 HTTP、8 存储集成），正式 001–053、自有数据库精确剩余 0。旧 6 个来源夹具错误已在同一扩展组消除；仅补实际合成来源前置，不修改业务守卫或原断言。运行删除来源后的租约失效诊断保留，原清理与拒绝断言通过。两文件限定 Standards／Spec 审查均无新问题，未执行页面、人工、原生或外部模型验收；完整 A 历史接线与本票原剩余范围仍继续，不据 43 项关闭本票。

2026-10-11 running纯草稿删除接续（未完成）：C中央caller已按实际owner/contact/key和真实SID关联聚合turn_ids，经既有A helper传递；无第二writer或迁移。接线后本C完整12项PG实际10通过／2失败、3.490秒，正式53／repeat0／唯一自有库精确剩余0。两失败仍是历史sample受影响running rewrite的turn正文和051状态未擦除，跨新SID无关草稿正向保持；等待A正式helper取消显式turn豁免并清对应输入／current指针，不预填完成。另C嵌套夹具同类清理问题使用actual TestCase.run私有反向：首次缺URL导致一个构造异常干扰，只作入口诊断；设合成未使用URL后两真实RED.002秒，setUp前注册cleanup并向外传播doCleanups失败后同两GREEN.032秒。该probe不连接数据库，12项实际PG已复验夹具。

2026-10-11 公开HTTP再现：新增 `test_authentic_expression_session_deletion.test_history_sample_delete_erases_running_draft_without_relationship_context`，先真实助手HTTP生成使用样本的旧轮，再暂停不读关系草稿的受控模型，通过真实DELETE删除历史样本并重新装配后端读取。实际1项FAIL／2.389秒，旧模型迟到返回已拒绝，但公开turn仍为failed而非redacted；之后物理输入及current断言尚未到达，不预填通过。标准Fidelity随机_test库cleanup执行并确认不存在；既有租约失效诊断保留。与两PG失败共同等待A正式helper，本测试保持未完成工作，不以存储测试替代HTTP删除链。


2026-10-11 A正式删除修复接续：精确消费b819b660de44862657248ccd88909bba6389e978的assistant_session_store／inputs及五项依赖擦除测试三个backend，不取A票或working。C中央已按真实owner/contact/key和实际SID聚合受影响turn_ids，沿既有A helper显式传递；A显式命中的turn不再豁免为独立草稿，同事务擦除051并只清对应current指针，无关草稿／新讨论保留，无新迁移或正文副本。

原两PG失败及真实HTTP失败原断言均转GREEN。C实际A5依赖擦除＋C12中央＋C3HTTP会话／样本／raw删除，共20GREEN／29.253秒、skip0；正式53／repeat0，外层及Core两自有数据库精确剩余0。HTTP真实暂停模型→sample DELETE→后端重新装配后turn/input无正文、current清空，旧键及迟到响应拒绝，另新SID无关草稿仍running／active；此前尚未到达的物理状态断言本次已执行。原租约失效诊断保留。两个A source mypy和六个相关source/test编译通过；共享历史、输入、记忆依赖和会话删除回归及两轴继续，不据20项关闭公开UI组合。


共享删除回归保真记录：首轮四模块59项实际1FAIL＋2ERROR／108.363秒，全部自有库已清理。FAIL为旧测试仍要求current指向已redacted输入，与A b819正式清空契约相反；只将该断言改为None，保留旧输入占位、无关讨论和失效校验。两个memory-expiration子例是HTTP timeout；新隔离库原单例1GREEN／0.968秒，线程定时诊断未触发，未定位或宣称修复超时原因。原四模块完整复跑最终59GREEN／56.255秒、skip0，正式53／repeat0／嵌套和外层两自有库精确0，原租约失效诊断保留。加上前述20项最小组合，本删除主题相关验证完成；最终十文件只读两轴完成：Standards硬要求0／重要Fowler0，Spec新增P0–P2为0。复制后来copy／清空／先删SID后首次短贴的新P2独立开放，不由本删除修复关闭E04–E06。

总协调主树集成 e5cea839 的四个必要 backend 文件及 f6d94b 的五行存储修正，保留所有历史和负责人证据。原四模块实际30项 GREEN／16.713秒；追加原12样本 HTTP，在临时 runner 子进程仅显式设 StyleSampleHttpTest.dimension_release=None，真实生产 CLI 迁移与 HTTP／PostgreSQL和全部原断言保持，共42项 GREEN／28.708秒，正式001–053、重复迁移0、自有库残留0。当前样本存储限定 mypy --follow-imports=skip 单文件通过、相关四文件编译通过；首次默认两类型错误及 C 默认跨文件错误保留，不宣称全树类型通过。最终此七文件 Standards硬要求／重要Fowler可能气味0、Spec0。仅接线、来源物理擦除和样本生命周期已自动验证，C未知粘贴新合同的公开异步来源反例、A恢复复制和其他组合继续；C04–06保持claimed，人工部分未执行。

2026-10-11 按原六条验收逐项复核后完成本票，未新增模型实验或重复运行已通过且源码未变的测试：

- 最多五条完整有效样本及实际使用展示、无样本、整体输入预算：本票公开五条展示与预算三项记录、`test_style_reference_budget_api` 和已接 A 完整预算证据；600 字限制不冒作完整模型总预算。
- 低权重表达参考、当前意图优先、非事实来源、不进方向探索：`test_authentic_expression_skill_exploration` 的实际完整出站载荷及 E02/E03 契约；故意语义失败的逐例报告仍保留失败，真人质量未知。
- 样本／raw 删除和生成竞态、历史样本传播、输入／正文／CURRENT 物理清除与迟到拒绝：`test_style_reference_api`、`test_reply_discussion_dependencies`、`test_authentic_expression_session_deletion` 及本票最终清理实证。旧阶段失败均保留，不把早期通过改写为最终证据。
- 重建后端后的依据读取和同键重放拒绝、owner/contact 两种隔离反例均有真实 HTTP/PG 证据；不新增普通日志正文、外部发送、隐式长期学习或自动采纳门禁。

本次只校准任务状态与证据索引，不修改生产或测试，数据处理无新增影响。原阶段记录中“待 provider／擦除修复”等是当时状态，后续实际修复和验证已经在同票记录；不删除这些历史。E04 的显式样本生命周期及保存／删除竞态已完成。更广 A/B 会话恢复、连续修改与 Skill 行为集成仍由 E06 继续，新的 A13/A18 来源引用契约尚待正式交付与消费，不把这些未运行组合预填通过。真实 App、原生、OCR、微信和新增外部模型实验按本轮范围跳过。
