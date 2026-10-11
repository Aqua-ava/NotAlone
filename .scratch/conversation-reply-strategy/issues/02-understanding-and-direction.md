# 02：理解、纠正与方向确认闭环

State: resolved
Triage: ready-for-agent
Blocked by: [conversation-reply-strategy/01 回应场景与明确意愿直达候选](01-response-scene-entry.md)

拆分标识：R02（第三版映射；执行时以本文件为准）。

## 规格与范围

[正式规格](../spec.md)；旧01；Q1–Q10、Q12、Q15。 读取[工作流](../../../docs/agents/workflow.md)、[工程要求](../../../docs/agents/engineering.md)、[领域路由](../../../docs/agents/domain.md)、[领域语言](../../../CONTEXT.md)、[ADR-043](../../../architecture/adr/043-conversation-scenarios-and-direction-exploration.md)。依赖是完整交付的前置；实际实施结果与未执行项见本票 State 和 Answer。

## What to build

未明确意愿时展示简短理解与不同方向；纠正只更新理解和建议，用户明确给出方向或确认建议后才生成候选。

## Acceptance criteria

- [x] 未明确意愿时展示一句理解、真实依据和歧义，以及少量不同意愿的方向；不是同立场语气变体。
- [x] 纠正理解只刷新理解和方向，未确认意愿时生成调用数为零；已明确意愿不因纠正理解而被替换。
- [x] 用户直接给出方向或选择建议后才生成；建议ID与输入版本绑定，过期建议不能应用到新快照。
- [x] 仅交付一组方向的完整路径；来源失效、跨范围、错误或迟到建议拒绝，换组由R03扩展。
- [x] 新增路径按owner/contact隔离，保留来源及删除路径；敏感正文不进入普通日志，候选只能由用户亲自发送。
- [x] 记录实际命令、结果、数据影响及剩余风险；未执行的验收不得预填通过。

## 范围边界

未确认不生成；建议ID与输入版本绑定，歧义可见、依据可查。先完成一组方向的完整路径。

## 验证与交付

使用公开页面操作 → 后端HTTP → 隔离PostgreSQL，复用真实业务控制器与存储，只替换模型、消息到达和必要宿主事件为可控合成适配器。观察公开结果、持久化重读和模型调用次数，不绑定内部调用顺序。

按工作流以TDD垂直推进，完成相关验证、Standards/Spec两轴评审与本地提交后，在本票补充Answer并据实更新状态。合成响应只证明数据和控制契约，不证明真实模型语义质量。真实App只能由主Agent在另行约定的有限窗口通过项目入口验证；页面结果不能代替原生证据。

本票不授权OCR、真实微信读取/发送、外部模型调用、部署或push；也不提前实现其他票。

## Comments

2026-10-11 持久UUID公开后端：生产装配替换旧整数／进程缓存路径，回应与主动共用A实际助手输入、正式052探索存储及原ReplyGenerator。新增真实HTTP/正式001–052 PG覆盖纠正不确认、明确选择/直接意愿、回答仍有歧义不生成、完成同键重放、当前输入/Skill竞态及原根删除。首端点404、主动伪confirmed成功、旧完成操作被TTL/current拒绝、晚期revision保存候选、非法引用推进输入及实际保存TTL未擦正文等反例均先RED再GREEN。页面尚未替换和执行，票保持claimed；旧7场页面不作为本次UUID闭环证据。

本主题最终20新公开HTTP场与单次字段、正式052存储/升级、原生成/候选组、A输入/助手/记忆删除和C样本参考联跑94项全部green、skip0、owned_database_remaining=0；230完整reply unit、11引用/应用unit及桌面 `npm run typecheck` 通过。命令为显式Conda/PYTHONPATH的隔离测试入口，测试使用实际生产迁移和装配；早先模块名错误的联跑保留为失败。Standards hard/Fowler及Spec剩余均0；新增TTL反例直接查库，不依赖后续GET触发清理。仅合成资料、无App/OCR/真实聊天或额外模型。此为R02/R03/R05/R06/R07共同后端交付，不代替页面、A12预算、R09/R10或组合验收。

2026-10-11：用户认可30票复审修订后发布；表达样本独立保留规则已单独确认。尚未开始实现或执行产品验收。

## 历史整数接口承接契约（已退役）

