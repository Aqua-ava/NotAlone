# 09：未选方向时的新消息有界更新

State: claimed
Triage: ready-for-agent
Blocked by: [conversation-reply-strategy/02 理解、纠正与方向确认闭环](02-understanding-and-direction.md)；[assistant-session-context/16 切换会话或关闭小窗时保持生成归属](../../assistant-session-context/issues/16-background-result-ownership.md)；[assistant-session-context/17 退出停止与重开后的中断恢复](../../assistant-session-context/issues/17-quit-and-interrupted-recovery.md)

拆分标识：R09（第三版映射；执行时以本文件为准）。

## 规格与范围

[正式规格](../spec.md)；旧04；Q27、Q28、Q31。 第二版标识为R08。 读取[工作流](../../../docs/agents/workflow.md)、[工程要求](../../../docs/agents/engineering.md)、[领域路由](../../../docs/agents/domain.md)、[领域语言](../../../CONTEXT.md)、[ADR-043](../../../architecture/adr/043-conversation-scenarios-and-direction-exploration.md)。依赖是完整交付的前置，不代表这些前置已完成；已交付的阶段证据与尚待接续范围见 Answer。

## What to build

正在进行且方向未选的任务收到消息后更新理解/建议；离开或关闭停止探索更新，已发起候选按会话规则处理。

## Acceptance criteria

- [ ] 只有用户已打开且方向未确认的活跃任务在授权新消息到达时更新理解/建议；不形成全局后台调用。
- [ ] 连续通知合并、有快照和调用次数/超时/重试预算；失败或超预算要求手动刷新，不扩大范围补扫历史。
- [ ] 方向确认、候选生成或编辑后仅提醒；旧探索结果不能覆盖已确认方向。
- [ ] 切换离开或关闭停止探索更新，已发起候选仍按C09继续；退出按C10停止，不另建生命周期模型。
- [ ] 新增路径按owner/contact隔离，保留来源及删除路径；敏感正文不进入普通日志，候选只能由用户亲自发送。
- [ ] 记录实际命令、结果、数据影响及剩余风险；未执行的验收不得预填通过。

## 范围边界

合并通知、有预算；选定方向后只提醒；旧探索结果不能覆盖已确认方向。明确依赖C09/C10区分视图关闭与退出。

## 验证与交付

使用公开页面操作 → 后端HTTP → 隔离PostgreSQL，复用真实业务控制器与存储，只替换模型、消息到达和必要宿主事件为可控合成适配器。观察公开结果、持久化重读和模型调用次数，不绑定内部调用顺序。

按工作流以TDD垂直推进，完成相关验证、Standards/Spec两轴评审与本地提交后，在本票补充Answer并据实更新状态。合成响应只证明数据和控制契约，不证明真实模型语义质量。真实App只能由主Agent在另行约定的有限窗口通过项目入口验证；页面结果不能代替原生证据。

本票不授权OCR、真实微信读取/发送、外部模型调用、部署或push；也不提前实现其他票。

## Comments

2026-10-11：用户认可30票复审修订后发布；表达样本独立保留规则已单独确认。尚未开始实现或执行产品验收。


2026-10-11 公开首反例及有界更新切片：本 B 使用原 test:pages 单标签 reply-strategy-bounded-updates、120 秒，在明确协调窗口及独立 status absent 后执行。实际 session98625 exit1：第一个回应消息场已验证只打开场景／真实消息到达不调用模型、用户明确探索成功，随后真实 SSE 三消息 burst 未更新理解，页面保留原理解；其余主动场、预算、失败、TTL 与离开尚未执行，不预填通过。quiet29／active0／onscreen0／maxApps1／policies[2]／单 Chrome／cleanupConfirmed=true，独立 status19024 exit0 absent 后释放，真实 App、OCR 和原生验收均未运行。

沿原 ReplySession／探索 HTTP 增加当前用户任务的合并通知元数据：同 owner 对应认证联系人、当前 scope／连接／SID、未确认方向，先以真实有界消息投影验事件归属；一个短期通知定时器、三个自动尝试及十五分钟端侧停止边界，失败或预算结束显示“本次自动更新已暂停，请点‘更新理解’继续”。原 B 存储仍独立复验真实 CURRENT、根 TTL、三次计数、来源、Skill 与未确认意愿；客户端不能签发确认或扩展后端预算。自动请求通过既有 openExploration 的 automatic 字段，不重试自动失败。原“更新理解”显式动作在暂停后开新任务，不把新消息或回答解释成方向／发送确认。切换场景／范围、输入编辑、选择方向或开始生成撤销自动元数据，迟到自动结果须仍属于该元数据才能发布；原候选继续按 A 链路处理。没有第二生成链、正文缓存、全局监听或额外历史补扫。

