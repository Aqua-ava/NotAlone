# 10：两种场景的连续修改与消息衔接

State: claimed
Triage: ready-for-agent
Blocked by: [conversation-reply-strategy/05 主动目的探索与确认](05-purpose-exploration.md)；[conversation-reply-strategy/06 两种场景的关键澄清与取舍](06-clarification-and-tradeoffs.md)；[conversation-reply-strategy/08 候选消息组逐条编辑与复制](08-message-group-edit-copy.md)；[assistant-session-context/13 连续要求、改口与明确编号指代](../../assistant-session-context/issues/13-continuous-intent-reference.md)；[assistant-session-context/15 新消息提醒与用户触发重新生成](../../assistant-session-context/issues/15-new-message-opt-in.md)

拆分标识：R10（第三版映射；执行时以本文件为准）。

## 规格与范围

[正式规格](../spec.md)；旧04；Q7、Q10、Q11、Q28、Q31。 第二版标识为R09。 读取[工作流](../../../docs/agents/workflow.md)、[工程要求](../../../docs/agents/engineering.md)、[领域路由](../../../docs/agents/domain.md)、[领域语言](../../../CONTEXT.md)、[ADR-043](../../../architecture/adr/043-conversation-scenarios-and-direction-exploration.md)。依赖是完整交付的前置，不代表这些前置已完成；本票尚未实现。

## What to build

回应与主动聊天都能修改目的、引用组内候选，并在新消息后由用户决定是否结合继续。

## Acceptance criteria

- [ ] 回应和主动路径均支持改口、明确引用组内候选及澄清后继续，目的、方向、候选组和输入版本一致。
- [ ] 新消息由用户决定是否结合，复用C06/C08的连续要求、快照和迟到失效规则，不新建另一套取消或存储。
- [ ] 旧建议、旧问题、旧候选版本不能应用到新输入；越权与来源删除清理新增讨论及派生结果。
- [ ] 不依赖未选方向自动更新R09；手动连续修改可独立验收。
- [ ] 新增路径按owner/contact隔离，保留来源及删除路径；敏感正文不进入普通日志，候选只能由用户亲自发送。
- [ ] 记录实际命令、结果、数据影响及剩余风险；未执行的验收不得预填通过。

## 范围边界

复用C系版本与失效规则，不再实现另一套；组、方向、改口及消息快照保持一致。

## 验证与交付

使用公开页面操作 → 后端HTTP → 隔离PostgreSQL，复用真实业务控制器与存储，只替换模型、消息到达和必要宿主事件为可控合成适配器。观察公开结果、持久化重读和模型调用次数，不绑定内部调用顺序。

按工作流以TDD垂直推进，完成相关验证、Standards/Spec两轴评审与本地提交后，在本票补充Answer并据实更新状态。合成响应只证明数据和控制契约，不证明真实模型语义质量。真实App只能由主Agent在另行约定的有限窗口通过项目入口验证；页面结果不能代替原生证据。

本票不授权OCR、真实微信读取/发送、外部模型调用、部署或push；也不提前实现其他票。

## Comments

2026-10-11：用户认可30票复审修订后发布；表达样本独立保留规则已单独确认。尚未开始实现或执行产品验收。

2026-10-11 明确重试的元数据接口前置：按总协调 01:22:50 裁定，在原探索 handler／唯一 PostgresExplorationStore 增加 `POST /api/contacts/{contact_id}/assistant-sessions/{session_id}/explorations/{exploration_id}/reconfirm`。严格输入为原 B `input_version_id`、实际旧生成 `expected_input_version_id`、全新 `request_key`，以及唯一的原已选 `suggestion_id` 或完全相同的 `direct_intent`。仅允许实际失败旧 turn、旧键已失效且尚无 C 已完成候选；复验同 owner/contact/session、原选择与来源、实际 CURRENT、原 Skill 版本／目录和根 TTL。沿原 A 同事务输入端口签发新 B 确认及选择 UUID，返回无正文的 reference／request key／input UUID／方向来源和实际 Skill 元数据；生成仍由原 `prepare/replies` 路径执行。同键重放读取原回执，不推进或回退当前输入；变体、旧键、其他选择／任务／范围、来源删除、TTL 或 Skill 变化均拒绝。旧任务、旧键和旧回执保持，根 TTL 与自动调用计数不续期，不降级成直接意愿。新确认在原 B 表增加派生行，沿既有字段保存原输入、证据和结果，继承来源依赖及根 TTL；不新增独立正文缓存、表、模型调用或生成链。

