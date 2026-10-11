# 09：未选方向时的新消息有界更新

State: resolved
Triage: ready-for-agent
Blocked by: [conversation-reply-strategy/02 理解、纠正与方向确认闭环](02-understanding-and-direction.md)；[assistant-session-context/16 切换会话或关闭小窗时保持生成归属](../../assistant-session-context/issues/16-background-result-ownership.md)；[assistant-session-context/17 退出停止与重开后的中断恢复](../../assistant-session-context/issues/17-quit-and-interrupted-recovery.md)

拆分标识：R09（第三版映射；执行时以本文件为准）。

## 规格与范围

[正式规格](../spec.md)；旧04；Q27、Q28、Q31。 第二版标识为R08。 读取[工作流](../../../docs/agents/workflow.md)、[工程要求](../../../docs/agents/engineering.md)、[领域路由](../../../docs/agents/domain.md)、[领域语言](../../../CONTEXT.md)、[ADR-043](../../../architecture/adr/043-conversation-scenarios-and-direction-exploration.md)。依赖是完整交付的前置，不代表这些前置已完成；已交付的阶段证据与尚待接续范围见 Answer。

## What to build

正在进行且方向未选的任务收到消息后更新理解/建议；离开或关闭停止探索更新，已发起候选按会话规则处理。

## Acceptance criteria

- [x] 只有用户已打开且方向未确认的活跃任务在授权新消息到达时更新理解/建议；不形成全局后台调用。
- [x] 连续通知合并、有快照和调用次数/超时/重试预算；失败或超预算要求手动刷新，不扩大范围补扫历史。
- [x] 方向确认、候选生成或编辑后仅提醒；旧探索结果不能覆盖已确认方向。
- [x] 切换离开或关闭停止探索更新，已发起候选仍按C09继续；退出按C10停止，不另建生命周期模型。
- [x] 新增路径按owner/contact隔离，保留来源及删除路径；敏感正文不进入普通日志，候选只能由用户亲自发送。
- [x] 记录实际命令、结果、数据影响及剩余风险；未执行的验收不得预填通过。
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


主树已确认候选的公开生命周期准备（2026-10-11）：只净正式B9f9f11c的原消息夹具和原五场文件，沿Root现有两个inline白名单及dispatcher另加reply-strategy-confirmed-lifecycle，原五场及C/Root所有入口保留，没有引入另一catalog或生产生命周期。八场为回应／主动×确认方向／已确认后回答×关闭小窗／公开新开会话；复用实际公开按钮、认证HTTP及隔离PG，只有真实候选input_mode触发合成hold_generation。候选暂停时观察真实manager通知false→true，覆盖原150ms合并窗口后实际GET CURRENT和已进入payload计数保持，再释放；不能把发SSE后的立即释放当作模型未追加的证明。原5s／HTTP23s／gate60与清理不变。

根whole桌面TSC、两个entry esbuild write=false、Python夹具compile与diff通过。首次安全CLI在默认沙箱下因共享probe租约目录不可写，10项中5pass／5fail、515.041834ms，尚无Page或数据库，不称产品RED；按同授权仅补目录权限后重新验证的实测另记。主树八场公开尚未运行，也尚未消费A16B确认／回答作业端口；不借原Root86224或B36102五场G，不把准备当关闭/切换后的候选完成证明。State claimed及原六AC未勾，A17退出／B10／11组合继续；无真实App／原生、私人资料、外部模型、聊天发送或远端操作。

补充本次门禁实际结果：同代码补权限后的安全CLI实际9pass／1fail，失败仅初始只读status期待absent而A具名预算RED窗口仍持有共享实际Page租约；不改门禁、不清他人锁、不并发真实Page。此阶段不标CLI总体通过，待A完整FULLRELEASE后原10项再运行。

共享实际Page租约独立freshstatus actual0absent后，同代码原安全CLI十项重新完整运行：10 GREEN／2717.629666ms／skip0／actualexit0。仅合成probe进程与自己的probe租约，不启动Chrome/Electron/真实App；先前5FAIL目录权限及9G1FAIL实际租约阶段各保留，门禁/预算未修改。日志/private/tmp/notalone-root-confirmed-lifecycle-safe-cli-released.log。八场准备源码此前fresh两轴无新增问题，本次仅补准确结果；真实八场及A16B仍未运行/未接，不以CLI代替页面证据。