- 明确打开 `POST /api/reply/explore`，提交联系人、短任务 `task_id`、递增 `input_version`、真实 `target_message_id`、纠正和可选已确认建议引用。后端只用同范围目标、最多四条相邻消息、最多两条已确认记忆；一次结构化调用，无业务Tool或表达样本。
- 返回理解、歧义、真实依据及2–3个不同立场方向；引用使用 `task_id + input_version + suggestion_id`，不得靠正文模糊匹配。纠正只更新探索，已选方向通过有界原始／最新引用延续，不因错误或响应丢失替换意愿。
- 用户选择方向后再点击生成，继续进入原 `ReplyService → ReplyGenerator → Store`。确认核验只对新领取请求执行，已完成同键重放不依赖临时探索内存。建议协议只保存请求指纹；成功上下文保存当前及原已选方向的完整来源依赖。
- 额外删除依赖以 `ContextEvidence.model_visible=false` 保留，不突破生成器原有消息、记忆预算；探索记忆正文合计最多600字符。来源删除清除缓存、已编辑派生方向及受影响持久副本；删除后拒绝重放不留下派生请求正文。
- 缓存15分钟、最多128任务；原意愿到期同时撤销依赖它的当前快照。测试可注入探索时钟，生产仍为monotonic。持久助手会话及其权威输入版本由A负责，后续接线不能把此短任务整数版本扩展为另一套持久权威。

## 历史 Answer（持久UUID接续前）

2026-10-11：R02可自主执行范围完成；仍是单组方向，换组、澄清、主动目的、Skill及持续会话组合由各后续票推进。

- TDD：公开页面红例首先缺少“帮我理清方向”，补齐后green。增加纠正、不确认不生成、显式选择、失败/丢包恢复、过期建议、跨owner/contact、迟到结果、无效引用与不同立场校验；审查补齐派生方向清理、原方向来源延续、生成预算和原快照TTL边界。
- 页面命令：Conda NotAlone中 `npm run test:pages -- --case understanding-direction --case response-scene-entry --timeout-seconds 180`，R02六场加R01一场全部通过。真实生产页面/控制器、认证HTTP、每场随机PG、受控模型；包括持久依据重读、后端重启同键重放、独立旧来源移出检索后仍正确删除、失败请求无派生正文。
- Python：显式 `PYTHONPATH` 指向本工作树，`python -m unittest discover -s tests/unit/reply -t . -q` 175项通过；在本轮随机迁移库运行 `test_reply_service`、`test_reply_api`、`test_postgres_reply_store`、`test_source_deletion` 共46项通过，精确核对测试库剩余0。共享Conda最初导入主仓和共用测试库schema不匹配的结果不计本票证据，没有迁移共用或业务库。
- `npm run typecheck`、安全调度CLI10项及 `git diff --check` 通过；Standards/Spec独立只读审查最终均0。静态审查不作为运行结果。
- 测试修正：异步计数曾包含跨用户拒绝响应；删除夹具补齐真实任务、记忆服务。一次旧PageHost未先关闭就重启后端导致原资源报告cleanupConfirmed=false；保留该失败报告，核验仅本轮PID/进程组均已退出、随机库剩余0后恢复自有租约，后续改为先关闭再重启，最终cleanupConfirmed=true。未杀未知进程。
- 数据影响与剩余：只处理合成消息、受控模型和随机测试库；正文不进入普通日志，探索不写长期偏好。未运行真实App、OCR、微信或额外外部模型，未验收原生能力或自然语言质量。总协调跨账户工具暂不可达，交付保留本地；持久会话权威版本及跨模块组合仍须后续真实接入，不据本票宣称全功能完成。

2026-10-11 持久权威接续：按总协调唯一实现决定，将此前临时整数任务版本改接A051持久UUID；旧7场景公开页面/175回复单元/46隔离PG证据仍保留，不能代表新适配已完成。当前抽取最小探索快照（回应目标±2、主动最近5、已确认资料2），只保存有限展示正文和原事实指纹，复验完整正文/源/角色/时间；保留实际删除对象ID、去除手工身份哨兵，原意愿依赖不进入生成模型。7项TDD单元通过，跨范围复验两个red断言已修正，两轴该模块复审0。等待正式A051后装配唯一公开探索并重跑真实HTTP/页面；State回到claimed，不改写旧验收证据。