公开测试只复用原认证 SSE／真实 HTTP／隔离 PG，新增固定合成 burst、实际模型 payload 计数和本轮 owner 的真实根时间过期；正文不进入普通日志。当前仅实现与静态检查阶段，本 B 尚未运行完整公开 GREEN；另增加首次明确探索等待期间的通知合并反例，现共十二场，规范／规格审查结论在交付前补齐。A16／17 正式视图关闭及退出接口仍待接入，不另造宿主生命周期，不以切回改写或页面准备声称关闭／退出通过。本票 open、原验收未勾；仅合成／隔离资料，无真实聊天、额外供应商模型、人工验收、外部发送或 push。

2026-10-11 首轮限定审查识别三个新增静态 P2：首次用户探索等待期间没有活跃任务元数据而漏通知；自动 HTTP 在途遇到 SSE 中断后等待不释放；本地关键问题草稿会因问题变化而清空且未暂停自动更新。已新增三个真实公开反例并修复：拿到原 SID 后、模型前开始有界元数据，等待时只记录一个待合并位；流中断撤销实际自动请求并恢复手动更新；开始编辑只经原桥发送当前问题／输入 UUID，未提交文字留在 React 组件且自动更新暂停，不提交回答、不确认方向。新公开十二场尚未运行通过，三个 P2 仍待静态复核与实际页面验证；既有首场 RED 保留。

2026-10-11 二次静态复核补充：删除响应后重新建立自动元数据的重复入口，SSE 已暂停的首次手动请求只能完成原请求，回执不能重启自动任务；本地回答草稿绑定 inputVersion／questionId，暂时隐藏可保留原问题草稿，新问题展示空回答且不能提交旧文；已确认意愿的任务编辑不建立自动暂停标志，手动刷新沿原 previousId 接续。另增首次断流、手动换问题、改目的换问题及已确认意愿编辑后刷新四场，当前共十二场，均为准备状态，仍待公开运行和两轴最终复核。

2026-10-11 原单标签公开复验实际 session25723 exit1：首“回应消息显式任务内合并真实通知与三次预算”场完整 GREEN，验证未明确探索时零模型、三次真实 SSE burst 各一次自动调用、同 SID／新 task 与 input UUID、未确认／Skill 关闭、真实 PG CURRENT 一致、零候选 turn，第四次通知要求手动更新、手动新任务成功且总模型五次。第二“主动聊聊”场在首次明确探索等待理解时 5000ms 页面断言超时，仍显示 waiting；其余十场未执行，不用首场或静态审查关闭。quiet44／active0／onscreen0／maxApps1／policies[2]／单 Chrome／cleanupConfirmed=true，独立 freshstatus75008 actualexit0 absent 后释放。最终源码静态 Spec 新增P0–P3=0、Standards hard0／新增重要 Fowler possible0，原问题修复只是静态关闭；最小15个生产文件＋2声明严格类型、五entry esbuild write=false、相关111Node通过，均不等于十二场公开 GREEN。初次主动等待超时继续无OS最小诊断；未改变生产23秒HTTP预算或既有5秒断言，A16／17生命周期仍待正式接口。

本 B 无 OS 最小诊断沿原 BackendHost／ContactSession／ReplySession、MessageEventsFixture 及真实认证 HTTP／自有 PG，初始回应一次与主动三次的原五秒 ready 断言实际四次 GREEN（ready84–107ms／HTTP79–94ms）；只加入既有 MessageEventHttpProxy 的相同四次 GREEN（ready105–147ms／HTTP79–122ms），原 fixture 自有清理完成，无 Chrome／App／额外模型。这不能替代失败的公开第二场，也未定位超时根因。公开测试失败路径只新增状态阶段／有无自动暂停／模型进入与次数的安全计数采集，Promise.allSettled 保留原断言失败，不记录正文／身份／握手，不修改任何预算和清理门禁；下次公开复验仍跑同十二场、同原断言。当前只交付已验证首场及静态修复的可集成切片，本票 open，完整十二场及 A16／17 均保留待接。