## Answer（本轮已确认候选的唯一作业接线）

本轮 B 在独立工作树 `/private/tmp/notalone-round29-b`、基线 `84b5dd32` 接续，消费唯一 A 正式 `0ec5a1ae` 的十四个提供者／客户端文件为本地 `7abec150`；没有复制 A 的任务记录或改写其状态。消费兼容性实际验证为选定版本要求两条 HTTP 加命令单元两条，共 **4 GREEN／2.267 秒**，正式001–055逐名账本、重复0、内外自有数据库残留0；完整桌面类型及diff检查通过。这四条属于本 B 新运行，不借 A 的51条或 Root 的41条结果。

针对未登记已确认候选的实际缺口，原 `assistant-generation-ownership-http.test.mjs` 新公开反例先取得 **1 FAIL／3820.159083ms**：主动探索与明确确认已进入真实模型，唯一作业的实际回执数组却是0，原要求为1。补充原 `prepare-confirm`／`prepare-answer` 的薄客户端后，该同反例 **1 GREEN／3389.149375ms**；不把环境socket EPERM或首次类型括号错误记作产品RED。

准备与执行共用 `actionBody`，准备结果必须是实际五字段 A receipt，候选完成再核turn／输入／SID及真实任务ID。仍有问题或未确认的回答只发布探索结果，不领取候选；确认后才把实际receipt登记至已有 `AssistantGenerationJobs`。关闭或切会话只离开视图，原请求与原body不变；既有view operation、范围、连接、SID和唯一作业发布资格共同拒绝把旧候选发到后来的视图。准备中已明确提交的确认／已确认回答保留本次请求控制器以接实际receipt，不建立第二作业表、CURRENT writer、正文缓存、来源图或发送接口。

新增两场景×确认／已确认回答×关闭／新开共八个具名Main/preload→真实HTTP→隔离PG场景 **8 GREEN／28326.785875ms／skip0**：每场实际2或3次合成模型，准备／执行body hash一致，receipt的turn／input／key取真实GET，关闭不发布、新SID为空、选回或重显只读取原完成组且零追加。加实际prepared／generated任务ID等值守卫后的完整同文件相关回归 **29 GREEN／84573.4795ms／skip0／actualexit0**；29份正式55迁移及repeat0、29份instance/class清理和自有库剩余0逐项确认。原普通生成、来源删除、绑定撤销、连接变化、完成优先及替换回归保留。

实际命令均先激活Conda `NotAlone`，`PGPORT=55441`，隔离dotenv与追踪，只使用模型边界合成响应：`node --test --test-name-pattern='B09' tests/assistant-generation-ownership-http.test.mjs`，最终 `node --test tests/assistant-generation-ownership-http.test.mjs`；完整 `npm run typecheck` 和 `git diff --check`通过。固定三个源码／测试路径独立两轴：A Standards硬要求0／新增重要Fowler possible0，C Spec新增P0–P3为0；只读审查未冒充执行。

本阶段没有运行普通Page。既有confirmed八场仍须在总协调具名有限窗口真正执行；本 B 的29项HTTP不能替代它们。退出在prepare回执尚未到Main时的未知领取阶段已明确交唯一 A17补齐，同作业必须等待真实准备落定再中断，不能用本八条关闭该边界。原 `State: claimed`、六条原验收及所有历史失败继续保留。无真实App、原生、人工、系统剪贴板、OCR、微信、私人资料、付费或外部模型、自动发送、push、发布或部署；自然语言质量仍未知。

### 总协调主树集成复验

Root 按正式 `59c4bd62` 的四路径净变更集成，主树重新执行 `node --test --test-name-pattern='B09' tests/assistant-generation-ownership-http.test.mjs`：**8 GREEN／29277.934167ms／skip0**；八份实际001–055迁移账本、repeat0、instance/class清理与自有数据库残留0均有实际输出。完整桌面类型检查与diff检查通过。此项是 Root 新运行的 Main/preload→HTTP→隔离PG证据；独立 B 的具名公开Page八场实际结果另记，不混用次数。原退出未知准备、原生及人工验收范围继续保留。