2026-10-11 正式052存储切片：已消费A051 `7c97856` 为本树 `5332961`。B操作键占位与A讨论UUID经同连接原子保存，CURRENT/CONTINUE核验唯一A当前指针；HISTORY只能核对原应答/失败操作，不授权旧意愿回退。真实PG反例覆盖并发同操作只建一个输入、B写入失败回滚A指针、同UUID重试、跨联系人/重绑拒绝、原始来源删除擦除、Skill目录变更清旧建议且保留已选意愿供明确刷新、停止后迟到拒绝、3次自动预算和原15分钟期限不随刷新重置。原模板缺端口的首RED后已重写；迁移期间两次列名错误在随机库边界停止并修正，不计为产品反例通过。

命令：显式Conda/PYTHONPATH运行隔离测试入口，联跑 `test_reply_exploration`（14组件＋1真实051→052旧候选升级）、生产迁移首次及重复、原 `test_strategy_flow` 2、`test_reply_message_groups` 2、A讨论/记忆依赖，合计34项green、skip0、owned_database_remaining=0。使用实际正式001–052前缀，无辅助schema；原2项候选500缺列失败已实际转绿。审查新增暂停后Skill更新仍残留选项、事务授权前到期窗口和旧选择误确认三条真实PG反例，均先RED再修复GREEN；TTL在实际授权事务复验，拒绝后以独立事务擦除过期正文，finish核对输入UUID、请求键、选择三元组和A完成状态。Standards/Spec该切片最终均0；静态审查不代替运行结果。公开探索HTTP/页面、实际生成端口和最终总预算仍待接，票保持claimed；这些组件结果不替代旧页面或组合验收。

2026-10-11 生成前原子接线：按总协调明确归属，提取 `canonical_reply_input` 供A投影与既有摘要共用，派生协议继续只留SHA指纹；`prepare_explored_generation(connection,scope,session_id,command)` 在A推进唯一UUID之前核对实际选择、目标、一次声明、Skill及原根/当前完整来源，并保存真实依赖。8项PG组件先RED再GREEN，包括主动无根依赖导致删除后正文残留、合法空白声明误拒绝、实际完成后历史重放被新输入/TTL/Skill误拒绝、过期reserve拒绝但未擦除。已完成同键保持原摘要/绑定/保存来源守卫，未完成才复验CURRENT；过期擦除在A事务退出后独立提交。联跑这8项、052存储/升级及A公开保存/输入/记忆删除/B单次字段共63项真实HTTP/隔离PGgreen、skip0、owned_database_remaining=0；230回复单元通过，两轴最终0。公开B探索尚未装配，组件UUID验证不代替页面闭环；原始数据仅合成，不读真实聊天、不写长期偏好。

2026-10-11 持久UUID核心页面交付：新增 `exploration-client` 只适配唯一公开持久接口，先读A实际current UUID；确认/应答/停止均绑定原UUID，失败保持原操作键。两种场景共享理解、依据、关键问题、当前一步、取舍、要求、Skill和暂停控件，纠正及回答不确认，明确选择才能沿原生成链继续。只薄接RewritePanel props，保留A08讨论恢复与C04复制入口。

命令：Conda NotAlone中 `npm run test:pages -- --case reply-strategy-dialogue --case reply-strategy-invalidation --timeout-seconds 240`，五场全部通过；两场核心各4模型调用，原确认完整响应及身份同键重放0追加，关闭Skill后普通生成是第5调用且HTTP明确disabled，主动真实来源删除清空派生目的／回答。三场改目的／场景／目标分别3调用，新HTTP旧回答null。新增三P2均有实际公开RED后修复；前一次未激活Conda只被入口拒绝，未启动页面。typecheck与安全页面CLI10项通过，quiet42/active0/onscreen0、单Chrome、cleanupConfirmed=true、Electron/native=false。只处理合成资料；无OCR、真实聊天、外部模型或人工验收。旧七场仍是历史INT证据，待新UUID迁移；完整换组、版本、预算与生命周期未据此通过，保持claimed。

2026-10-11 完整来源复验：Spec发现完整 `source_ids` 误用20条引用预算，补固定21条实际同联系人来源及手动确认记忆后，首次公开探索200但页面拒绝合法结果，取得RED。解析器改为完整来源UUID校验，引用仍最多20条且核对当前依据。首轮修后因夹具未引用记忆而额外要求正文显示，属于测试前提错误；改用当前真实依据ID后，明确确认实际503暴露原根与当前记忆删除依赖重复追加。新增真实HTTP反例先RED，生成适配器按依据身份去重并保留完整来源后GREEN，不扩大模型可见窗口。