2026-10-11 同十二场公开复验及原观测失败：在总协调 03:19:38 具名窗口、独立 freshstatus 实际 exit0 absent 后，运行原 `test:pages --case reply-strategy-bounded-updates --timeout-seconds 240`，实际 session39352 exit1。十二个业务场景全部 GREEN：回应和主动两入口均不自开探索；真实 SSE burst 合并、三次自动尝试、第四次提示与手动新任务；失败不自动重试、真实根过期模型前拒绝；切场景停更新；首次等待合并通知；在途自动请求遇断流恢复手动且迟到失效；未提交回答留在原问题；首次手动断流回执不重启自动任务；手动刷新或改目的后的新问题不可借用旧回答；已确认意愿的手动刷新保留接续。均经过生产页面、原认证 HTTP、真实隔离 PG 和受控合成模型，不是单元测试汇总。

末尾原资源／静默观测失败，因此不称整个 CLI GREEN、不关闭 R09，也不将上一轮主动首次探索超时说成根因修复。quiet129／active0／onscreen0／maxApps1／policies[2]／单 Chrome／cleanupConfirmed=true；自有子树采样 RSS peak 为 browser1012016KiB、node222160KiB、backend195232KiB，仅为观测报告、共享页可能重复，不是导致失败的内存阈值。独立 freshstatus 实际 exit0 absent 后已向总协调释放全部本 B runtime／source／UI／fixture 与 OS 窗口。原 failed 标志在周期采样异常时保留失败，本轮未记录具体执行阶段，不能推断异常根因。

释放后精确消费总协调正式 `a0c45eddb051fd7bf850bd3a95c40fd31b39eeab` 的唯一 `desktop/tests/headless/run.ts` 安全诊断增量，保留本 B 页面登记。只记录首次采样异常的阶段、错误类别及经过限制的 code／signal／killed，不输出命令、进程列表、错误正文或聊天身份。原失败退出、1000ms ps、1500ms helper、700ms 采样间隔、静默条件、清理与租约门禁均不变；没有另建 runner 或放宽预算。此次诊断是后续复验的可观测性前置，不冒充产品修复；限定原入口 esbuild write=false 构建已 GREEN，新增静态 Spec P0–P3 为 0、Standards hard 0／新增重要 Fowler possible 0；既有接受 P3 保留。R09 仍 open、原标准与未执行部分保留，下一原十二场总体结果与 A16／17 实际关闭退出接线继续，真实 App、OCR、真实聊天、额外模型、人工／原生验收、外部发送及 push 均未执行。


总协调消费本 B 7eda 正式入口后发现原测试 `observations.payloads.length` 的 TypeScript unknown 错误。本 B 原完整 `tsc --noEmit` 实际 exit1，六条中该处一条、另五条是尚未接正式 A11 的独立 R08 工作项；没有宣称整树通过。仅把这一个 poll 改为对真实返回的 payloads 使用 `toHaveLength(2)`，无 cast、假 DTO 或放宽计数／超时；再次原完整 TSC 实际仅剩原五条 R08/A11 缺字段及其派生错误，R09 unknown 错误消失。限定原入口构建及最终两轴复核均已完成，新增 Spec P0–P3 为 0、Standards hard 0／新增重要 Fowler possible 0；本地提交只包含此测试修正、正式采样诊断和本记录，不捎带 R08 接线。

prepare 前的原 55 项 GREEN 及 prepare 后一轮 54 pass／1 ERROR（179.911s、首探索 HTTP 超时）各自保留；最小同场未改预算串行 1 GREEN（1.970s）之后，现本 B 在原自有随机 PG 入口串行重新运行五个原探索 HTTP／PG 模块，完整 55 项实际 GREEN（66.768s、skip0＝32 HTTP＋23 PG、正式001–053、自有数据库剩余0）。这说明当前该原回归通过，尚未定位先前短暂超时的根因，不替代 R09 原采样观测总体通过或 A16／17 接线。


总协调另在既有 R09 生产队列发现一个当时尚未实际复现的静态 P2：旧 SID 已确认 deleted／missing 后，用户直接明确探索可创建新的有效 SID，旧删除展示状态却被自动更新队列的整体 truthy 判断拒绝。该问题与本次类型／诊断切片分开，当前没有据十二场通过关闭它；本 B 正补真实受控 HTTP／PG 反例和第十三个公开场景，再沿 A 既有 deleting／failed 门禁语义最小修复，仍保未知失败、目录待选择、范围、来源和预算门禁，不新建生命周期。R09 open 继续保留此剩余项。


2026-10-11 新任务被旧删除状态拦截的真实 TDD：针对总协调新增静态 P2，本 B 私有无 OS 最小回路只复用生产 BackendHost／ContactSession／ReplySession、原 MessageEventsFixture／HTTP 代理、认证 HTTP、自有隔离 PG 与既有合成模型。实际 session47530 exit1：旧 SID 经真实删除并 GET404，用户在同 scope 直接明确探索得到新的 SID 和未确认任务；真实 SSE burst 已使 noticeChanged=true，但 phase 仍 ready、sessionDeletion=deleted、模型 payload 只有两次，新任务未更新，原五秒断言失败；原 finally 正常停止自有 backend、代理与夹具。这是真实受控 HTTP／PG 反例，未启动 Chrome／App，不当作公开页面 RED。

