# 07：固定范围的记忆提取与核验

Triage: ready-for-agent
State: claimed
Type: task
Parent: [同步、聊天清空与记忆处理规则](../../sync-memory-behavior/spec.md)、[SQLite数据库重建](../../sqlite-database-rebuild/spec.md)
Blocked by: [02 联系人绑定与同步授权](02-contact-binding-and-read-grants.md)；[05 统一来源删除与清理流程](05-source-deletion-and-cleanup.md)

> 2026-10-29已批准发布，未开始实现。[任务索引与共同约定](../planning.md)。

## 交付行为

用户点击开始记忆处理时，冻结当时已勾选联系人和已保存、尚未成功提取核验的有效文字目标，按联系人分别提取与核验，并登记同轮本人资料的真实贡献。关闭微信读取总开关时仍能手动处理这些已保存文字。本票交付提取、核验、结果与完整追踪，不把尚未执行的主题资料及长期概览阶段标成整轮完成。

## 验收条件

- [ ] 从正常记忆处理入口启动，原子固定本轮联系人、消息、实际来源、解释修订与原授权／资料代次；重复同一启动请求返回原轮次，不创建重复目标或调用。
- [ ] 本轮目标覆盖点击前所选联系人的全部合法待处理文字；已成功目标不重做，未完成项复用同一processing_item身份以防换轮重复；processing_task固定所属轮次，不跨轮复用或覆写旧执行，暂停／失败的手动继续沿原任务。点击后到达或补入的消息留待下一轮，不因时间较早而加入当前轮。
- [ ] 同步总开关关闭时仍可手动启动或继续有效保存文字的处理；不调用CLI补读，不处理未勾选联系人、非文字占位、已删除或身份未核验资料。
- [ ] 每位联系人的提取输入以 `owner_id + contact_id`隔离；本人阶段仅接纳本轮已选联系人经核验的贡献，不把多人的聊天拼成某人的关系输入，不扩大读取范围。
- [ ] 同一联系人允许使用点击前已保存的有界已处理前文；前文只作理解上下文，不创建重复处理目标或增加成功数量，不引用点击后资料。实际前文也纳入完整追踪与删除依赖。
- [ ] 使用正常提示词、工具与模型配置，发送前核验已有凭据、用途、最小文本范围及预算；准备、已发送、已知返回、失败与未知回执分别记录，未知状态不得通过换轮次盲目重发。
- [ ] 提取、解析、逐项来源语义核验及保存均有真实结果。协议或核验未完成、来源不足与正常无新记忆分开；不以候选条数代替执行成功。
- [ ] 正常提取核验结束但无值得保存的新记忆时，目标记为该阶段成功，界面明确“已处理，未产生新记忆”；再次启动不重复调用模型，不冒称全流程完成。
- [ ] 自动采纳只接受来源和范围均合法的结果，保留 `auto`来历、依据及可撤销路径，不标为用户确认；正式候选与记忆版本管理继续由08接续，不用本票绕过其裁决合同。
- [ ] 完整保存实际输入输出、阶段事件、调用关联及真实参与来源；实际使用子集与本轮可用固定集合分开，不把完整追踪降成无正文调用台账，不在普通日志保存正文。
- [ ] 取消联系人或删除来源后，相关提取／核验失去提交资格；其他有效联系人可继续。含该联系人的本人混合结果必须失效，不可仅删标签后提交成另一人的结果。
- [ ] 通过05清理目标、候选及过程正文、实际前文和传递依赖；仅有其他合法来源时按既有规则重新核验，不能替换旧执行的来源来保留旧证明，删除不隐式启动模型。
- [ ] 提取核验阶段进度、无产出成功、失败、未知与未完成后续阶段可从正常状态接口及界面区分；主题／概览未运行时整轮保持未完成。
- [ ] 隔离正常入口覆盖两位联系人和本人贡献、读取关闭、同请求重送、新消息到达、来源删除及旧回调晚到，证明不串人、不扩大固定输入、不重复成功目标且删除后不能回写。

## 验证与证据

沿正式认证业务接口、真实存储和Worker完成隔离合成资料的正常路径，并通过具名桥与真实记忆页面观察阶段反馈；只替换外部供应商及确定性时序边界。先最小单例，再相关提取／核验／追踪／删除模块，记录模型替身、配置差异、实际命令和资源收尾；不得使用直接插入成功记录代替正常入口。

