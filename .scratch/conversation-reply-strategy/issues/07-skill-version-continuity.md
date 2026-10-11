# 07：Skill探索、确认与生成的版本延续

State: resolved
Triage: ready-for-agent
Blocked by: [conversation-reply-strategy/02 理解、纠正与方向确认闭环](02-understanding-and-direction.md)

拆分标识：R07（第三版映射；执行时以本文件为准）。

## 规格与范围

[正式规格](../spec.md)；旧03；Q16–Q22、ADR-043。 第二版标识为R06。 读取[工作流](../../../docs/agents/workflow.md)、[工程要求](../../../docs/agents/engineering.md)、[领域路由](../../../docs/agents/domain.md)、[领域语言](../../../CONTEXT.md)、[ADR-043](../../../architecture/adr/043-conversation-scenarios-and-direction-exploration.md)。依赖是完整交付的前置；实际实施结果与未执行项见本票 State 和 Answer。

## What to build

启用的有效场景Skill辅助理解和方向，显示实际版本并可关闭或更换；从探索、确认到候选生成沿用同一有效选择，无匹配或明确关闭时仍可走通通用流程。

## Acceptance criteria

- [x] 最多选用一个已启用、范围有效的不可变Skill版本，展示实际名称/版本；无匹配使用通用流程。
- [x] 从探索到方向确认再到生成沿用同一有效版本；明确关闭后生成不能退回自动选回，更换后旧策略结果失效。
- [x] 库revision变化、禁用或删除使旧目录与结果失效；提交与恢复都不得带回旧正文或两个版本的混合上下文。
- [x] 方向探索只加载受控静态内容，无业务Tool补查、外部查询或扩权；只用合成包，不创作具体邀约Skill。
- [x] 方向探索不接入表达样本；样本引用实现后的跨规格实际载荷验证由E06完成。
- [x] 新增路径按owner/contact隔离，保留来源及删除路径；敏感正文不进入普通日志，候选只能由用户亲自发送。
- [x] 记录实际命令、结果、数据影响及剩余风险；未执行的验收不得预填通过。

## 范围边界

至多一个版本，库revision/删除使旧结果失效；无业务Tool补查或扩权。只用合成包，不创作邀约Skill。

## 验证与交付

使用公开页面操作 → 后端HTTP → 隔离PostgreSQL，复用真实业务控制器与存储，只替换模型、消息到达和必要宿主事件为可控合成适配器。观察公开结果、持久化重读和模型调用次数，不绑定内部调用顺序。

按工作流以TDD垂直推进，完成相关验证、Standards/Spec两轴评审与本地提交后，在本票补充Answer并据实更新状态。合成响应只证明数据和控制契约，不证明真实模型语义质量。真实App只能由主Agent在另行约定的有限窗口通过项目入口验证；页面结果不能代替原生证据。

本票不授权OCR、真实微信读取/发送、外部模型调用、部署或push；也不提前实现其他票。

## Comments

2026-10-11 公开后端接续：真实合成Skill包经静态read_file Tool加载，探索固定一个不可变版本并在确认后的原生成链使用同版本；明确disabled两段均NoSkill、不能auto回退。目录变更拒绝旧读取/选择，用户明确关闭并刷新时保留原已选意愿。新增模型前与实际保存边界revision竞态反例均先RED后GREEN，拒绝时候选0。探索未装配表达样本port；E06组合载荷与A12正式总预算仍待接，页面版本展示/更换亦未执行，票保持claimed。

2026-10-11：用户认可30票复审修订后发布；表达样本独立保留规则已单独确认。尚未开始实现或执行产品验收。

2026-10-11 既有B接续：静态选择模块按既有SkillPort读取最多一个版本，以validate_skill_version核对启用、owner/contact和不可变目录身份；明确关闭/无匹配都返回NoSkill，旧指定版本不回退。跨范围目录和正文两次red→green、6项受控模块验证通过。完整探索→确认→生成及库revision失效路径待A051/B052实际接线与公开页面；未标验收通过。

2026-10-11 基础切片补充：auto仅在服务端已核验主要沟通场景时精确匹配applicable_scenes，入口类型和描述文字不能代替任务识别；未知任务使用NoSkill。显式user固定实际版本，非user禁止携带版本。相关20项模块测试通过，两轴限定复审0问题；尚未完成探索→确认→生成或库revision的真实公开闭环，保留原验收项。