只将自动队列的整体 sessionDeletion truthy 判断收窄为原 A 共用门禁语义的 deleting／failed；其余 active task、contact／scope／connection／SID、未确认、CURRENT／来源／Skill、目录待选择及三次／十五分钟边界不变，不清除 confirmedSessionDeletion 身份，不新增生命周期、正文缓存或生成链。相同回路实际 session75260 exit0 GREEN：新任务接收真实消息后保持新 SID、变更 task/input UUID，未确认、真实 GET CURRENT 一致、零候选 turn，实际模型总三次。另通过真实 HTTP 先删同一已知 SID，再用原删除／GET404核对得到 missing，实际 session52669 exit0，同新任务更新回路 GREEN；没有伪造删除状态或联系人事实。两次均完成原自有资源清理，不能替代公开页面或原生验收。

锁定 Node 在 desktop 执行原 `tests/assistant-session-deletion-guards.test.mjs`，四项实际 GREEN（142.801875ms、skip0），deleting／failed 仍不发探索 POST，精确删除重试与只读核验保留；继承原 strict 配置的十五个生产文件＋两声明限定类型检查 exit0，原 runner／新增公开 case 两 entry esbuild write=false 构建及 diff 检查通过。新增第十三个公开场景沿同一联系人／scope 的真实页面删除确认、直接“帮我理清方向”、真实 SSE burst 与 PG 重读验证，不点击新开／恢复或重新选择联系人，且保旧 SID404和确认删除身份；当前只完成准备，尚未在协调窗口运行，不预填 GREEN。

本切片最终限定 Spec 新增 P0–P3 为 0、原 P2 源码缺口关闭；Standards hard 0／新增重要 Fowler possible 0，既有接受 P3 保留。原 P2 的真实受控修复与尚未运行的公开第十三场结果分开记录。R09 仍 open、原验收未勾，原十二业务 GREEN／整体观测 exit1 与所有早期 RED／超时各自保留；原采样预算未修改，A16／17 实际关闭退出接口继续依正式交付接入。没有 OCR、真实聊天、真实 App、额外模型、人工／原生验收、自动外部发送、push、发布或部署。

2026-10-11 总协调真实主树集成：正式7eda／3b19／a70净生产、fixture、公开case及inline登记，在已正式rootA09/A10 UI与054／C删除／样本基线上执行 `npm --prefix desktop run test:pages -- --case reply-strategy-bounded-updates --timeout-seconds 240`。Conda NotAlone、关闭外部追踪，session63640 actualexit0，原十三完整场景全部通过，旧SID确认删除后直接新任务继续合并并推进actualCURRENT的新增反例也通过。两scene三次预算、过期模型前拒绝、失败不自动重试、断连迟到、切mode、等待合并和草稿input/question绑定均按原计数与原5秒断言；未新增正文/外部发送。quiet84／active0／onscreen0／maxApps1／policy2／singleChrome／cleanuptrue／nativefalse，独立freshstatus actual0 absent后真release。开始记录脚本换行引号错误未写MAIN而shell继续执行的入口错误保留，运行代码／夹具未改变，不作为产品RED。先前owner12businessG但整体observationexit1／firstopen5秒超时均保，后续未复现不声明根因已修；本根十三完整CLI G与owner71516 G分别计量。源两轴无新增阻塞、whole桌面type0已有。本票仍open：A16/17受控切换／surface close／quit-reopen正式端口及公开组合继续，不以本十三G关闭原第四条生命周期。


## Answer（总协调关闭探索边界的独立集成）

2026-10-11：新 B 从原正式 `16f85b1` 在 `/Users/local-user/.codex/worktrees/reply-strategy-completion/NotAlone` 接续，唯一 B 会话为 `local-chat-id`；旧 B 树因系统错误冻结并保留备份。正式 `56e72f4` 的普通生成八源／测试已逐 blob 核对与 root c843相同，Main只多无使用的purpose类型import不净，C合成测试保留root10caf新增来源用例。因此不whole十文件或重复集成同一 registry；原C样本接口、12e beginEdit、e092保存通知和80b来源验证保持。新 B 自己的211Node／20HTTP及54账本与清理是负责人证据，未写作主树55运行。

