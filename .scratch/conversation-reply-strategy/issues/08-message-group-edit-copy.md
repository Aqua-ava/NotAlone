# 08：候选消息组逐条编辑与复制

State: claimed
Triage: ready-for-agent
Blocked by: [conversation-reply-strategy/04 明确目的的主动联系入口](04-proactive-purpose-entry.md)；[assistant-session-context/11 候选编辑、选择与版本回看](../../assistant-session-context/issues/11-candidate-edit-history.md)

拆分标识：R08（第三版映射；执行时以本文件为准）。

## 规格与范围

[正式规格](../spec.md)；旧04；Q24及C05版本契约。 第二版标识为R07。 读取[工作流](../../../docs/agents/workflow.md)、[工程要求](../../../docs/agents/engineering.md)、[领域路由](../../../docs/agents/domain.md)、[领域语言](../../../CONTEXT.md)、[ADR-043](../../../architecture/adr/043-conversation-scenarios-and-direction-exploration.md)。依赖是完整交付的前置，不代表这些前置已完成；本票尚未实现。

## What to build

回应或主动候选以备选方案及组内有序消息展示，逐条编辑复制并保存版本。

## Acceptance criteria

- [ ] 回应和主动候选都区分备选方案与组内有序消息，每条可编辑和复制，并保存所属方案、版本及修改关系。
- [ ] 不把组内消息当互斥候选；逐条事实与整组承诺受本次意图和来源约束，复制不记作发送。
- [ ] 复用C05稳定候选/版本身份和明确选择，来源删除覆盖派生组与恢复副本，不另造会话存储。
- [ ] 新消息不覆盖组内编辑；系统剪贴板原生能力沿用现有验证边界，不据页面测试声称原生通过。
- [ ] 新增路径按owner/contact隔离，保留来源及删除路径；敏感正文不进入普通日志，候选只能由用户亲自发送。
- [ ] 记录实际命令、结果、数据影响及剩余风险；未执行的验收不得预填通过。

## 范围边界

不把组内消息当互斥方向，整组事实/承诺一致；来源删除覆盖派生组，不自动发送或把复制标成已发送。

## 验证与交付

使用公开页面操作 → 后端HTTP → 隔离PostgreSQL，复用真实业务控制器与存储，只替换模型、消息到达和必要宿主事件为可控合成适配器。观察公开结果、持久化重读和模型调用次数，不绑定内部调用顺序。

按工作流以TDD垂直推进，完成相关验证、Standards/Spec两轴评审与本地提交后，在本票补充Answer并据实更新状态。合成响应只证明数据和控制契约，不证明真实模型语义质量。真实App只能由主Agent在另行约定的有限窗口通过项目入口验证；页面结果不能代替原生证据。

本票不授权OCR、真实微信读取/发送、外部模型调用、部署或push；也不提前实现其他票。

## Comments

2026-10-11：用户认可30票复审修订后发布；表达样本独立保留规则已单独确认。尚未开始实现或执行产品验收。

2026-10-11 既有B接续：先复用冻结B交付的原候选message_group DTO、严格聚合校验、稳定逐条ID与HTTP/PG重读。2项真实HTTP/隔离PG由red→green、数据库remaining=0；193回复单元通过。052实际SQL先放backend/database/pending，等待正式A051前缀后通过生产迁移器安装，不造占位。完整编辑/复制/恢复需A053并待公开页面，原验收项未预填。

2026-10-11 正式前缀接续：A051已正式消费，052移到生产迁移目录。实际001–052首次/重复通过；真实旧051库的一条原单句升级后首消息保持candidate UUID，重复迁移不改身份。原回应/主动消息组2项真实HTTP/PG与新探索存储、A来源依赖联跑34项green、owned_database_remaining=0；不再使用辅助052。A053整组编辑及公开复制/恢复仍未接入，本票继续claimed，验收项不勾选。

正式B a23527fe消息组界面后缀净接；以下四完整Page等结果归B，根真实组合另记。


2026-10-11 消息组界面与逐消息复制切片准备：回应和主动沿正式 A11四RPC显示本组有序消息、局部编辑及修改要求；完整保存创建新版本，查看旧版本与明确选择分开。复制只交联系人／scope／实际request／candidate／version／message身份，Main从同SID、history.turnId和实际completed turn读取这条文字；默认展示、旧高亮、未保存修改不能替代版本选择。旧五字段入口只供既有草稿改写，回应／主动不能绕过版本选择复制整组；顶部整组复制在这两种场景禁用。最终发送始终由用户完成，没有发送接口。