验收依据为父规格的固定输入、手动处理和来源清理规则，以及统一设计中的处理轮次、目标、输入、执行事件和实际来源合同。真实语义质量另按已有模型与明确资料授权验证；本票的合成行为证据不能认证当前微信渠道。

## 范围与执行门禁

- 本轮仅发布任务，不启动实现。`ready-for-agent`表示任务信息可供后续处理，执行仍须用户另行明确下达实现指令；本任务不授权读取私人资料、调用模型或切换／清理真实业务库。
- 适用[实施索引公共约定](../planning.md)和两份父规格；数据库实体、键、状态及事务以[唯一统一设计](../../sqlite-database-rebuild/greenfield-design.md)为准，不采用早期讨论稿的并行结构。新增敏感资料及本人跨联系人依赖均接入[05来源删除与清理](05-source-deletion-and-cleanup.md)，不能只靠隐藏或移除单条引用声称已删除。
- 后续开发只用 `pnpm run dev`，先执行 `dev:status`核验并复用实例；不得擅自打包、运行旧包、修改发布门禁、推送或创建远端分支／PR。
- App首次使用继续搁置；组件安装、新模型设置、干净机器和发布、微信迁移／恢复实验均不属于本任务。不新增模型或凭据入口，沿现有配置核验用途与最小文本出站授权。
- 合成结果与真实模型、真实微信、产品集成分别记账。当前未核验的真实账号／联系人读取范围不可读取；不发送外部消息，不把开发验证能力加入产品工具。


## Answer

2026-10-29实施中，State保持claimed、Goal实际active。02/05指定依赖均已用merge-base核验进入bc7fb905基线；11的真实producer/FK小合同已按总指挥指令逐项实际取入。本票没有领取其他任务，未改统一索引。

已落受版本管理的领域实现：

- `backend-ts/src/memory/sqlite/`提供原子固定run/contact/message/record/解释修订、跨轮processing_item、固定任务/小批及手动暂停继续、独立本人producer、实际输入顺序和完整载荷追踪。模型侧复用正常E/V提示、complete-claim-v1与唯一ModelHost；HTTP只收具名启动/控制和读取，不接owner、SQL或任意输入。
- `verifiedExtractionOutput(tx,{ownerId,eventId})`供08同事务复验后建立正式候选，保留auto与真实producer/来源；07没有写正式记忆版本或文档发布。本人阶段用既有execution_input的typed阶段事件输入，不新增并行产物身份；调用复用已收敛为execution_event.reused_call_id。当前新增工厂均未由总指挥发布，最终编号串行集成，v1–v5未改。
- 删除域只负责extraction/verification，显式authority与requiredDomains通过05唯一服务装配。固定窗口、实际前文、本人混合阶段和活动调用均入闭包；单来源清理保留封存无正文台账及未知效果占用，换合法来源/新run不能盲重发；联系人/账号删除再清对应最小台账。discussion_calls由11独立负责，不重复实现。
- 独立桌面shared/main/preload/renderer模块已落；读取拒绝、失效通知、卸载/旧连接迟到回调均撤下候选和过程正文。unknown仅封其任务，其他失败/暂停任务可沿原run继续。

实际验证（全部隔离合成资料，真实供应商小批另列）：

1. 首份共享DDL真实Worker迁移/重开1/1、共享memory/reply producer结构与越界约束原2/2；后端领域相关19/19及typecheck已通过。依次补齐并验证旧失败轮重做、实际presentation顺序、成功attempt复合FK、合法call复用及并发效果占用、unknown经来源删除换源重发、公共认证失败暂停等审查反例。新反例均有实际red→green；仅复跑受影响文件/用例，不反复全量。
2. 官方DSH+真实SQLite Worker/accounting+认证HTTP+正常模型端口的全链单例通过，含读取关闭、同key不重复、无产出成功及实际派发未知后原任务继续/新轮不重发。唯一替换外部供应商为环回SSE和合成渠道；复用sqlite.patch，仅替测试宿主并补当前缺少的公开llm服务，模型/预算/期限未降低；不冒充正式宿主已接线。
3. `node --test test/sqlite-storage.test.mjs test/sqlite-private-history.test.mjs test/sqlite-deletion.test.mjs test/sqlite-host-launch.test.mjs`：49/49。桌面具名控制器及真实无头Chrome组件测试最终6/6、桌面typecheck通过；实际App尚未运行。
4. 精确只读现有backend-launch.json配置指针，正常解析器确认deepseek-flash配置可装配、凭据存在，未打印或复制密钥。真实供应商隔离合成小批固定问题预算2次/10分钟；已预留1，调用已知failed，无E/V语义结果、成功目标0/2、候选0。旧追踪未保留安全错误分类，实际HTTP次数、token实耗及具体失败原因未知；独立Agent确认不能认证语义质量。已以unknown结案，未重发/加预算/改模型设置。后续代码已保存稳定错误code/status，环回真实DSH 401反例验证不复制异常原文并可区别已观察HTTP与未知。此限制不写成模型可用或微信认证通过。