## Answer（本轮八组公开页面实际完成）

上述“尚未运行Page”为提交准备时的真实状态。随后在总协调具名单次窗口台北21:17–21:22内，冻结本树干净 `59c4bd62`，实际执行 `PGPORT=55441 node scripts/test-pages.mjs --case reply-strategy-confirmed-lifecycle --timeout-seconds 240`：Conda NotAlone、正式001–055、仅合成资料与受控模型、单无头Chrome，session41361实际exit0。回应／主动×明确确认／已确认澄清回答×关闭／新会话 **八个完整场景全部通过**，原5秒界面断言、HTTP23／25秒、gate60秒及150ms合并未修改。每场实际检查原SID与CURRENT、准备／执行同正文、晚完成不覆盖离开视图、原完整消息组恢复、确认后真实SSE仅提示且零追加候选模型。

实际日志 `/private/tmp/notalone-b09-confirmed-eight-page.log`；资源quiet57／active0／onscreen0／maxRegisteredApps1／policy2、browserCount1、cleanupConfirmed=true、electronRun=false、nativeAcceptance=false。自有子树RSS采样峰值为Chrome1056400KiB、Node232992KiB、后端196736KiB，共享页可重复计算，不宣称永久物理内存上限。进入与actualexit后940个运行源的SHA256差异均为空、HEAD一致；独立 `node scripts/test-pages.mjs --status`实际exit0／absent，八份随机`_test`数据库所有权记录逐名查询残留0。UTC13:20:12已完整释放；根另独立复核实际八场日志与freshstatus确认释放，没有默认第二Page。

原六条验收按证据逐项评估：第1–3条的未确认活跃探索、合并预算、确认／编辑后只提示由前文主树原十三场与既有编辑场支撑；本轮八场追加正式确认候选的公开证据。第4条的关闭／离开部分现已实际通过，退出等待晚prepare及真实受控quit仍在唯一A17合同接续，故此条与整票不能关闭。第5条继续沿owner/contact来源／删除原回归与本B29项HTTP检查；第6条命令、数据、失败历史与剩余工作已实记。六条原文字及未勾状态保留，`State: claimed`不变；本次结果不替代退出、原生App、人工或真实模型语义质量，后续B10／B11仍继续自主组合。

### soleJobs准备阶段的正式接续

消费 A 正式 `e94dfa2e` 的唯一准备阶段API后，本B新增原Main公开确认→真实prepare领取但回执在途的实际反例 **1 RED／2796.693208ms**：数据库已领取，原调用方却提前完成退出等待。最窄改为prepare发出前 `beginPreparation`，实际receipt到达后 `receivePrepared`，正式明确非候选结果才positive收口；原 `beginGenerationClosing` 返回真实Promise并等待异步HTTP中断。原同反例 **1 GREEN／3078.435042ms**，用实际 `/interrupt` 验证failed/app_quit及0候选模型，没有模拟原生Host。

消费后的原八关闭／切换与新晚prepare原文件共 **9 GREEN／29179.360708ms／skip0／actualexit0**；九份55/repeat0、instance/class及自有库清理残留0，实际合成模型共21。日志 `/private/tmp/notalone-b09-registry-nine-final.log`，命令 Conda NotAlone／`PGPORT=55441 node --test --test-name-pattern='B09' tests/assistant-generation-ownership-http.test.mjs`。正式六项registry Node在本B另实跑6G97.954583ms，类型检查通过。

原第1、2、3、5、6条自动条件按上述实际／明确引用证据勾选，原文字不改；第4条只完成离开／关闭及薄consumer晚prepare等待，整体受控Host退出／重开仍须唯一 A17正式集成验证，继续未勾、整票claimed。旧Page八场属于59c4冻结源，此新阶段九HTTP不冒充fresh Page或原生验收。