TDD 实际记录：首个两场景公开 HTTP 反例因接口尚无而返回 404，1 test／2 FAIL（2.280s），实现后原路径 GREEN（4.594s）。初次夹具误把既有空候选失败的真实 503 期望为 409，未走到新接口，不算此接口 RED。之后先前置 53 项 GREEN（99.752s），C 候选已保存但 A 投影失败的真实反例 1 FAIL（6.032s），加已有 C 状态守卫后原 1 GREEN（3.035s），相关 54 项 GREEN（98.146s）。最终规格复核又发现澄清会重建建议 UUID，服务器原明确选择仍保留旧 ID：两场景澄清→确认原方向→回答→生成失败→再次确认实际返回 500，1 test／2 FAIL（2.916s）。只从已复验的服务器原选择签发新 UUID 兜底后，同反例 GREEN（4.313s）；验证旧记录不变、原 TTL、方向来源与意愿不变、零隐式调用，并沿原生成入口保留澄清回答。

本 B 显式 Conda NotAlone、当前工作树 PYTHONPATH，执行自有随机库入口 `python /private/tmp/notalone-b-isolated-tests.py /Users/local-user/.codex/worktrees/conversation-reply-strategy/NotAlone tests.integration.server.test_exploration_reconfirmation tests.integration.server.test_persistent_reply_exploration tests.integration.server.test_exploration_generation_fields tests.integration.persistence.test_reply_exploration tests.integration.persistence.test_explored_generation`，正式 001–053 实际完整 55 项 GREEN（64.905s、skip0＝32 真实 HTTP／23 直接 PG，外层自有库剩余 0，HTTP 夹具各自清理）。四个改动 source 的 mypy、五文件 py_compile、原探索服务 17 unit（0.004s）和 diff 检查通过。新增 HTTP 覆盖重建宿主后的同键重放、直接意愿、跨范围／严格 JSON、当前输入、来源物理删除、TTL／目录、实际选定 Skill 同版及停用拒绝、已保存候选优先和上述澄清后选择延续。最终源码 Spec 新增 P0–P2 为 0、Standards hard 0／新增重要 Fowler possible 0，原接受 P3 保持；文档最终复核及本地 SHA 随交付补齐。

此处退出事件只以合成宿主的既有旧键失效凭证适配；未消费 A 工作中 054、未直接改 A turn／正文／当前指针，不据此宣称 A17 生命周期完成。真实 `interrupt→reconfirm→prepare/replies`、迟到结果、重装、级联删除与公开页面组合仍待 A 正式接口；本票 open 和原验收标准保持，R08–R11 自主集成继续。只处理合成消息及隔离数据库，无真实 App、OCR、私人聊天、额外外部模型、人工验收、外部聊天发送或远端写入。

2026-10-11 来源删除后生成领取测试的前置校准：总协调消费本 B 重确认及 C 传递删除后发现，原测试仍以已删探索的旧输入 UUID 作 expected，先触发 A 当前输入 CAS 冲突，尚未到达 B 来源守卫。本 B 在 e222 正式前置上独立复现最小一项 ERROR（1.294s、正式 001–053、自有库剩余 0）；这是测试前提过期，不冒充新的产品失败。只改原测试：先真实断言 CURRENT 为空、原 051 输入 redacted 且 content 为 NULL，再把 expected 更新为实际 None，保留原已删除 suggestion／reference，要求精确 AssistantSessionRejected.reason=exploration_stale，并保持零生成 turn 和探索派生正文擦除断言。业务源码、顺序与门禁没有改动。