既有普通generate和B generated发布savedSession idle／turns=[]，A版本restore只读版本及selection。本B界面针对每个新回应／主动结果且SID一致时，仅一次调用既有公开readSavedSession，实际认证HTTP GET取得完成turn；不伪造completedSavedTurn投影、调用模型或替用户选择。版本保存加载／普通故障期间组件保留本版本局部编辑稿，恢复同版本不覆盖；真实来源失效使A投影去掉候选时卸载并清稿，不存第二份完整历史或可恢复正文缓存。改动文字与保存／选择操作键分别绑定，重试未改的保存使用原键。

本B新增两scene旧五字段绕过选择的Node反例，原实现实际exit1，两条均Missing expected rejection；最小guard后实际24项GREEN（73.99475ms、skip0）。新Renderer初次类型编译缺useRef导入／optional收窄两错误原记，修后全desktop `tsc --noEmit`实际exit0；最终新四场页面case类型编译也exit0。先前已记录的公开旧DOM反例保持，尚不称新UI页面通过。公开case已准备回应／主动完整组编辑、普通保存HTTP故障保稿、明确版本选择、逐消息复制、重建真实HTTP／PG版本恢复，并加两scene真实SSE burst与显式消息刷新保留组编辑／CURRENT／模型计数；原五秒／HTTP预算、单实例与清理不放宽。

这是后续受限公开验证的准备切片。R08仍claimed，原验收项不勾；新四场公开页面、来源删除／跨范围与C新版本来历组合仍要实际执行，A长history1MiB P2仍sole分页／有界回执未关闭。这里只处理合成夹具与端侧局部编辑状态，不改变独立样本保留、长期偏好、来源存储或后台授权；真实系统剪贴板、人工／App／自然模型语义质量未验，无OCR／真实聊天／额外外部模型／外部发送或远端写入。

补充源码审查与修正：规格审查发现“选择后 GET 失败再选其他版本复用旧键”和“旧 SID 已删除标记阻断新 SID 复制”两项 P2。选择键现与具体版本绑定，相同版本重试保留同键，切换版本创建新键；公开用例加入真实选择提交后的一次 GET 503、完整重读、改选旧版与新版本接续，尚未执行，不预称通过。复制守卫只阻断删除中／失败以及确切已删除 SID；新 SID 仍按真实完成轮、版本与明确选择核验。后项新增两条 deleted／missing 正向与同 SID 反向测试真实 RED（92.47425ms），修正后 26 Node GREEN（271.980834ms，skip0）；全 desktop tsc 再次实际 exit0。原 24 Node 与首轮类型检查是前一阶段证据，未合并冒报本轮 116。

首轮公开页面：原 `node scripts/test-pages.mjs --case reply-strategy-message-groups --timeout-seconds 240`，session11097 实际 exit1，在第一回应场景预设选择 GET503 处，`locator.check` 误要求控件立即 checked；四业务场景均未完整通过，另三未运行。该控件以真实异步选择结果设置 checked，失败保持未确认；夹具改真实 click 后分别等待错误与 disabled／not checked 或成功 checked，不放宽五秒断言或 HTTP／总时段预算。原 quiet8／active0／onscreen0／maxApps1／policies[2]／singleChrome／cleanuptrue／Electron/nativefalse，独立 freshstatus ef99bf exit0 absent 后释放全部源与 OS 窗；失败原日志保留。改后全 desktop tsc70fadc 实际 exit0；等待同具名排期复验，尚未称 Page GREEN。

第二轮原同 label／single240：session86756 实际 exit1，首场错误等待了 fieldset 内的选择失败 alert，该 alert 由 CandidateVersionEditor 渲染在 fieldset 之后，故五秒无元素。改为页面上精确该错误文字，保留未选择／复制禁用／实际已提交选择与后续改选全断言、原预算，无生产改动。本次四场均未完整通过，另三未 run；quiet15／active0／onscreen0／maxApps1／policies[2]／singleChrome／cleanuptrue／Electron/nativefalse，独立 freshstatus 实际 exit0 absent 后已释放源与 OS 窗。原两失败日志保留，尚待原入口复验。


第三轮原同 label／single240：session45368 实际 exit1，首场已走过实际保存故障／重读、选择提交后 GET503、旧版与新版明确选择，在第一条 copy 的五秒成功状态断言处未确认，先出现“正在复制”后状态元素消失。本次仍0业务场景完整通过、其余3未run，原 quiet18／active0／onscreen0／maxApps1／policies[2]／singleChrome／cleanuptrue／Electron/nativefalse，独立 freshstatus18fc40 actualexit0 absent后实际释放。保留未知原因阶段原日志，不凭当时观察擅自归因，不改预算或吞掉来源失败。