Root 主树按正式 `54d4b07e` 复验新晚prepare：初次测试名过滤未命中业务场景，只有模块包装层完成，未计为HTTP通过；核对实际名称后 `node --test --test-name-pattern='B09晚准备' tests/assistant-generation-ownership-http.test.mjs` 真正 **1 GREEN／4867.447167ms**，实际55／repeat0、模型1（探索）、候选模型0、真实中断failed/app_quit、自有库残留0。完整类型与diff通过；此项不是宿主或原生退出。后续执行失败phase和增强原target作业接口继续独立集成，原第4项未勾和claimed保留。

### 已确认候选实际失败后的手动重试入口

根从原B实现会话转交已正式test-only反例38行，本B仅净取该反例，不取其第二Main策略。正式`54d4b07e`前置的实际执行失败已在PG写failed，但整体公开phase仍waiting，导致策略控件禁用重试／更新；本人本树真实 **1 RED／3558.750792ms**，模型2／55repeat0／自有库0，日志`/private/tmp/notalone-b09-confirmed-failure-red.log`，原B本人3308.912167ms不借作本次计量。

只在唯一jobs已登记实际ownedGeneration的catch恢复公开phase：存在旧候选则ready，否则failed；原探索failed/canRetry、原任务／键／正文与jobs身份保持，不从失败HTTP推断零领取或终态。原反例实际 **1 GREEN／3867.213791ms**：同键同正文手动retry完成原turn／input／request键，turn数仍1，模型共3。随后原八关闭切换＋晚prepare＋失败重试完整 **10 GREEN／32718.236708ms／skip0／actualexit0**，模型实际共24，十份正式55/repeat0与instance/class及自有库残留0；日志`/private/tmp/notalone-b09-registry-ten-final.log`，完整desktop类型及diff检查通过。

固定source两路径补丁`/private/tmp/notalone-b09-confirmed-failure-source.patch` SHA256 `288f14666e19284e2f9608e3bcf74b33dd84f195db5d48bba598e3d5123188db`，A独立Standards硬要求0／新增重要Fowler possible0。此阶段没有Page／Host／原生／人工或真实模型验收，第4条与claimed按此前剩余范围保留；root最终唯一A17接线另行消费，不覆写其退出函数。

C独立Spec只读新增P0–P3为0，核实际ownedGeneration/current、原键／输入身份与未知元数据保留，未借本人RED/G／10项作为其自测。两轴完成后仅该3path本地提交；新增A15／B11文件不捎带。

Root 独立净接两代码路径后，实际公开 Main/preload→HTTP→隔离 PG 的原失败后重试反例 **1 GREEN／5259.600833ms／skip0／actualexit0**，模型实际3、55repeat0、instance/class与准确自有库残留0；完整桌面类型及diff通过。首个运行未激活Conda，被夹具在HTTP与建库之前拒绝，不计产品RED；激活NotAlone后执行原用例并取得上述真实结果。新来源竞态仍由B单独修复，未借此计为全部来源用例通过。

### 同命令关联的正式薄消费与三场通过（2026-10-12）

唯一A17正式 `6edadbc4a33a1de51b6175b0551af0e8831d4e58` 提供原Map严格五字段命令身份；本B登记源码完整字节与该正式版本相等，SHA256 `9b8cd124cda3c330f9c14922d9b74bc7c7030d4f41900c9f69762ee6bd4b8c92`。只关联同owner／contact／SID／generation及同task、input、action、suggestion、operation，且已结束传输、无key／receipt的旧准备；live、legacy、其它任务或operation及已有回执均保原停止身份。本人正式契约测试 **15 GREEN／109.749833ms／skip0**，不借供应方或Root十五项计为本人运行。

本B仅给既有StrategyJob保存一次本地confirmationOperationKey UUID，明确retry仍同job复用，新选择／directIntent／task重建job取得新UUID；answer沿原HTTP实际operation。五字段通过beginPreparation第4参交唯一Map，不把本地UUID、正文或bodyhash加到HTTP。原114行三个产品RED断言一字未改，实际 **3 GREEN／9912.748667ms／skip0／actualexit0**，模型2／3／1、三份正式55逐名／repeat0／自有库剩余0。可靠同receipt完成或严格同proof重放后closing零interrupt，后段公开投影全文和模型计数均实际达到，三capture closing_completed=true。