最终在显式Conda中运行 `npm run test:pages -- --case reply-strategy-dialogue --timeout-seconds 180`，回应与主动两场全部通过：21完整来源集合、实际引用显示、纠正／回答不确认、明确选择生成、同键完整响应0追加调用、普通生成继续disabled，以及主动来源删除清派生目的／回答。quiet22/active0/onscreen0、单Chrome、cleanupConfirmed=true、Electron/native=false。隔离入口联跑 `test_persistent_reply_exploration`、`test_explored_generation`、`test_reply_exploration` 共44项通过（37.475s），正式001–052，owned database remaining=0；230回复单元通过（1.457s）。新HTTP多来源用例两场均查库只有1条记忆依据、重放不追加调用、实际DELETE后旧确认409。

两轴最终只读审查：Spec 0；Standards hard 0，接受1条P3测试准备重复建议，暂保留HTTP与页面各自的合成准备，避免为测试数据新增跨模块接口。该建议不影响产品隔离或行为；静态审查不当运行证据。完整版本、预算、旧七场UUID接续和生命周期仍未据此完成，原验收标准及claimed状态保持。

2026-10-11 普通请求与探索改口边界：协调审查发现普通A生成后探索确认B可能仍复用A旧attempt。新增公开 `reply-strategy-transition` 两场均取得真实RED：下一普通HTTP key仍等于A。仅在runStrategy开始时清除旧普通lastAttempt，保留策略操作自身的UUID/键、实际Skill与保存守卫；修后两场新key、B意愿、实际NoSkill禁用、新候选和第4次模型调用均通过，策略确认及新普通请求各自完整同键重放不追加调用。

命令为Conda NotAlone内 `npm run test:pages -- --case reply-strategy-transition --case reply-strategy-options --timeout-seconds 180`，两case实际GREEN，quiet33/active0/onscreen0、单Chrome、cleanupConfirmed=true、Electron/native=false；typecheck通过。首次修后主动最后TEST按钮不存在30秒超时已保留，改用既有主动生成按钮重放；Standards提出聚合catch可能吞收尾错误的硬P2，改为仅捕获页面回调失败，完整收尾失败直接停止且未确认清理不启动下一场，最终限定hard0/Fowler0、Spec0。仅合成资料与受控模型，没有App、OCR、真实聊天、额外模型或人工验收；本切片不关闭完整票和连续生命周期依赖。


2026-10-11 总协调主树集成复验：正式414前端、47共同预算与48旧请求修复合并后，保留A08读取、C样本与正式删除DTO。44项实际HTTP／001–053 PG GREEN（42.835s）及随后30项预算／探索／C边界HTTP GREEN（37.655s），两组自有库均0；273回复单元GREEN（1.792s）、type与CLI10通过。此前确认后方向未同步和来源删除漏探索清理的合并P2均修；Spec新普通A→探索确认B→普通复用A的旧键真实两场RED后由B正式48修复。root原transition＋conversation-strategy-entry两labels180实际exit0，回应／主动新key、新意愿／disabled与各自原样重放0调用全部到达，quiet26／cleanuptrue／单Chrome／Electronnativefalse。先前两label窗口exit1、目标场5s仍waiting及后续有界实际HTTP等待取得三场GREEN均保留；不把分窗通过改写成原失败窗口通过。最终限定Standards硬0／重要smell0、Spec0；完整旧七场UUID、Skill版本和连续生命周期等仍接续，claimed不变。


## Answer（持久UUID完整公开闭环）

2026-10-11：原六条理解与方向页面场景已逐项改接正式UUID探索、确认及唯一A生成链，保留原范围和断言；场景入口的重放也使用实际原助手会话端点。最终Spec为0项P0–P2，Standards硬问题及本次新增重要Fowler问题为0；既有已接受P3测试准备重复建议保留。原验收标准未弱化，本票可自主执行范围已完成，State更新为resolved；不声明原生或人工验收。