后续已接 C／ROOT 的唯一正式编辑版本来源适配，本 B 正式 `c34a3582ab1a5f5afff2821f8f6c24f64ea80f51`：controller与新12测试逐字等于 ROOT80b，没有 B 第二selector。先新10测试在旧controller真实7F3G RED“复制来历已失效”，原C适配后113项、ROOT多候选守卫后115项实际GREEN／全TSC0／最终两轴0。这证明受控复制来源边界已修，并未证明第三轮 Page 问题已闭合，仍须原四场正向复验。新来源终态／明确invalid／永久摘要拒绝保持，普通读取失败与loading只有原严格可信历史允许以后重试。A4e有界版本正式传输已到而本树尚未消费，长history缺口不借这些Node或正常四场关闭。


第四轮原同 label／single240：session54765 actualexit1，前三条实际完整通过＝回应整组编辑／故障／明确选择／逐条复制／同 PG重建恢复，主动同完整路径，以及回应真实 SSE与显式刷新保稿。第四主动已收到真实新消息并保稿，但夹具误点仅回应／草稿输入提供的“刷新消息”按钮，原30秒 click timeout；本轮3complete＋1failed不称全4GREEN或CLI0。原quiet75／active0／onscreen0／maxApps1／policies[2]／singleChrome／cleanuptrue／Electron/nativefalse；独立freshstatus306338 actual0 absent后实际释放，414运行源码在整窗逐字未变。前两条已实际验证正式 C来源适配可复制保存新版本及重建后的实际版本；前三轮失败原日志保持，不用受控 Node代替此次 public结果。

只校准主动事件夹具为现有公开路径：主动没有待回复消息列表，明确核无该目标刷新控件和列表，再真实断开 SSE、间隙追加合成消息、用户点击“重连消息提醒”，等待恢复／可能遗漏提示。回应仍保完整公开“刷新消息”及实际新消息radio断言；两场都保消息与要求编辑稿、CURRENT不变和候选模型仅一次。没有新生产按钮、伪造消息目标、绕过公开页面、扩大时限或取消断言；最后主动路径的真实结果仍待下一原四场运行。


第五轮原同 label／single240 的公开页面最终结果：session7344 actualexit0，四条完整场景GREEN，日志 `/private/tmp/notalone-b-r08-groups-page-5.log`。回应与主动各用两方案×两条真实候选消息，观察默认未选／复制禁用、整组编辑／要求／保存503保稿及真实重读重试、新版本parent与稳定消息UUID／顺序、他组未变；选择已提交后GET503仍未确认、重读与改选旧／新版、逐条Main copy的实际合成接收文本；同PG真实重启后端与重建Main／页面，从实际HTTP GET恢复版本／要求，默认展示仍不代替明确选择。各场候选模型仅一次，编辑／选择／复制／重读没有新模型调用或隐藏窗口。

另外两条实际SSE场景分别走回应公开刷新和主动公开断流／间隙新消息／用户重连，消息与要求编辑稿都保留，CURRENT未改变，候选模型计数仍1。该主动路径按真正既有页面校准，没有伪造回复目标或新加产品刷新按钮。原5秒／23秒25秒HTTP／总240秒／单实例／采样与资源门槛全部保留；quiet33／active0／onscreen0／maxApps1／policies[2]／singleChrome／cleanupConfirmedtrue，ElectronRunfalse／nativeAcceptancefalse。582运行源及fixtures整窗逐字未变；actualexit后独立freshstatusc67da6 actualexit0 absent才释放全部运行源与OS窗。四条前失败与第四的3complete＋1fixturefail分别保留，不能拿之前115Node或第四局部通过当本次四场结果。

本次只证明真实公开页面→认证HTTP→隔离PG的上述组编辑／复制／版本恢复与新消息保稿控制路径，系统剪贴板接收边界仍合成，不能宣称原生、人工或真实模型语义质量通过。A4e有界版本正式接口已到、尚未在本B消费，长历史1MiB缺口仍待接续；来源删除后的整组与恢复编辑副本、完整连续修改／组内指代及关闭退出仍由A/C正式接口和R09／R10／R11跨模块公开组合继续验证。R08保持claimed、原验收项未预勾，不将正常四场关闭这些剩余项；无OCR／真实聊天／App／额外外部模型／自动发送或远端写入。

主树净接正式B `a23527fe` 后，原38项相关Node GREEN／123.149625ms及完整桌面类型通过；两处原页面清单仅加入B label，保全部主树C labels与原门禁，未引入B共享catalog重构。合成保存503代理只取URL.pathname匹配正式A4e `?receipt=1`，生产不改，所有原故障断言保留。主树尚未执行原四正常场景，不借B第五四G关闭本票。