同一最小测试实际 GREEN（2.185s、正式 53、skip0、自有库剩余 0）；继而在显式 Conda／本树 PYTHONPATH、自有随机库原入口联跑 test_exploration_reconfirmation、test_persistent_reply_exploration、test_exploration_generation_fields、test_reply_exploration、test_explored_generation，完整原 55 项 GREEN（66.374s、skip0＝32 真实 HTTP＋23 PG、正式 001–053、自有库剩余 0）。原最小 ERROR 和先前 55 项通过记录各自保留。原测试 py_compile 和 diff 检查通过；限定测试／最终记录 Spec 新增 P0–P3 为 0，Standards hard 0／新增重要 Fowler possible 0。本票仍 open、原验收项保留，不将该测试修复说成公开路径、A14 删除 reason 或 A17 真实中断通过。

2026-10-11 总协调精确消费B正式4b1及2bd夹具修正，在本树原五模块完整56项实际通过75.649秒／skip0（本树包含另一个已正式回归，与B自身55项分别计量）；正式001–053、迁移重复0及外层自有随机库剩余0。此前56=55通过／1ERROR72.906秒真实保留：旧fixture传已删expected版本，提前A CAS，未验证B guard；修后先核实际CURRENT None／051redacted与content NULL，再用expectedNone及原已删suggestion触发精确exploration_stale，零turn和派生正文清理均到达。业务守卫未宽化，四源类型检查、17unit、compile与diff及最终两轴无重要问题。仅完成明确重试后端元数据切片；真实A17中断、A13连续语义与公开组合仍继续，本票open及原标准不变。

2026-10-11 总协调仅消费 B 正式76ae56d 的 replace 路由四行 owner 类型收窄：其余 A 回执、替换、054、中断 source／tests 此前已root9232252正式，不重复导入。明确 replacement_owner 为 UUID 后委托唯一 service；不可用仍使用既有503 owner_uninitialized，不加cast／ignore或改变来源、输入、迟到、预算与鉴权门禁。主树 Conda NotAlone 下 `python -m mypy --follow-imports=silent src/notalone/server/app.py` 前78条、后77条，按去行号诊断集合严格比较只删除一条该新增replace可空owner错误，无新增诊断；77条既有通用入口诊断继续保留，未宣称全仓类型通过。app.py编译及diff检查通过；B本人修正后原十项真实HTTP G14.335属其交付证据，主树后续组合运行另记，不借作本次根本人新HTTP。R10 open及原标准保持，自动连续修改继续，无正文/schema/外部调用变化。

2026-10-11 上述 owner 窄守卫的主树动态相关复验已完成：净接 C 正式2a8的真实HTTP中断测试后，prepare17／HTTP interruption8／迁移3／C reconfirmation及replacement2／原replacement HTTP10共 **40G／42.834s／skip0**，原Conda隔离入口 `/private/tmp/notalone-coordinator-style-samples-no-dimension.py`、正式生产迁移001–054／repeat0／自有库剩余0；三迁移场景核实际账本、升级与回滚。C重确认含两scene，测试仅合成模型及StyleSampleHttpTest维度fixture为空，不改变生产门禁。原十替换HTTP已在这40中本人实际执行，不借B14.335s计量；明确HTTP中断不等于真实宿主停止模型。原状态open及桌面连续修改、leave/quit组合剩余保持。

正式B 9ad3e034准备接口后缀净接；以下28/7结果归B，主树独立复验另记。


2026-10-11 首次确认与已确认澄清的实际生成准备 producer：只修改本 B 原探索服务／适配器／公开路由及端口，新加真实 HTTP／隔离 PG 回归，沿 A 已正式唯一 AssistantSessionService.prepare 领取生成身份，不新建模型、registry、selector、正文表或第二生成链。新增 POST `…/explorations/{id}/prepare-confirm` 沿原 confirm 严格 body；`prepare-answer` 沿原 answer 严格 body与operation_key。只有服务器已有明确确认且意愿清楚时返回 `{kind:'prepared', exploration_id, generation}`；generation 严格五字段 `session_id,turn_id,request_key,input_version_id,state`，来自实际 A receipt，这里 input 是 A 领取的生成 G，不能当 B 讨论 Q。原 reconfirm／interrupt 六字段回执保持。

