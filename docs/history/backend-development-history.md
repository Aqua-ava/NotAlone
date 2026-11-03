# 后端与入口文档开发历史

本文件保存从模块入口移出的阶段记录，整理日期为 2026-11-03。段落保留原记录的时间、前置和限制；“当前”“本轮”“已验证”均仅指原记录时点，不能据此运行旧方案、认定现版本通过，或恢复已被后继决策替代的默认行为。当前规则从[现行架构](../../architecture/README.md)与[后台入口](../../backend-ts/README.md)读取。

旧 Skill 单包限制、手动启用默认以及候选生成前恢复来源的等待路径均已被现行规格替代。本轮只整理文档，未重新执行下列历史验收。

## backend-ts/README.md

来源：[backend-ts/README.md](../../backend-ts/README.md)；原段落位置如下。

原第 57 行：

已有迁移采集记录为 96/96 成功、96 次物理调用、0 重试；回复盲评及启动／RSS 对照已跳过，不能称为质量或性能验收通过。该历史迁移中的实际 App、合成 HTTP／PG、模型和发行验收分别记录，不以单项成功替代完整集成验收；上述采集未执行打包。

原第 59 行：

持久助手会话的独立开发验收见 [ADR-106](../../architecture/adr/106-persistent-assistant-conversations.md)：已完成隔离合成回归、实际热更新桌面矩阵和较早版本正常配置下的四次真实模型请求。固定配对样例未见目标质量退化；合成性能对照中首次准备未见稳定减少，续用准备较低，完整调用墙钟上升；用户已接受该次毫秒级差异。后续事务修复未重跑性能对照，不能宣称整体提速。这些结果不改变上面的历史迁移采集结论，也不构成发布包验收。

原第 61 行：

集成提交 `bf4b7fbe` 的默认全量测试中，后台 970 项通过；桌面 1033 项通过、1 项因缺少既有发行夹具而跳过。跳过项未通过打包或运行发行版补验。

## backend-ts/src/history/sqlite/README.md

来源：[backend-ts/src/history/sqlite/README.md](../../backend-ts/src/history/sqlite/README.md)；原段落位置如下。

原第 17 行：

本次实际制品的三值证据在 `support-profiles/wechat-4.0.6-29387.json`；该静态档仍unverified且不能自动替代运行时匹配，详见docs/verification/sqlite-private-history-support-03.md。

原第 24 行：

公共接线已有正式 HTTP 与 launchDsh/profile 合成验证：无消息／goal 预植，正常授权后自动首次入库，持久开关下启动自动派发；未知支持零 target/page 并显示最新受阻原因。状态只覆盖显示层错误，不伪造持久 goal、完整覆盖或正文可用性。实际 App 的消息、覆盖及删除后正文撤下仍需独立桌面证据。

## backend-ts/src/media/sqlite/README.md

来源：[backend-ts/src/media/sqlite/README.md](../../backend-ts/src/media/sqlite/README.md)；原段落位置如下。

原第 11 行：

文件API依据：Node v24官方fs文档 https://nodejs.org/docs/latest-v24.x/api/fs.html ，使用本机v24.19.0的open(O_EXCL/O_NOFOLLOW)、FileHandle.write/sync/stat、statfs及受版本管理的ManagedFiles身份校验。实现与实际验证证据由16任务Answer记录。

原第 27 行：

公共接线已核对安装及锁定DSH 0.2.1-rc.2、Cordis 4.0.5、dsh-cmdline 0.2.1-rc.2；沿官方profile与已有ctx.effect资源释放扩展。官方参考commit 687f282e8625c6b8d11ff58211a90524be2e4317的docs/cordis-primer.md，安装Cordis lib/index.js:1169的effect按逆序等待异步disposer，dsh-cmdline lib/index.js:50的exitOnStdinEnd只请求appReady后的退出。未改框架核心、模型、Tools或新增profile替身；制品与参考源码逐字构建等价仍未验证。

原第 7 行：

三实体迁移导出 `mediaMigration(version)`，正式registry已分配版本6。删除复用05同一账本；安装时使用 `composeMediaDeletionRegistration(base)`，media域在history/identity前，requiredDomains显式包含media；media独立清除只推进自身代次。正式DSH宿主、具名桌面桥及聊天行页面已经串行集成并验收；真实渠道和类型适配器仍由17/18认证。