- 理解纠正不确认方向；明确选择后未回答关键问题不生成。故障明确重试和丢响应重放沿用原UUID、原键和原正文；用户明确改口后推进新输入且保留新意愿，普通生成数仍为一。原完成A生成和B确认的完整响应在新输入及宿主、后端重启后均原样重放，模型零追加。A请求只从公开会话GET按真实turn_id取完成输入和请求键，不伪造薄确认DTO的字段。
- owner/contact越权统一返回正式409拒绝元数据，未确认、过期选项和已失效来源均不调用生成；迟到理解不覆盖新快照，无效依据、同立场变体和失败不产生候选。原始来源删除清理派生方向、纠正、保存输入及候选；移出最新快照的旧依据仍保留可删除关系。原根年龄895秒时先证明纠正200、新UUID及原确认意愿，再加6秒证明新增确认请求409且无模型追加，纠正不能重置原根期限。
- 实际命令：显式Conda后 `npm run test:pages -- --case understanding-direction --case response-scene-entry --timeout-seconds 300` 的26587窗口，原六场understanding全部casepassed GREEN、21实际模型调用（7/2/5/2/3/2）；同CLI第二入口因旧global重放端点DTO误设失败，actualexit1、quiet60、cleanupConfirmedtrue、cases仅understanding。入口仅改原session/replies端点、不剥字段后，`npm run test:pages -- --case response-scene-entry --timeout-seconds 180` 的67209窗口actualexit0、完整入口GREEN、2实际调用、quiet9、cleanupConfirmedtrue。两窗均单Chrome、active/onscreen为0、maxRegisteredApps1、activationPolicies[2]；CLI租约各自实际absent，Electron/native验收均false。已通过的六场源码后未改，不把联合exit1汇报为exit0。
- 失败历史保留：34123在scope旧404预期遇正式409，continuity原6调用段到达但其余未到；PRE发现手动改口、纠正同键冲突及895成功检查点三缺口，均已恢复加强。补强首次tsc因turn类型漏input_version_id失败、补公字段后通过；1455因薄确认DTO无input/request_key失败，修为真实GET；6454加强连续场已到达但scope漏算两越权HTTP记录，修为操作前数量加一并独立核200和新UUID。各页失败均actualexit1、分别quiet19/10/25、cleanupConfirmedtrue，不记业务修复或整组GREEN。
- `npm run typecheck` 和 `git diff --check`通过。本次改动仅合成公开测试与任务记录，生产控制器、HTTP、正式PG53存储及原生成器保持实际复用；宿主/后端夹具自有资源已收尾。私密标记均为合成数据，未读取真实聊天，没有OCR、额外外部模型、自动发送、真实App、人工或原生验收、push。合成验证只证明控制、隔离、来源与持久契约；不宣称真实模型语义质量。R03–R07分别已有正式两场或六场公开证据，R08–R11依正式接口继续，不由本票代替其验收。


2026-10-11 总协调主树独立公开复验：精确消费正式46e6af7两份合成页面用例，只补必要三个夹具方法及dispatch，保留本树真实生产装配、唯一inline门禁、nonce、最多两labels／1–300秒与租约；没有恢复旧整数目录或替换生产接口。Conda内原 `npm run test:pages -- --case understanding-direction --case response-scene-entry --timeout-seconds 300` 的93006窗口，两label七场全部casepassed但最终观测failed，actualexit1／quiet95／active0／onscreen0／cleanuptrue；原失败资源报告独立留存，不作整体GREEN。临时仅增加采样异常错误日志、保持门禁后，完全相同命令93022 actualexit0，七场原全部断言通过，quiet91／active0／onscreen0／maxRegisteredApps1／activationPolicies[2]／单Chrome／cleanuptrue／Electron与native false；独立status1629 exit0 absent。复跑没有采样异常日志，首次观测失败原因尚未确定，不宣称门禁Bug修复。临时DEBUG两处已全部删除，原门禁代码恢复；资源峰值仅RSS采样，无峰值硬门限。

真实CLI `node --test tests/headless/command.test.mjs`10 GREEN／3558.776041ms、skip0，typecheck、fixture编译与diff通过。首次误用不存在的tests/page-cli.test.mjs是入口错误，未运行产品路径、不作业务RED。真实页面→认证HTTP→每场隔离PG及受控模型、全部新UUID／范围／来源删除／失败重试／原完成响应重放0追加／原TTL895＋6断言保持，未把mock通过算整合；本票原六标准按本轮自动证据勾选，原文字不变。真实App、原生、人工及真实模型语义质量按范围跳过；仅自动范围resolved，B08–11及C新短prefix来源缺口仍继续。


2026-10-11 本主树十一文件最终独立两轴：Standards硬要求0／新增重要Fowler可能气味0，Spec新增P0–P2为0；核原六场完整断言、必要合成夹具、门禁、数据隔离与五票状态证据。原观测失败原因未确定的风险保持；审查只读，不替代93022实际公开运行。