未确认的澄清回答仍是探索，确认后仍不清楚则继续澄清，暂缓不准备；不能从回答推断发送意图。准备确认的候选模型调用为0；准备回答只执行原探索判断，候选模型为0。后续执行仍用原 confirm／answer、原 body与operation_key及实际探索链；准备和执行共享原 canonical request 工厂，Skill 固定为实际版本或 NoSkill，关闭后不自动回退。实际完成重放走 A 原规范输入／来源复验、只返回已有 metadata，不回退后继 CURRENT。Main 消费此正式回执后登记／中断仍由 A 唯一宿主 authority 接线，本切片没有声称关闭或退出已集成。

本 B TDD 历史保留：首次两场 prepare-confirm 同一个 HTTP 测试真实404 RED（1.253s）→薄 A.prepare 接线后1项GREEN（2.645s）；中间夹具误读 saved turn 不存在的 request_key、session_id，以及删除真实202queued误期200，均保原失败日志并按实际 schema 校准，不放宽身份／CURRENT／模型断言，不声称删除 job 完成或物理擦除。模块5项曾GREEN11.025s；原5＋21策略＋2真实 Skill／表达参考组合28项GREEN39.068s属于 UUID 工厂守卫之前；加实际 UUID 守卫与显式内容 union 后，原5＋2实际再次7项GREEN14.332s，阶段证据分别保留，不互相覆盖。

按总协调确认的五字段共享合同，先收紧新回执 exact keys：同原测试两场真实 RED（1.261s、2个subtest失败多 interruption_reason、自有库剩余0）。只改新准备回执的薄序列化后，沿生产 CLI 安装正式迁移前缀，在自有随机 runner 实际联跑 `test_exploration_generation_preparation`、`test_persistent_reply_exploration`、`test_authentic_expression_reconfirmation`、`test_authentic_expression_replacement`，session48515 actualexit0，共28项GREEN（42.015s、skip0、自有数据库剩余0）。新5项含两场真实准备→原执行→重放、未确认／已确认仍不清／已确认清楚的六个回答组合、中断旧身份及来源删除拒绝、后继 CURRENT 后完成 metadata 不回退、owner／SID／额外字段／GET守卫。失效租约下旧响应被拒的既有合成异常日志保留；不用这些绿色掩盖公开路径尚未运行。

外层 runner 只运行正式生产迁移 CLI，不借 A／C／ROOT 的 ledger或repeat 证据。最终四个生产源的默认 mypy actualexit0（不是 silent imports），五个 Python 文件 compileall 与 diff检查通过；原七源通用 app.py 的77条基线不据此说成全仓通过。这里只用合成消息、可控模型和隔离 PG，原正文仍沿既有 A／B 输入与 C 结果持久保存和来源／TTL，不把无正文 HTTP receipt 说成全库无正文。R10保持open、原验收不勾；A13／15的明确组内引用、完整连续修改及新消息选择、A16／17宿主关闭退出和实际公开页面组合继续沿正式依赖，无人工／真实App／OCR／真实聊天／额外外部模型／原生验收／自动发送／push。

限定 ONLY6 原审查 Spec 新增 P0–P3为0、Standards hard0／新增重要 Fowler possible0；规范审查的非阻断建议已采纳：端口对唯一 A Receipt 的纯返回注解改为既有 TYPE_CHECKING 导入，避免在运行时经 lifecycle 加载 reply_service，不移动 A DTO 或新建身份权威。其后默认四源 mypy／五文件 compileall／diff 再次通过；新准备5＋真实 Skill／样本2 的最小 HTTP／隔离 PG 回归实际7项GREEN（17.229s、skip0、session75417 actualexit0、自有库剩余0）。前述28项是五字段功能收口后的完整相关范围，此7项是最后仅类型导入调整后的复验，分别保留。

2026-10-11 总协调主树精确净接正式 `9ad3e034` 四个生产文件、新准备 HTTP suite 与本票证据后缀，未复制工作树或宿主 registry。实际认证 HTTP→隔离 PostgreSQL 联跑新准备5、主树正式原策略22、真实 Skill2，共 **29 GREEN／39.825s／skip0／actualexit0**；B原28／42.015是其自己的正式树结果，不能用它替代本主树29。正式001–054迁移账本核验及repeat0，自有随机测试库剩余0；准备候选零调用、原同键确认／回答一次生成、completed后继CURRENT不回退、来源/范围/旧中断及原Skill版本守卫保持。