待完成：公共sqlite-host/llm/关闭生命周期、具名桥聚合与真实MemoryPage的最小接线由总指挥串行安排；随后必须使用pnpm run dev的实际App进行固定进度、未知/失败、删除或资格失效后的本地快照撤下验收。当前未获得桌面占用，未启动/重启/抢焦点，dev:status只读核验为stopped。完成该必要验收及最终独立复核之前不resolved、不Goal complete。

数据与资源：只用临时role=test库、合成身份/正文、环回服务；真实供应商小批也仅两条固定合成文字。未读取私人微信或PG、未发送/撤回外部消息、未改私人配置、未打包/push/PR。正常测试等待调用、ModelHost和SQLite排空并清精确自有根，真实小批报告和无正文预算仅留仓库外私有目录，未提交正文/凭据。

共享合同合并检查点：以a5a039cce318d1d00392179f90f9639fd08cc979为07审查修复父提交，合并11源HEAD 0bd50ee395fd34232a1d4aeb9699846e89824feb，保留双方提交祖先。完整前置包含07的5cee7977、d0a179f6、f7c33de7及11的c4abb800、8ff58327、5fd60ca4、0bd50ee3；不要求额外未提交helper。冲突保留07最终typed本人产物、reused_call_id、未知占用与桌面修复，采用11最终请求/副本schema及discussion_calls实现；旧owner-schema/self_contribution未回流。该检查点当时的源码测试暂号已由后续根f30b9016替代：现实际使用media6、discussion7、memory8、execution9，已发布1–9不再改写。

本检查点验证账：后端pnpm typecheck通过；共享producer与组合删除7/7；记忆核心/来源删除/本人/官方DSH全链18/18；11的DSH、generation、integration、来源holder和通用删除54/54，讨论HTTP及副本删除另8/8。54项中两项最初因测试遗漏显式来源删除注册失败，改用现有history fixture后仅补跑该文件2/2，不隐瞒初次失败或重复全量。组合删除的直接合成种子仅证明结构和删除分支，实际DSH结果由独立正常业务用例证明。相同源码/配置/依赖可复用这些证据；迁移组合次序、公共宿主、模型adapter/许可生命周期、HTTP或桌面接线变化后需补相应组合验收。真实供应商语义质量和实际App限制仍如上，不随合并变为通过。

合并提交77ea66c20c2280ddef4b1db41e259bff716c2e98公开历史检查0项；双轴复核中Spec无新增问题，Standards发现讨论producer预留始终0且未结算实耗。正常DSH/SQLite返回与连接中断两例实际red后，补provider最终测量到具名dispatch、冻结模型/配置上界、成功按官方互斥TokenUsage结算、unknown保留预留及NULL实耗；相关31/31与后端类型通过。独立Standards复核2/2通过并确认该P2关闭；没有追加真实供应商调用。该修复不改变DDL或公开HTTP输入，11后续turns/generation接线需保留最终budget传递。

后续证据补强：官方DSH全链新增正产出测试，保持正常模型、预算、期限、提取提示及complete-claim-v1，只替合成渠道和环回供应商。实际观察两次Messages提取、两次strict Chat Completions核验，4个目标成功，2条contact及2条self auto/verified_pending_decision产物；逐项语义核验、同run同payload的typed本人贡献、完整追踪、无正式memory写入、同key不追加发送与关闭排空均通过。子进程code0/signal null，业务根及自有profile目录确认删除。此合成证据不改变真实供应商质量、微信认证和实际App未完成结论。

共享宿主装配补强：提取端口可注入宿主唯一provider，保持同一ModelHost许可、预算和范围检查；只有自行安装的provider才由端口close释放。新增实际反例先因同名adapter重复注册失败，修复后证明临时端口关闭不影响原端口继续派发。端口与正产出全链合并检查4/4、backend类型通过；未知之后的新scope探针曾被保守占用阻止并触发测试期限，探针已移至未知之前，生产未知规则未放宽。独立双轴复核未发现新增问题。公共宿主仍须选择共享装配路径，独立createSqliteMemoryRuntime不能再与同名adapter并装。