新鲜Spec另发现交叉P2：恢复后的组消息没有current result因而不通知Main，仅修改组要求也一直只留在React；同SID用户已明确开启未确认探索后，未保存编辑不能停止随后SSE自动推进。新增两个生产公开页面反例真实65888单180 actualexit1，两场各模型载荷4（应2）且CURRENT变化；只到该失败断言，未声称后续旧turn与草稿检查通过。原quiet17/active0/onscreen0/maxApps1/policies[2]/singleChrome/cleanuptrue，独立freshstatus实际0 absent后真实release；不是定位、工具或放宽预算的失败。

最窄修复增加helper具名 `beginCandidateVersionEdit`，仅沿已有Display五字段scope/session/candidate/version身份，Main复用已有A可信READY、实际当前display与known version，随后通知唯一notifyInputChanged。两种组onChange都调用，不把本地未保存正文传入Main，不写DB/版本/选择或新缓存，也不借show/options操作伪装。新增两项真实preload/Main端口反馈：首次误在根目录启动esbuild无法解析desktop相对路径，仅工具错误；纠正cwd、反向反馈加接口存在检查后真实RED2（API缺失）→2GREEN／135.99175ms。正向零HTTP调用且版本/选择/保存状态不变，错误范围/会话/候选/版本/非显示版本/额外正文/参数全部拒绝且零通知。完整TSC与diff通过；新两页面GREEN及原四完整根集成尚待执行，票据仍claimed。

上述主树三套相关Node（候选复制、样本版本来源、A公开版本端口）实际 **116 GREEN／2188.209417ms／skip0／actualexit0**，包含原端口76加新2及前两套38；没有新Python/PG/Page，不能用Node代页面。新fixture规范复审另发现清理失败被聚合后继续第二场的P2，已复用原pendingCleanup：非空在catch首句立即重抛，只有完整收尾后的普通断言才聚合，不抢占或清未知资源。完整TSC再次通过，限定两行新鲜规范复审硬要求0／重要possible0，旧fixtureP2已闭合；该故障路径未运行人工或未知进程实验。新的生产编辑通知及页面组合继续最终规格复核与真实复验，原首次PageRED和未完成状态保留。

主树最终在Conda NotAlone、禁dotenv/tracing，执行 `npm --prefix desktop run test:pages -- --case reply-strategy-message-groups --case reply-strategy-version-edit-guard --timeout-seconds 240`，session84211 **actualexit0／六完整公开场景全部通过**。原回应／主动整组编辑、真实保存503保稿、POST选择已commit后的GET503仍未确认／重读／显式旧新版选择、逐条Main复制、同PG后端重启和宿主重建恢复两个场景，以及回应真实SSE＋显式刷新、主动真实SSE＋断流间隙消息＋公开重连两个场景均通过；全部沿生产页面→认证HTTP→隔离PG，已经同时使用主树正式A4e分页/receipt、ROOT80b样本来源与新的编辑通知。

两个新增恢复未保存编辑场景均 GREEN：真实同SID选择恢复、result为null、实际GET完整完成组，明确开启未确认探索后只编辑消息或只编辑要求，两次真实burst之后payloadCount保持2、CURRENT不变、旧turn等值、原理解／task身份不变、编辑稿保留、版本仍只有1。原65888各4/CURRENT变化的真实RED已闭合；不是通过保存后通知或Node替代。范围RPC强反向仍由上述实际preload/Main反馈覆盖，不把合成transport说成新backend越权Page。

原资源结果quiet48／active0／onscreen0／maxApps1／policies[2]／单Chrome／cleanupConfirmed=true；ElectronRun=false、nativeAcceptance=false。actualexit后独立freshstatus实际exit0 absent，全部root runtime/source/fixture/OS资源真实RELEASE。原5s、23s/25s、ps1s、quiet和资源门槛全部保持，没有系统剪贴板、外部发送、真实App／微信／OCR或付费模型；复制surface与模型／消息到达是可控合成适配器，HTTP/PG及重启真实。

新鲜生产和fixture Standards硬要求0／重要possible0、Spec新增P0–P3为0；静态确认交叉通知路径及cleanup守卫闭合，再以上述真实六场收口。此前四场B owner结果和root首次两RED均保留，原当前票长历史完整组/来源删除后的恢复组/跨范围公开组合由B继续自动验证，不因六场正常路径提前关闭；R08仍claimed，人工／系统剪贴板／原生／自然模型质量未执行。