主树四源限定 `mypy --follow-imports=silent` 实际通过，五文件 compile及diff通过。仅自动后端准备接口，不冒宿主 job登記、连续改口／引用／新消息完整公开页面完成；原State open与未勾标准保持。没有新增正文副本、第二生成链、DDL、外部调用或真实App。

固定主树本主题六路径最终Standards硬要求0／重要Fowler possible0、Spec新增P0–P3为0；四生产与新测试等B正式9ad，审查仅只读未运行测试。仅此准备接口主题本地提交，宿主与完整R10公开组合仍继续。

## Answer（本轮正式持续修改的公开客户端阶段）

本 B 在独立树 `/private/tmp/notalone-round29-b` 消费唯一 A `0ec5a1ae`、`dca102c8` 提供者及 `e94dfa2e` soleJobs 为本地 `7abec150`、`5484285a`、`56cc7458`，各自仅净接口／测试，不复制 A 的任务卡。所有实际生成仍由原同 owner/contact/SID HTTP／PG权威写入；不造第二CURRENT、存储、来源图、生成作业表或模型。Main 从实际已读 CURRENT 与公开候选区实际组／编号／displayVersionId冻结指代，不从复制、默认高亮或生成先后猜选择。回应与主动UI场景保持原明确意愿，编号继续的实际后端draft输入只展示在本次快照，并继续使用完整消息组版本编辑器。

公开具名方法 `continueSession`、`confirmContinuation`、`retryContinuation` 经严格有限参数、helper角色及当前范围门禁。澄清确认复验原SID／CURRENT／实际展示frame，保留原instruction与键，只允许本次服务器选项的明确动作；新要求不当旧previous。断连重试继续同键同正文，不产生新模型；输入、版本展示、离开、连接或来源变化清除当前操作资格。正式零领取typed澄清沿唯一作业明确收口；传输失败与普通409尚无权威无领取事实时继续failclosed，不以缺receipt猜不存在旧slot。

五个公开Main/preload→真实HTTP→正式001–055隔离PG垂直回路依次实测：回应第二组实际编辑版首次缺方法 **RED1／3051.357959ms→GREEN1／4349.835625ms**；主动冲突澄清缺确认方法 **RED1／2844.9115ms→GREEN1／3601.00375ms**；实际完成但交付响应丢失缺可重试状态 **RED1／3306.21ms→GREEN1／3669.296959ms**；生产候选renderer缺继续／改口控件 **RED1／2948.44625ms→GREEN1／3165.870459ms**；真实来源删除后旧展示仍残留 **RED1／4794.2445ms→GREEN1／4322.732542ms**。首次直接TS／stdin fixture误入口和中途文本校验作用域错误各保，不冒业务RED或通过；此阶段没有Chrome或真实App。

最终原文件完整 **5 GREEN／14913.144458ms／skip0／actualexit0**，实际模型调用2＋2＋2＋1＋1共8；每场正式55逐名账本、repeat0、instance/class清理与自有库剩余0。澄清期间原CURRENT与turn数不变、0新增模型；实际丢响应后四次prepare/execute正文全部相同、只保原两turn；source删除后重读redacted无input/reply、CURRENT空，公开状态无旧候选正文。22项候选版本／删除门禁Node **GREEN／175.261375ms**，完整desktop类型及diff检查通过。命令：Conda NotAlone、`PGPORT=55441 node --test tests/reply-continuation-public-http.test.mjs`；日志 `/private/tmp/notalone-b10-public-five-final.log` 与各原RED/G日志；模型边界受控、dotenv及外部追踪隔离。

UI提供“继续修改要求”“本次改口”“继续修改”，要求澄清各项不预选，用户明确选择保留／替换／移除／新增后“确认本次要求”；失败可“重试本次连续修改”。未保存的组内编辑在现有版本组件内保留，仅向当前候选区报告dirty元数据以暂停连续提交，不复制编辑正文或改变 C 保存权威。