关闭收尾的3个真实反例均先red后green：重复close原先提前返回、start前置findRequest读取在途时close未等待、claim事务已完成而返回晚到时关闭后仍调用模型一次。现close缓存同一Promise，跟踪并等待initialize/start/continue/pause已受理操作；异步边界重验stop，晚到claim对应controller先abort，再沿正常失败/holder finally收尾。独立双轴复核均0新增问题；backend类型与受影响记忆服务、HTTP、E/V、本人、来源删除、模型端口及正常DSH测试27/27通过。正产出审查另补contactId与对应正文配对断言，不仅比较无归属正文集合。公共宿主、真实MemoryPage和实际App验收仍未完成，没有因此提前勾选验收条件。

公共装配按11约定提供`createSqliteMemoryRuntime(options.sharedModel)`，窄值为`{configuration,provider,permit,resolveUserId}`：不建共享host/arbiter/身份目录或adapter，不shutdown/dispose共享实例，仅排空本service；正常配置由11安全读取既有env文件后一次解析并注入。未注入时只保留独立测试工厂路径。runtime归属单例先red重复注册后green，初次失败的测试hook收尾顺序有误导致悬挂，核实并终止精确自有测试进程后改为先关闭runtime和10秒期限，未触碰开发实例。回执合同本身没有purpose字段，不假造；用途沿真实operation producer，07未知回查只extraction/verification，真实discussion未知反例先red冒领后green。未再调用真实供应商，env路径未加载只能是待查假设，不能据此改写此前失败原因。

已按总调度要求保存共享注入732ace18d89babd82fe9bef860cabfefff3cfdaa后，实际merge根f30b90161e8b70fd7f6741ff6fc7518a5b209776，无冲突；包含16 media6及已发布的discussion7/memory8/execution9。逐文件git diff核验全局registry及所有迁移定义与根一致；最终组合补backend类型和共享producer/删除、runtime注入、官方DSH全链10/10通过，未重复条件未变的27或31项。共享model包完整祖先为15e4637c→b73ab249→732ace18，再与f30根合并；11成熟父合同0bd50ee3已在前置merge中。仍无正常App记忆页接线/实机证据，State与Goal未完成。

11公共关闭接线发现原runtime永久缓存关闭reject，导致保留SQLite后不能重试释放；沿调用链确认service和自有model-port也有同类缓存。现仅在失败catch清closing后重throw，成功仍缓存，stop/AbortController继续有效，不恢复业务接收。runtime、service和自有adapter释放失败的3项反例均实际red→green；相关close/runtime/model-port三文件8/8和backend类型通过，未重跑整套。首轮失败反例的after hook抛错阻断了fixture清理，现测试收尾捕获预期错误；终止精确自有测试进程后，以lsof无活动引用与database_instance.role=test核验清理了其精确临时根，未碰开发实例或私人数据。

同次独立复核进一步发现自有host的嵌套关闭缓存：业务dispose失败会被ModelHost.close永久记录。新增真实owned ModelHost/provider反例先red，再将记忆runtime自有路径调整为arbiter.stop→service.close成功→ModelHost.close；共享路径仍不持有host关闭能力。现在同一runtime可重试业务释放，业务停止状态不恢复，成功关闭复用；相关三文件最终9/9与类型通过，双轴复核均确认原发现关闭。没有修改公共model-host.ts；该模块自身socket/journal关闭失败不在此次证据范围，未声称已验证或修复。

MemoryPage聚合前补齐具名readMode：主进程沿已认证/api/runtime/status及连接代次读取，只接受running/dsh/typescript，明确storage=sqlite走固定处理，当前PG缺省storage映射legacy，其余拒绝并撤下快照。preload/main均不接renderer模式或额外参数，只返回模式和连接代次，不外泄运行状态其他字段。两新增反例red→green，原controller/panel加新case最终8/8、桌面类型通过，双轴复核0新增。这里只提交07自有shared/main/preload及测试；正常MemoryPage、公共IPC汇总和实际App仍等11正式profile及桌面窗口，未把桥接测试当实机验收。