2026-10-11 持久UUID前端核心切片：公开页面关闭Skill后完成两场探索及确认，再次普通生成HTTP均保持skill_disabled=true；请求快照固定实际版本或NoSkill，UI自动／指定／关闭偏好分别保存。普通生成丢关闭选择P2已公开RED→GREEN。实际版本选择／更换／revision页面与A12探索总预算仍待接，保持claimed。 真实命令、五场控制／隔离证据与数据影响见[R02本次页面记录](02-understanding-and-direction.md)；非真人或原生验收，原标准保持。
2026-10-11 探索完整请求预算：正式A12接口已消费为c6a9381，B只在原单次探索SDK适配器构造最终ModelRequest并调用同一require_request；包含system、完整输入与静态Skill、唯一输出工具schema、最终参数和供应商framing，实际输出预留绑定到调用。移除旧24000字符的假总预算。能力或绑定计量未知时不调用模型；错误公开409与共同纯元数据，不带正文。

TDD未知能力原行为仍调用模型，首1项真实RED；公共守卫接线后新5＋原9探索单元14通过。预算错误原被通用503遮蔽，两场HTTP先RED后改为共同metadata，最小1项两场通过。最终52相关HTTP/正式001–053随机PG通过（49.670s，owned database remaining=0），含新3预算HTTP、21持久探索、原原子/存储及C五个样本/Skill组合；273完整回复单元通过（1.766s）。新测试逐项比较完整计量请求与实际调用参数，覆盖输出预留、温和提醒、每次变输入重查、不同模型counter、参数绕过、完整静态Skill超限前0调用。

Context7在本环境未提供，转查官方ModelRequest文档并核对实际Conda版本（LangChain1.3.15/core1.5.5/openai1.5.1/deepseek1.1.0）。两轴静态Spec0/Standards hard0；1条未知profile默认构造重复P3接受保留，B不擅改A公共预算工厂，两个适配器默认均拒绝且受反例覆盖。上述只证明显式合成协议，不当真实供应商计量、自然语言质量或A12整票完成。公开页面接共同guard复验、实际Skill更换/revision仍继续，票保持claimed。
共同guard公开回归实际完成：Conda NotAlone中 `npm run test:pages -- --case reply-strategy-dialogue --case conversation-strategy-entry --timeout-seconds 240` 全部通过，前者回应与主动21完整来源闭环、后者明确主动目的／原入口切换／待确认依据及持久重读均到达。quiet26/active0/onscreen0、单Chrome、cleanupConfirmed=true、Electron/native=false；本轮测试处理合成资料，真实供应商模型及人工验收未执行。完整Skill版本选择／更换／revision公开用例继续接续，预算这批结果不替代那些验收项。


2026-10-11 总协调实际复验正式47完整探索预算：273回复单元GREEN（1.792s）、30实际HTTP／001–053隔离PG GREEN（37.655s）／自有库0，type通过。新旧普通／探索转换与明确主动入口两labels180公开exit0，实际NoSkill延续与同键0调用；quiet26／cleanuptrue，无原生App或外部模型。预算装配保留A共同守卫、C生成接口，unknown仍失败关闭。限定两轴0；完整实际Skill版本更换和历史／连续生命周期仍未以本切片通过。



## Answer（实际版本展示与公开延续切片）

2026-10-11：候选结果保留后端实际 `used_skill` 的名称、不可变版本UUID与加载状态；探索确认和普通生成都投影同一只读摘要。候选组展示实际版本，编号只取同一实际UUID的已验证目录项，缺号则显示版本UUID；明确null展示通用流程，缺字段不冒充通用，部分资源读取失败如实标记。下拉框偏好不能替代实际生成元数据。未改原生成链、A当前输入/历史权威、C样本来源或数据库协议。

TDD实际92039：回应首场原HTTP/turn已证明A v1实际加载且模型4次，但候选组缺版本展示，取得真实产品RED；R06两场先通过，联合命令最终exit1。上述最小展示与投影修复后，69000首复跑遇到明确关闭后立即读取上一探索响应的TEST异步缺口，未记新的产品RED或整场GREEN；仅补新HTTP响应计数/200与公开通用状态等待，确认问题也先等公开已确认状态，原版本/NoSkill/调用数断言全保留。

最终在Conda NotAlone中实际执行 `npm run test:pages -- --case reply-strategy-skills --case reply-strategy-skill-invalidation --timeout-seconds 240`（29695），exit0，两case共六条路径全部完成：

- 回应与主动各沿真实Skill Library准备的合成A v1静态探索、明确确认后原read_file实际A、普通生成仍A，明确关闭后确认与普通生成均NoSkill，改选B v2后拒旧未确认task并只加载B；每场13次实际受控调用。候选组展示、HTTP原字段、Tool实际读取和同会话200持久重读均核验。目录不含另一个contact/owner版本，全System/Human/Tool请求也不含两种越界正文。
- 回应与主动分别执行实际Skill disable和delete，共四场：库操作200、旧读取与旧问题回答409且模型0追加、无候选；用户明确关闭并刷新后保留此前已确认意愿，通用生成，每场4次实际调用。关闭/更换/失效后的整个System/Human/Tool调用均不混入旧Skill正文。探索静态加载阶段没有read_file Tool结果，仍沿原单次结构化探索适配器。