本阶段原六条AC与`State: claimed`保留。普通Page两场尚待具名窗口执行，A15明确采用授权新消息与生成中替换仍由本B接续；当前五项不能替代它们。原生／人工／真实模型质量未执行，不能据合成输出宣称语义质量。仅合成数据、受控模型、隔离数据库；OCR、微信、私人资料、额外用户会话、付费／外部模型、外部发送、push、发布、部署均未做。

固定ONLY10 source `/private/tmp/notalone-b10-consumer-source.patch` SHA256 `7bde98b8a5c9314573e42671f971225d959ecc0dd5cb150cd66a30105a91a497` 已由 A 独立Standards只读审查：硬要求0／新增重要Fowler possible0；C独立Spec新增P0–P3为0。两轴未借本人5HTTP／22Node作为自测，明确A15／Page／Host与provider确定无领取后续仍partial。正式消费来源动态复验与失败终态为本树`18551290`（只净接口／测试、不复制A17票），新增四条HTTP本人实际GREEN4.741s／55repeat0／自有库剩余0，三源限定mypy和五文件compile通过；默认导入链54条诊断未掩盖为全仓类型通过。最后完整desktop类型与diff通过，source10未改变。

Root 净接正式 `54d4b07e` 的十个source/test路径后独立运行 `node --test tests/reply-continuation-public-http.test.mjs`：**5 GREEN／18847.531375ms／skip0**，实际模型8，五份55迁移／repeat0／内外自有库残留0；完整TypeScript及diff通过。此为主树新Main/preload→HTTP→PG验证，不借B原五次计量，不替代普通Page、A15消息采用或增强A17未知准备生命周期。原六AC未改，State claimed，故障终态及回执阶段正证明另随正式切片集成。

### 连续输入的 Unicode 码点边界

根核对发现本票三个 textarea 原生maxLength=4096按UTF-16计数，会截断4096个合法emoji；只在既有连续修改组件移除该原生限制，所有输入完整保留，按码点计数禁用超限提交与替换确认，不改变Main／JSON codec／后端4096字符约束。本人实际公开renderer＋真实Main/preload→HTTP/PG反例 **1 RED／4347.412542ms→GREEN／3539.104625ms**，日志 `/private/tmp/notalone-b-codepoint-public-red.log`、`/private/tmp/notalone-b-codepoint-public-green.log`。RED是SSR反例，不冒充Chrome原生输入；GREEN后4096个😀要求与4096个🙂改口在实际canonical prepare正文原样交付，后端要求澄清而零新增候选模型、原CURRENT／一turn不动；4097码点严格bridge拒绝且0新增HTTP。两次各55／repeat0／自有库0，模型各1。

完整桌面类型与静态两个标准Page entry bundle通过。真实DOM的4096／4097要求、改口与替换内容边界已放入原拟 `reply-strategy-continuation` 两scene，尚未运行；待唯一 A 当前意愿修复正式消费及两轴审查、干净HEAD和总协调具名窗口后再执行，不用此SSR或HTTP代替DOM证据。原AC与claimed保留，无真实App／原生、外部调用或私人数据。

固定ONLY2 `/private/tmp/notalone-b-continuation-codepoints-only2.patch` SHA256 `ddef0a1add6c71f5f917b77651d5675459618223891ec028b8c86a66871b697d` 已独立两轴完成：A Standards硬要求0／新增重要Fowler possible0，C Spec新增P0–P3为0；只读审查不借上述计量，不把待执行的三字段DOM边界预填通过。此主题单独本地提交，provider当前意图与全组合继续。

主树净接 B `bae794bb` 的两条 Unicode 边界路径并独立验证：公开 Main/preload→HTTP→随机隔离 PG **1 GREEN／4097.980959ms**，4096 码点完整交付、4097 拒绝、模型1、001–055 repeat0与自有库0；类型通过。日志 `/private/tmp/notalone-root-carry-followup-continuation-http.log` 的这一独立用例，不借其它八项为本主题通过。B 后续具名两场 Chrome 页面已实际验证三个字段 4096／4097，源 `a287c454`、actualexit0、quiet29／active0／单Chrome／cleanuptrue／nativefalse；主树独立1489源码哈希一致、精确三PID消失、两库查询0与fresh租约absent后FULLRELEASE。原票状态与其它未验要求保持真实，两个范围的计量不混作一场。