只净 B 正式 `6a31871db7959aa18166a290d6f4ca88c4a3034b` 的两源码／测试增量：hidden或closed停原自动探索计时器；非已确认生成的在途探索失效，晚回包不恢复建议。确认或已确认后的回答生成、普通已发起候选继续沿 A 原会话作业；没有新取消、正文缓存或 writer。Root自己的真实生产具名桥接→认证HTTP→随机055PG负向及普通hide／close正向 **2 GREEN／6110.748917ms／skip0／actualexit0**；每份实际55账本／repeat0／instance与class清理true／database_remaining=false，合成实际模型各1共2。五个候选版本／来源／样本／复制相关 Node 模块 **225 GREEN／1340.456125ms／skip0／actualexit0**，完整desktop TSC及diff通过。原首次未激活Conda只属环境门禁失败，未建数据库或HTTP，不称产品RED。精确日志 `/private/tmp/notalone-root-hidden-exploration-http-pg.log` 与 `/private/tmp/notalone-root-hidden-exploration-related-node.log`。

B 真实页面 first78240因PageHost未通知reply消费者失败；最薄host bb1d正式后 second18530已越过关闭后SSE零追加模型，重开fixture抢在about:blank加载后读取bridge而失败，其余四未执行，两轮均cleanup／hash／独立freshabsent完整释放。负责人正修原5s加载前提并继续五场；主树尚未净这新页面或自行执行它，不借受控HTTP／旧14场或六编辑场称新五场通过。A16 B确认／回答 registry、A17实际受控quit／重开和B10／11连续组合继续；本票开始实施故当前State改claimed，六条原验收文字和未勾状态保留，历史open及真实失败记录不删除。只有合成资料／可控模型／隔离数据库，真实App、原生、人工、真实模型质量、微信／OCR、外部发送、push和部署未执行。

主树新生命周期公开回归准备（2026-10-11）：仅净B正式240926a／bb1d546／3920080的必要七个页面／夹具路径；Root仍沿原两个inline白名单及dispatcher只加同一label，未引入负责人新catalog重构，既有Root/C所有case和资源门禁保留。PageHost按真实Main分别通知foreground与reply的closed／focused，沿原待处理command集合观察实际完成；新增身份查询只读本轮合成owner的无正文UUID，实际完成仍公开GET复验。原B六参数／原等待／SSE150ms及120秒范围不改，about:blank重显先等原公开“回应消息”按钮可见，不弱化期待。

Root whole桌面TSC、fixture编译、两个entry的esbuild write=false及diff均通过；首次编译命令多entry遗漏outdir是工具入口错误，改逐entry同配置构建后实际通过，不称产品RED。之前脚本尝试负责人存在但Root没有的catalog路径失败，Root依实际inline路由精确接线，没有复制架构。此为准备证据，主树新五完整公开场尚未运行；原Root14／六编辑场、负责人两个实际FAIL和最终新窄HTTP结果各自保留。B预算409复验GET静态P2在其独立主题修复，不凭新五场准备借G。State claimed及六条原AC未勾，A registry／退出仍由A接续，无真实App／原生、微信/OCR、外部模型、私料、发送或远端操作。


主树新五场真实公开结果（2026-10-11）：具名reply-strategy-lifecycle single120、session86224 actualexit0，回应／主动关闭未确认探索后的真实SSE不追加调用、在途探索晚回包不恢复、两scene已发起普通组在关闭后唯一保存原SID并公开重显，五个原完整场均passed。Root实际运行源formal0a33a25＋43456a7及正在最终只读审查的Ccarry薄caller；没有A54 provider。941个全部backend／desktop运行源码、fixture、测试、配置逐字全窗unchanged，HEAD不变；quiet32／active0／onscreen0／maxApps1／policies2／singleChrome／cleanuptrue／nativefalse。actualexit后独立freshstatus actual0absent，按本轮freeze时间精确五ownership文件只读PG核database_remaining=0，明确FULLRELEASE后才接后续源。日志/private/tmp/notalone-root-reply-lifecycle-page.log及private sourcefreeze、五归属文件保留。

原5s、SSE150ms与模型计数断言不改，不借负责人36102的五G；初MAIN编码记录错误未写而shell继续，运行文件未改变，后补实际记录，不称产品RED。普通生成及未确认探索范围已由新Page证明；已确认／回答的A作业归属、真正受控退出drain、B10／11连续组合仍继续，本五场未测试携入UI，不能因运行树含C55caller称携入页面通过。State claimed、六条原AC未勾；真实App/微信/人工/供应商/原生剪贴板/外部发送/remote未执行。