总实际调用26＋16=42；资源quiet105、active0、onscreen0、单Chrome、cleanupConfirmed=true，Electron/native=false，自有隔离夹具已确认收尾。类型、Python夹具编译、diff检查与页面调度CLI10项通过（3095.711667ms、skip0）；限定两轴最终审查Spec0/Standards hard0/Fowler possible0，Human-only观察P2已关闭；本地SHA随正式交付记录补齐。先前共同总预算与C五个样本/Skill真实HTTP验证仍有效，不拿本次公开六场代替A12整票。

数据影响：只增加实际生成摘要在端侧的投影/显示及合成测试包/只读观察；无新增真实聊天读取、外部模型、持久正文副本、长期偏好或发送能力。R02原六场UUID公开回归、恢复/连续修改与R11整体组合最后对照继续，State保持claimed、原标准不改不预勾；真实语义、原生与人工验收按本轮授权跳过，不说成人工通过。

总协调主树正式消费 `c428b25fb977e9eddd15513155b20ad6d7a3afa4`，公共类型保原 A／C 字段，夹具保真实 MemoryService 与既有来源准备，只补实际 Skill／ledger／task 服务、新合成包及完整调用观察；门禁保全部原名单。Conda `NotAlone`、关闭 dotenv／追踪、`PGHOST=/tmp PGPORT=5432 npm run test:pages -- --case reply-strategy-skills --case reply-strategy-skill-invalidation --timeout-seconds 240`：实际 exit0，两场版本延续／关闭／更换和四场禁用／删除六路径全部到达；每场原 13／4 调用断言保留，合计 42 次实际调用。quiet58、active0、onscreen0、单 Chrome、cleanupConfirmed=true，Electron/native=false，隔离夹具收尾确认。

主树类型、Python 夹具编译和差异检查通过；窗口正常收尾后 `node --test tests/headless/command.test.mjs` 10 项 GREEN／2866.330875ms、skip0，原单租约／nonce／期限限制保持。最终限定 Standards 硬要求 0／重要气味 0、Spec 0。该切片主树集成完成，未完成的整票对照及人工部分依上文保留。


## Answer（最终自动范围核对）

2026-10-11：R02原六场UUID及场景入口已正式 `46e6af7393cd18dea9a0907007af65277d8b6c38` 完成，本票原前置满足；按本票七项原标准核对可自主范围resolved。正式源码 `c428b25fb977e9eddd15513155b20ad6d7a3afa4` 与本B29695两label240的六条公开完整路径／42实际调用是本票直接验收：两场各13次固定A v1→明确确认→普通生成→关闭NoSkill→B v2替换，四场各4次disable／delete旧读取及问题409→用户明确关闭刷新仍保原意愿→通用生成。实际版本展示取真实used_skill，任一phase至多一个有效版本，实际所有System／Human／Tool调用不含越界或失效Skill静态正文，确认／普通生成不会在disabled后偷偷回退自动。

静态探索只经真实Skill Library及受控单次适配器加载，固定一个已启用且范围有效的合成不可变版本，没有业务Tool补查或表达样本port；生成沿原read_file及原生成器，版本UUID／名称和库revision守卫、models前／save竞态、source删除及恢复均沿已正式真实HTTP/PG证明。C五个Skill／样本组合HTTP和共同预算52项／完整回复273项已实际在47fbcc4执行，仅引用原记录，不用原型或别人的运行填本B。样本引用后的跨规格整体组合仍由E06／R11接续；本票明确不装探索样本，并不借其完成替代最终组合。

29695原exit0、quiet105、cleanuptrue、单Chrome／active0／onscreen0与type／Python夹具编译／CLI10等真实证据及92039产品RED、69000 TEST异步缺口完整保留在上方Answer。root601另外六场42calls／quiet58为其独立复验，不冒作本B运行。既有预算未知profile重复P3仍已接受，本票最终文档两轴审查Spec 0、Standards hard 0／新增重要Fowler possible 0，diff核验通过，只更新状态与原勾选；不重复启动已通过且源码未改的六条路径，没有新增业务或模型调用。

原七项标准文字保持；R08消息组、R09活跃任务有界更新、R10连续修改／完整历史及R11实际跨模块组合继续按正式接口推进，不据此预闭。测试只合成包、不创作具体邀约Skill；真实模型语义、真实App／原生与人工验收按本轮授权跳过，无OCR、真实聊天、额外外部模型、长期偏好写入、自动发送或push。