按调度要求仅复查既有私有报告与预算账本的安全元数据：2目标、0成功、0候选，1条extraction调用记录为failed，预留406310单位、实耗未知；存档未保存dispatch及完整receipt，只有model_input/extraction_recovery各1事件，不能证明实际HTTP次数或具体供应商失败原因。模型必需配置与预算profile字段缺项均0，不等于认证成功或实际出站。诊断账本max_calls=2、used=1、streak=1，轮次outcome=unknown；按实现的秒级deadline核对已过期，有效剩余预算0。此次只读，没有读取/输出凭据或正文，没有新请求/新预算/重试，后来的env加载修复不能反推旧调用。

独立MemoryProcessingEntry已按认证mode挂载固定Panel或既有页面，pending/失败/断连不挂正文，render同步scope fence及revision阻止旧模式回写。独立Spec实际用真实controller+React发现联动P2：替代mode请求会被旧Panel卸载时release取消；先补controller及Chrome联动red，再把正文释放与mode取消域隔离，synchronize仍同时撤两域。当前controller6/6、Entry真实React+Chrome6/6及桌面类型通过，Spec复核关闭该P2。这里只是独立入口准备，后续正式MemoryPage聚合与实际App仍须完成。

正式前端检查点：按总指挥分配的公共前端窗口，实际合并根af98a3ba，接入main/preload/AppBridge与真实MemoryPage；保留11讨论、媒体及关闭协调。联系人scopeRevision、来源删除started、连接准备及退出均立即synchronize。SQLite只挂固定处理面板，PG经认证模式才挂既有页面；来源或资格失效撤下候选与过程正文。公共后端host/profile/config由03持有，本轮未修改；已发布迁移及registry与af98完全一致。

本轮桌面pnpm typecheck通过；既有真实MemoryPage主卡单例1/1、新真实MemoryPage固定处理及失效单例1/1通过，后者使用正式React页面与控制器，仅替换合成网络。Standards/Spec独立复核均0新增。补登记本票4个桌面测试（controller为safe-node，其余3个为headless）；test:inventory仍被根基线遗留的19个其他票未登记测试拒绝，未执行那些测试、未改其分类。af98原有21项缺登包含本票2项，此次已补齐；不是分类检查通过。实际App未运行，桌面仍由18占用，后续正式profile合成流程与实际App验收继续推进，State保持claimed、Goal保持active；真实供应商质量限制仍如前，不重试或续期旧预算。

正式profile增量证据：新增sqlite-memory-profile.test.mjs，正常contacts/history准备两联系人4文字并停读、真实关闭准备者Worker后，launchDsh加载原sqlite.patch和真正sqlite-host-plugin（运行profile逐字比较，不替换业务插件）。只在测试node包装器将两个固定官方供应商URL转本轮127.0.0.1、认证限定synthetic-only并拒绝其他出站。正式共享ModelHost、认证HTTP及Worker完成2次提取、2次strict逐项核验，4目标成功、4条auto待裁决输出、同key仍4次实际环回请求；本人贡献复用同轮同payload阶段事件，无第二次模型调用、正式记忆行0。正常配置、输出上限、上下文与安全余量不缩减，输入、候选及完整过程来源按准备时独立message/record映射配对核验，不只比较正文集合。

该单例最终1/1、约1.54秒；backend pnpm typecheck、4文件node --check及空白检查通过。首次10秒超时因目录watch未唤醒，改监听自有WAL后通过，是测试监听问题而非生产red→green。独立双轴发现的候选归属断言缺口及清理fetch无期限均已补齐，复核关闭；正常API期限3秒、清理请求2秒后继续有界退出/终止。正常shutdown后握手、锁、profile home、唯一模型socket均消失，同库重开integrity/FK通过，自有临时根清理。另提供prepare-memory-desktop.mjs，只准备合成库及环回供应商、绝不启动App；其3种供应商边界冒烟不计为DSH或业务证据。实际App仍待调度，旧真实质量失败独立保留，不作为新增外部调用前提。

实际开发入口的测试网络边界另提供test-only CJS父预加载器：正常pnpm run dev可经NODE_OPTIONS装入，按私有本轮plan、test角色、数据库、项目/env/info、父PID及固定DSH参数核验唯一子进程，只插入既有network guard及两个合成字段；不替换业务插件或profile，不改模型预算、stdio和寿命管道，普通子进程透传。新增纯Node用例4/4与两文件node --check通过（补校验前错误executable及business角色曾未被拒绝），双轴复核0新增；safe-node已登记，本次未运行Electron/App/CUA。预加载/spawn收据只证明边界拦截，后续仍需真实开发App加载及业务验收，不能把该4/4算作App通过。