日志 `/private/tmp/notalone-b-confirmed-retry-ack-three-green.log`；默认temporary capture路径会随同标签运行更新，GREEN归属另复制保存在 `/private/tmp/notalone-b-confirmed-retry-ack-green-captures/`，此前RED日志及总协调已转交的原快照继续归原失败阶段，不把后来GREEN capture当RED原始文件。全桌面类型与diff通过，Main固定ONLY1 SHA256 `c41f6c6f673a8e9517ed35cb9bc046272e47c7951f57e86fe5e5c6a81b563e2c` 独立A Standards硬要求0／新增重要Fowler possible0、C Spec新增P0–P3为0，只读未借运行作轴自测。没有Map自建策略、普通生成／Host改动或Page／原生／真人质量通过；原第4条及claimed继续等待总协调最新全源集成的准确结果。

总协调独立命令关联验证：正式6edad唯一Map与e85唯一薄调用净集成，原三实际ACK丢失场3 GREEN／9694.099792ms、六实际受控模型、55×3重复0／三自有库清理0；原15Map契约GREEN／111.662667ms、完整类型通过。同冻结HTTP正文与真实回执／严格证明不变，仅关联已结束无回执旧身份；live、legacy、不同范围／命令保持失败关闭。此自动结果不替代真实App与最终公开组合，本票状态暂按原范围保留。

## Answer（2026-10-12策略38场后的原标准收口）

本票六条原标准的自动范围已满足，原第4项补勾，State改为resolved，文字不变。总协调固定687ac83a的reply-strategy-combination实际完整通过38场，其中有界更新14场、确认／已确认回答×回应／主动×关闭／切会话8场。旧36是准备阶段少计了两场，不能写成36场实际通过。最新Page归总协调，本人只引用其真实日志和receipt，不作为本人另跑。

| 原AC | 实际自动证据及范围 |
| --- | --- |
| 1 | 14场有界更新只在已明确打开、方向未确认的同联系人任务内运行；未打开／编辑／已确认时模型增量0。 |
| 2 | 真实SSE合并、三次预算、失败暂停、根TTL与断流后手动刷新；任务／输入／CURRENT及次数断言不改。 |
| 3 | 编辑关键回答或版本后仅提醒，确认及开始候选后停止自动探索；旧任务／旧问题／晚结果拒绝。 |
| 4 | 最新8场关闭／切换与本票原晚prepare中断实际证据；唯一Jobs／Main／BackendHost退出复用总协调受控36quit＋3carry共39GREEN／133135.8115ms和同命令ACK丢失3GREEN／9694.099792ms。实际receipt／六字段interrupt收口，无另一生命周期模型。 |
| 5 | 原owner/contact越权／来源删除负向和最新组／typed／C删除重连，普通日志无敏感正文，用户亲自发送边界保持。 |
| 6 | 本票原RED／GREEN与夹具前提错误、当前准确Page结果／命令／数据与剩余风险均保留。 |

第4项只证明本新增路径复用正式受控退出合同，不据此关闭仍claimed的A17真实App／C13验收。完整窗口、分组及清理归属见[R11最终收口](11-combined-strategy-acceptance.md)。真实App退出／重开、原生和真人语义未执行，不能借本票自动resolved声明它们通过；无额外业务模型、发送、OCR、微信、私人资料、push或部署。

## Answer

### 本轮自主协调最终结果（2026-10-12）

仅已打开且未确认的活跃探索有界更新，通知合并与次数／超时预算保持；确认后只提醒。关闭探索不取消已发候选；同冻结prepare ACK丢失3个原反例修复后主树实际通过。

剩余：本票可自主范围已完成。真实模型语义、自然度、关系适配及用户相似度未知；本轮没有原生App、私人资料、微信／OCR、外部发送或远端操作。

证据：[29票逐项结果与实际命令](../../unfinished-work/round29-autonomous-results-20261011.md)、[固定源码、自动验证及清理回执](../../unfinished-work/round29-autonomous-verification-20261011.json)。各次不同来源的计量分列，未把静态审查、合成模型或受控宿主冒为原生／真人通过。原验收文本逐行对共同基线保留；只更新实际可验收的勾选和State。