## backend-ts/src/media/visual/README.md

来源：[backend-ts/src/media/visual/README.md](../../backend-ts/src/media/visual/README.md)；原段落位置如下。

原第 15 行：

第三方API依据：本机Node v24.19.0及锁定 `@types/node 26.6.4`，已核对 [Node 24 crypto](https://nodejs.org/docs/latest-v24.x/api/crypto.html) 的createDecipheriv/update/final及默认padding合同。未新增npm依赖；上游MIT完整告知见 `WX-CLI-LICENSE.txt`。原生helper的编译、限额和支持矩阵见仓库 `native/media-validation/README.md`。

## backend-ts/src/memory/sqlite/README.md

来源：[backend-ts/src/memory/sqlite/README.md](../../backend-ts/src/memory/sqlite/README.md)；原段落位置如下。

原第 13 行：

本合同初次仅证明DDL与存储重开；业务、删除和桌面证据在本票Answer按实际执行补齐，不能把结构通过当作渠道认证。

## backend-ts/src/memory/sqlite/management/README.md

来源：[backend-ts/src/memory/sqlite/management/README.md](../../backend-ts/src/memory/sqlite/management/README.md)；原段落位置如下。

原第 11 行：

当前测试仅覆盖合成供应商正常07输入及真实SQLite管理/删除事务；真实供应商语义质量、实际App和宿主组合以任务08最终Answer为准。

## backend-ts/src/reply/sqlite/README.md

来源：[backend-ts/src/reply/sqlite/README.md](../../backend-ts/src/reply/sqlite/README.md)；原段落位置如下。

原第 39 行：

当前后台组合已用真实SQLite Worker、07共同producer、官方DSH/Adapter、环回SSE及真实受管目录验证；无SQLite业务端口替身的正常/重开/Skill/来源/账号/在途取消与故障窗口见sqlite-discussion-integration.test.mjs。早期driver/generation测试中的业务端口替身仍只用于局部机制，不冒充正式profile、外部模型质量或实际桌面验收。公共宿主、桌面页面及受控外部模型验收继续单列记录。

原第 55 行：

正式launchDsh/profile已验证两个合成联系人、非空用户发言、隔离、新开、明确继续和重开不调用模型；共享模型装配、关闭失败恢复及实际桌面控制器均有独立回归。实际App和受控外部模型验收继续单列，当前证据不等同产品整体或真实渠道质量验收。

原第 60 行：

原小节：2026-10-31：DSH 回复 Skill 接入验收

原第 62 行：

四项本地任务已组合完成：受控发现与读取、官方工具自动选择、读取失败安全继续、同修订静态资源读取。新包在管理页先显示目录名和待启用状态；明确启用后建立首个有效修订；已启用包自动技术更新，停用保持。SQLite 沿用原结构版本，没有迁移真实资料或改动用户 Skill 原目录。

原第 64 行：

自动检查使用 Node v24.19.0，DSH 固定 `0.2.1-rc.2`：

原第 66 行：

- 后台相关最终命令：`node --test test/sqlite-discussion*.test.mjs test/sqlite-reply-candidates*.test.mjs test/sqlite-reply-skill-loop.test.mjs test/sqlite-skill*.test.mjs test/skill-files.test.mjs test/sqlite-host-launch.test.mjs`，152/152 通过；后台与桌面 `pnpm run typecheck` 通过。

原第 67 行：

- 桌面相关命令：`node --test tests/sqlite-reply-candidates.test.mjs tests/sqlite-reply-candidate-bridge.test.mjs tests/development.test.mjs tests/sqlite-development.test.mjs tests/fixed-memory-development-network.test.mjs`，27/27 通过，包括真实 React、无头浏览器和 IPC 边界替身。

原第 68 行：

- 后台完整 `pnpm test` 曾执行 1090 项，1054 通过、36 失败。35 个失败已在任务前固定基线 `ae5ae36a` 的隔离工作树复现；另一项为本次自动发现语义改变后的旧宿主断言，已修正并纳入上述最终通过检查。基线只重跑对应 9 个文件，75 项中 40 通过、35 失败，工作树已清理。

原第 69 行：

- 桌面完整 `pnpm test` 在测试分类检查被既有 `sqlite-first-session-regression.test.mjs` 未登记挡住，未声称全量通过。该文件及缺登记状态均存在于任务前基线；本次未修改它们。

原第 71 行：

Computer Use 实际操作隔离的 `pnpm run dev --user-data-dir` App，使用正常 SQLite/profile/模型参数，仅供应商由严格网络守卫重定向到环回合成 SSE。确认 Electron 自身的 preload/spawn 守卫收据后，检查自动正文、正文后辅助资料、无 Skill、读取失败继续及提示；通过输入小窗生成并手动编辑保存候选第 2 版。另通过管理页验证自动发现、明确启用、修订 1 自动更新到 2、停用及刷新后保持停用；查看了实际布局与编辑控件。最终降级候选没有旧的恢复受阻误报。共 10 次合成物理请求，网络审计同为 10 条；无真实模型、微信正文读取或外部消息发送。

原第 73 行：

独立 Standards 与 Spec 两轴审查的问题均已修复并复验，最终各 0 项未解决。补充回归覆盖 helper 不可用、120KB 合法资源、100 个资源/深目录/低 FD、provider 打开前与 Agent setup 时失效、部分加载后失效、授权撤销、取消、逐次用量、清理中断恢复，以及来源/联系人/账号删除接管技术清理。全部临时运行只来自合成资料，原授权与人工发送边界保持。

原第 75 行：

限制：本机原生只读器验证范围为 arm64/macOS 15；未制作或运行发布包，未验证其他平台或真实模型回复质量。实际 App 的消息提醒仍因合成环境未连接真实渠道而显示中断，该状态不影响本次受控回复验收。

## backend-ts/src/reply/sqlite/candidates/README.md

来源：[backend-ts/src/reply/sqlite/candidates/README.md](../../backend-ts/src/reply/sqlite/candidates/README.md)；原段落位置如下。

原第 7 行：

候选准备遇到实际聊天来源失效时，正式宿主仅对本次引用的来源联系人恢复一次读取状态，总预算15秒；明确继续旧选稿时也只核其实际来源。来源服务复用活守卫，或等待已有读者后仅核验元数据，不读取历史页。恢复后重新读取并冻结材料；停读、撤销授权和真正来源变化仍拒绝，出站和保存前继续原子复验。没有聊天依赖、关闭关系背景和原请求回放不会因此新增读取。恢复不挂在反复执行的授权回调中，也不由列表刷新触发。

原第 9 行：

准备阶段恢复失败记为 `reply_sources_not_ready`，完全没有模型调用时可明确重试；来源修订改变也能安全结束原准备任务。页面显示“聊天读取暂未恢复，请重试生成。”，仅保留用户独立输入，撤下旧候选、依据及携入内容。是否可重试以权威请求状态为准，未知模型结果仍只核对原请求。

原第 11 行：

2026-11-03 性能核对：同一只读快照、同一组 50 条冻结来源，三次旧全局检查为 1625.63／1437.88／1423.88 ms，定向检查为 1.66／0.93／1.09 ms，来源不可用的判断一致；这是失效检查路径的局部对照，不代表整轮生成耗时。正常 `SqliteReplyTurns.generate` 在真实 SQLite、DSH 和环回合成供应商下，三轮受理到供应商收到请求为 123.8／25.4／23.8 ms，每轮一次物理请求；该组合仅一条聊天、空 Skill 目录且不含初始化，不认证真实网络或模型速度。

原第 25 行：

当前合成证据：`test/sqlite-reply-candidates.test.mjs`，外部渠道与供应商为明确本机合成边界，SQLite/历史服务/官方DSH/provider/arbiter/文件均为真实实现。认证HTTP及正常官方profile端到端已有独立合成回归，实际开发App完成生成、多条编辑、固定版本选稿、原版回看、重开与联系人切换；实际Skill停用后旧草稿、候选、依据及Skill快照共同撤下，权威重读不恢复。实际07→08发布→12读取→05跨联系人来源删除，以及08人工建立／修正／保护→12旧选稿失效已通过最小组合；这不证明08自动关系裁决已经完成。09正式文档写者组合仍是20切换前门禁，真实外部模型质量未验证。

## backend-ts/src/skills/sqlite/README.md

来源：[backend-ts/src/skills/sqlite/README.md](../../backend-ts/src/skills/sqlite/README.md)；原段落位置如下。

原第 29 行：

2026-10-29 的合成包管理页 App 验收是历史证据，覆盖启停、核验、目录缺失、身份冲突及重开持久化，不证明当前已取消的手动添加入口仍可用。当前界面与自动发现的验收以本轮任务记录为准；历史验收未读取真实微信或调用模型。

原第 61 行：

安装包无gitHead，未完成固定源码树对npm制品的全量可复现构建比对；本次只核验所用公开合同及实际安装行为。`sqlite-skill-profile.test.mjs` 复用正式patch，通过官方CLI启动隔离profile，仅替换业务宿主认证／追踪和模型配置（本机环回假地址，无模型请求）；`sqlite-host-launch.test.mjs` 验证实际 SQLite profile 的认证管理、关闭及重开。实际 App 证据只覆盖上述管理行为，不覆盖真实模型、微信或完整回复链。

原第 69 行：

本轮核验 `dsh-skill` 声明、安装锁及实际制品均为 `0.2.1-rc.2`，Cordis `4.0.5`；官方参考仍固定 `687f282e8625c6b8d11ff58211a90524be2e4317`，本机相邻源码 HEAD 不同，未完成全量可复现构建比对。官方 filesystem 的发现 `discoverRoot` 会对每个子目录调用 `parseSkillFile`，服务缺失/`trustedHost` 有 Node 分支，watcher 独立接触宿主路径，不能只凭返回目录过滤满足读取前边界。因此正式产品继续使用官方 registry 的业务 `registerProvider`，不装配 filesystem/default roots/bundled roots/watcher；刷新与每次读取复验承接变更处理。本轮测试证明这一替代路径，不宣称已经验证自定义 `ctx.fs` 生产组合。

原第 71 行：

合成验证命令及边界见任务 01 与原生只读器说明；自动选择、失败降级、资源加载和实际 App 的最终验收由同组任务分别记录。

## backend-ts/src/storage/sqlite/README.md

来源：[backend-ts/src/storage/sqlite/README.md](../../backend-ts/src/storage/sqlite/README.md)；原段落位置如下。

原第 39 行：

实际安装锁定 `@types/node 26.6.4`，实现只使用 Node 24 已存在的 `DatabaseSync`、`prepare/run/all`、`setReadBigInts`、`isTransaction`、`close` 与 `timeout`。已读取官方 Node 24 SQLite 文档（https://nodejs.org/docs/latest-v24.x/api/sqlite.html），并以当前 Node v24.19.0 和实际开发 Electron 的 Node 分别验证；确切 Electron/SQLite 版本及验收结果写入任务 Answer。未修改 DSH、官方 profile 或模型接口。

## backend-ts/src/storage/sqlite/deletion/README.md

来源：[backend-ts/src/storage/sqlite/deletion/README.md](../../backend-ts/src/storage/sqlite/deletion/README.md)；原段落位置如下。

原第 60 行：

Node v24.19.0实际运行，fs的lstat/unlink/rmdir/fsync与SQLite维护参照[Node24官方fs文档](https://nodejs.org/docs/latest-v24.x/api/fs.html)及底座01合同。声明、锁定及本工作树安装的DSH agent/agent-loop/session-persistence为0.2.1-rc.2；已核对公开AgentHandle.dispose、SessionHandle.close及安装agent-loop实现1703–1730行的cancel/whenIdle/scope.dispose/handle.close顺序，固定官方源码依据为仓库DSH流程所列687f282e8625c6b8d11ff58211a90524be2e4317。不声称npm制品与源码逐字对应。05没有新增DSH调用或改官方profile；合成close替身仅验证持有者协议，真实非空DSH副本接入由11验收。

原第 34 行：

`http.ts`导出生产`SqliteDeletionHttp(service,ownerId).handle(req,res):Promise<boolean>`，未匹配时返回false。必须置于02共用的唯一Bearer/Origin认证后；无需新后端。沿用`DELETE /api/contacts/:contact/sources/:source`（空正文）、讨论删除（confirmed）、联系人删除（confirmed及confirm_contact_id）、账户删除（confirmed及confirm_scope=account）、`GET /api/deletions[/:id]`、`POST /api/deletions/:id/retry`和来源`GET /api/tasks/status?contact_id=...&task_id=...`。请求不能提供owner、目标SQL或内部复核；公开状态只返回最小进度，完成后不返回目标身份。source删除回task_id，状态符合现有来源控制器；后续来源目录仍由实际写者提供。没有新的媒体泛化HTTP范围，媒体16继续自己的明确操作。隔离HTTP测试复用生产适配器与真实临时SQLite，外围仅替换为固定合成认证；正式开发宿主与实际App另以隔离合成账号完成联系人/账号删除和刷新验收，不将它扩为尚未安装写者的验收。

原第 38 行：

共用宿主仅对`GET /api/deletions?contact_id=...&scope_kind=discussion`及`GET /api/tasks/status?contact_id=...&task_id=...`放行严格查询形状，其他查询继续拒绝。公开操作状态的checks只包含种类、领域、结果和有限机器证明，不返回路径、文件身份或正文。正常DSH握手位于`managed/sqlite-backend.info`，不放进数据库辅助文件目录；运行中的账号删除已验证实际checkpoint/VACUUM及公开页/WAL复核，未知文件检查没有放宽。

## reply-skills/romance/README.md

来源：[reply-skills/romance/README.md](../../reply-skills/romance/README.md)；原段落位置如下。

原第 28 行：

原小节：本轮验证

原第 30 行：

2026-10-31：92 个包通过产品实际解析及内容安全校验；128 段方法和 89 段单列示例均与登记原文一致，39 个源文件符合独立锁表，零告警。

原第 32 行：

2026-10-31 中文适配：为 33 段锁定英文摘录登记来源绑定的中文译文，渲染至 21 个 Skill 正文或案例；`romance-001-first-contact` 的方法、示例和常见回复均以自然中文呈现。原文快照、引用行号、英文 Skill 名称及包目录身份保持稳定。

原第 34 行：

来源约束的 6 项测试通过：允许缺少单列示例、出处留在包外，拒绝额外编写的方法或示例、篡改行号，以及同时伪造源正文和全部自报哈希。另 3 项 SQLite／官方 DSH 回归通过：在隔离账号加载完整目录，每轮只加载一个正文及其同版本示例资源，拒绝第二个包及扩权读取。

原第 36 行：

本机已有 92 个包已原位更新并逐一核验，保留目录身份和原有启停选择；更新后仍为 92 项待核验启停，没有自动启用。本次安装脚本仅写本套包文件及其管理版本、核验记录。

原第 38 行：

通过 `pnpm run dev` 启动并复查监督器存活后，Computer Use 实际进入 Skill 页并刷新：92 张卡片均正常显示，无手动关联目录表单。页面保留在列表顶部供查看。未进行外部模型效果测试。

原第 40 行：

同日整理许可文件：删除仓库与本机各 92 个包内 `references/LICENSES.txt`，原作者许可集中保存在两处总 `SOURCES.md` 中；生成器不再创建包内重复文件。方法及示例的全部字节保持不变。来源约束 6 项及更新后的 SQLite／DSH 加载回归 1 项通过，后者覆盖总来源文档不会被发现成 Skill。本机逐包重新核验后仍为 92 项待核验启停，当前修订 3。

原第 42 行：

同日统一目录：日常 App 已直接读取仓库本目录，原 App 数据目录中的 92 个重复包及旧 `skill-packages` 根已删除。迁移逐项比较了完整文件树与原生内容摘要，保留包 ID、启停状态及原修订历史，只更新目录定位与运行锚点。根切换以私有意图文件支持中断恢复；新实例也默认使用仓库，不再创建 App 内副本。已完成 28 项后台相关回归、3 项桌面启动回归及两端类型检查，真实 App 重开显示 92 项已核验，原启停选择保留。

## website/README.md

来源：[website/README.md](../../website/README.md)；原段落位置如下。

原第 28 行：

JavaScript 使用 `node --check website/app.js` 检查语法。迁移前已通过浏览器验证回复与改写切换、候选编辑复制、架构节点说明。官网仅介绍模块职责，不代表所有产品集成已经端到端验收。
