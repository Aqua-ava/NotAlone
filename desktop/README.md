# 桌面端

Electron + React/TypeScript 的本机 Mac App，当前完成管理后台与横向输入小窗。两个窗口独立打开，关闭时隐藏，可从原生“窗口”菜单恢复；使用“隐藏 NotAlone”整体收起后，窗口菜单只恢复所选窗口。“NotAlone → 退出 NotAlone”明确退出。小窗标题空白区域可拖动，底部图钉按钮可切换置顶；隐藏和恢复保留本次置顶状态，管理后台保持独立。

主进程认证连接本机 Python 后端，并在两个窗口显示真实连接状态。重复启动只恢复已有 App；关闭窗口继续隐藏，明确退出先阻止新业务，再通过原已验证连接确认停读。连接或退出失败保留安全说明和重试入口。已接入真实联系人目录、双窗口选择、历史文件预览、原子提交与任务进度、会话读取授权、草稿改写、明确方向回复与候选编辑和关系资料查看与编辑；同步总开关与补齐和候选复制的任务状态见各自验收记录。任务 08/09/13/16 的新增 App 用例尚待预约执行，不能把连接、构建或 HTTP 成功当作完整业务闭环可用。

“联系人与绑定”显示当前运行本人范围内的联系人、消息数与来源数，不提供不存在的联系人添加或详情接口。目录先以同一已验证连接查询真实 `runtime_owner_configured`；缺模型密钥不阻塞查看联系人。目录首次默认不选，联系人由你手动确认；空目录说明通过历史导入或同步确认建立联系人。管理后台按钮和小窗选择器使用稳定的内部 `contact_id`，名称只用于展示。两个窗口共享本次联系人，小窗保持显示归属；同联系人隐藏恢复保留草稿、候选和编辑，切换（包括 A→B→A）、断线、换连接和退出清空本次状态，旧成功或失败不会覆盖新范围。App 的输入、语气、候选选择和编辑稿仅在内存中保留，重启不恢复；提交生成后的原草稿、原候选与依据由真实后端按联系人保存，不会把编辑稿静默写成长期偏好或发送消息。

小窗默认使用 `rewrite_draft`，关闭“结合关系语境”，只提交已确认的当前联系人、本次草稿和可选语气/要求。明确开启后才允许使用同一联系人的历史资料。主进程调用真实 `POST /api/reply/generate`，显示本次等待、返回的 1–3 个候选、依据摘要和风险备注；当前契约没有公开澄清对象或服务端进度，界面不推断这些结果。后端仍要求有效会话绑定，未绑定、超时与服务失败显示稳定说明，不跳过绑定生成候选。每个候选可独立编辑并查看原文与生成输入快照；重试同一次请求复用幂等键和原结果，保留已有编辑，改变草稿/语气/要求或明确重新生成使用新键。小窗展开到 520 像素高，选项、编辑区与窗口操作在实际窗口中可见；复制和完整依据查看由后续任务完成。

主动切换“回复”后，以 `GET /api/contacts/{contact_id}/messages` 每页 20 条读取当前已确认联系人的真实消息；“加载更早消息”沿后端 `before` 游标继续，不按正文或名称推测归属。消息默认不选，必须主动选择一条并填写非空“表达方向”，再以原消息 ID 和 `direct_input` 调用现有 `reply_to_message`。该模式只显示目标和方向，不携带草稿模式的隐藏语气/要求；使用选中消息、同一联系人的近期对话和相关资料。候选保存生成时的目标及方向快照，改变目标、方向或模式使用新幂等键；同一联系人在本次运行中可切回继续，换联系人、断线或新生产会话清除临时目标与方向。无消息、读取失败或实际生成被拒绝时如实显示，并可刷新重选或切换草稿；不提供模型方向建议、自动选目标或后台发送。此接线的普通页面与 HTTP 验收不证明原生窗口、签名包或模型语义质量。

“历史导入”通过系统单文件选择器读取用户本次主动选择的单联系人 JSONL；联系人选择默认留空，用户明确选既有联系人或填写新联系人名称。真实后端先完整校验格式、群聊、混合联系人与本人身份，再只读核对当前运行本人及所选联系人的渠道一致性。预览只显示文件名、本人和联系人身份、记录数及类型统计；选择、预览和确认都不写入联系人、身份或消息。换文件、换归属、另一窗口切换联系人、连接变化或主动取消会撤销本次预览；确认时重新读取预览核对内容摘要，迟到结果不能恢复旧范围。确认后用户再明确点击正式导入，主进程一次性消耗确认并提交；保存与后台关系处理分别展示。停止查看或断线不会撤回已发出的数据库提交，也不取消后台任务；结果未知时重新预览确认才能恢复原结果。外部导出工具的非官方能力、密钥与缓存风险在选择前说明。

“同步设置”已接通会话元数据与后台读取授权。首次、刷新和新出现的会话均不代选；勾选后必须明确选择已存在的联系人（同名时显示完整内部标识），或明确新建联系人，最后点击“确认并授权所选会话”。最终提交复核稳定定位、当前显示名和联系人范围，后端按可选 `observed_display_name` 再核对提交时元数据；原 `display_name` 的自定义展示名契约保留。新建选择若在最后确认时已被另一合法确认占用，则整批拒绝并要求重新选择，避免静默复用另一联系人。批量确认只追加，取消勾选不会撤销旧权限。若总开关已经开启，新增确认范围会立即允许后台读取；总开关与补齐的独立控制仍待接线。

已授权目录包含当前 CLI 列表消失的 active 绑定；改名与消失有明确提示，不能静默改绑或更新名称。用户在专门的撤销确认中核对会话与联系人后，可撤销后台读取授权：服务最多等待 4 秒取得与同步 cycle 相同的锁，等待当前一轮收尾后幂等撤销；成功响应后不再为该绑定新增 tail。取得锁前超时不执行迟到撤销，页面保留授权与重试；失败不显示成功。绑定记录和历史资料保留，清除来源使用独立删除流程。改名需显式撤销后重新选择确认。CLI 不可用时仍可管理真实已授权目录；本人渠道身份缺失则说明先确认单联系人历史导入并正常重启，不伪造首用就绪或新增本人渠道初始化入口。

“应用配置 → 本人身份与模型”已沿用后端 setup 接口：空库等待用户明确初始化本人，App 固定使用 `create_only`，服务端在同一事务内原子检查和创建；发现既有身份时拒绝并保持本轮配置不变。`setup/status` 的只读 `runtime_owner_configured` 核对当前实例受控身份在同库存在，就绪时直接复用。全库已有本人但本次运行身份缺失或不存在时提示检查受控配置，不自动选取其他身份。

本人初始化或 DeepSeek 密钥保存成功后，先认证停读同一服务，等待旧运行时退场，再通过正常启动检查重连。初始化已写库和配置而响应丢失时，用户可明确选择“重新加载受控配置”；重载只读取实际配置，不重复初始化。失败显示真实结果，恢复查询结束后再次复核连接与操作，旧错误不能覆盖断线或较新状态。密钥输入为密码框，提交后清空，页面只显示是否配置；配置本身不会发起模型调用。页面说明本机配置文件和 PostgreSQL 资料长期保存、未提供静态加密，以及供应商外部副本的独立删除限制。

后端生产启动会沿用本人身份和已确认同步范围；每次启动或复用前先通过机器环境只读诊断，连接状态不能代替数据库就绪。测试使用本轮随机新建的隔离 `_test` 库、握手、配置与 userData，不访问既有业务库、模型或微信。主进程才持有认证 token，渲染层只收到具名操作和非秘密状态。
已接入默认 `Command+Shift+Space` 的系统注册与小窗显示/隐藏回调。在“应用配置 → 桌面操作”查看真实注册结果并修改组合；无效、注册失败或保存失败时保留旧键与旧设置。支持 `Command`、`Control`、`Alt`、`Shift` 加字母、数字、F1–F24 或常用导航键，至少需要前三种修饰键之一。注册结果不保证该组合没有被其他程序处理。经用户明确授权，任务 03 保存的本机签名 App 已在全新隔离配置下接收两次真实系统按键，分别隐藏并恢复同一小窗，窗口 ID 和位置保持不变；没有启动业务后端、输入正文或操作微信。也可使用公开按钮和“窗口”菜单。

## 本机运行与构建

需要 macOS 13 或更新版本、Node.js ≥ 22.12，以及构建图标/本机签名所需的 Xcode Command Line Tools。依赖版本固定在 `package-lock.json`。

```bash
cd desktop
npm ci
npx install-electron     # 首次显式准备锁定版本的 Electron 运行时
npm run typecheck
npm test                # 类型检查和安全调度回归，真实 App 不运行
npm start
npm run package
```

本机 arm64 产物为 `out/NotAlone-darwin-arm64/NotAlone.app`。可在 Finder 双击打开；包只包含编译后的本地资源和最小启动清单，不依赖开发服务器、原型目录或仓库绝对路径。打包只替换本目录的 `out/` 产物，不覆盖历史 App。当前为 ad-hoc 本机签名，未做 Developer ID 分发、公证或 DMG；权限与签名边界见[台账](../docs/macos-app-permissions-and-errors.md)。

## 轻量无头页面验证

用户已同意普通页面采用后台接口和单实例无头浏览器；宿主桌面的可见 Electron 批量验收继续暂停，不安装虚拟机。`test:pages` 使用本机已有的 Google Chrome 与锁定 Playwright，独立临时 profile，最多两个明确页面组，串行运行；没有浏览器则失败，不隐式下载。先激活 Conda `NotAlone`：

```bash
npm run test:pages -- --case memory-reading --case draft-rewrite --timeout-seconds 120
npm run test:pages -- --case draft-rewrite-acceptance --timeout-seconds 180
npm run test:pages -- --case draft-rewrite-session --timeout-seconds 120
npm run test:pages -- --case memory-reading-full --case memory-stale-full --timeout-seconds 240
npm run test:pages -- --case directed-reply --case draft-rewrite-acceptance --timeout-seconds 300
npm run test:pages -- --status  # 只读租约，不启动浏览器或 Electron
```

时限为 1–300 秒，包含构建；没有默认全量。`memory-reading` 验证实际资料/采纳方式/来源引用/切换/空状态及具名参数与角色限制；`draft-rewrite` 验证真实模型替代边界下的生成、候选编辑与原快照、选择和跨联系人迟到结果。`draft-rewrite-acceptance` 串行验证任务 09 的九个具名普通页面场景，每场景新建随机库和页面上下文；包括关系语境、真实 1–3 候选、等待/风险/编辑、幂等、失败与空候选、联系人及连接迟到成功/失败、同 userData 新生产会话清空及具名参数/角色/来源限制。六类交互与原 App 用例共用公开页面场景；新会话的输入准备/清空断言也与原生重启用例共享，各自保留停读、PageHost 或原生生命周期。`draft-rewrite-session` 固定只运行完整组中的同一个新会话场景，供相关小修复核使用；不能把单场景结果扩张为全部九项重跑。原生隐藏/恢复及真正 App 重启仍保留实际 App 验收。页面组复用生产 React、联系人/资料/回复 handler、参数校验、preload 传输接口及真实 HTTP/PostgreSQL；生产 Electron adapter 仍使用原 `validateCaller` 与角色检查。headless 的角色由 host 登记的 page 对象确定，不接受 renderer 自报；具名函数只接收已注册操作，renderer 不持有后端 token、数据库地址或任意 HTTP/系统调用。回环资源 host 与浏览器控制端仅用于测试，不进入交付 App。

每例创建自己的随机 `_test` 库、合成联系人/本人、配置、握手和 context，仅外部模型及必要传输迟到被替代。窗口切换在测试中创建对应角色的页面，原生隐藏/置顶/快捷键/剪贴板与未接通业务入口明确拒绝，不返回假成功。未改正常 App 的 show/focus。原生窗口、真实 IPC 来源、系统对话框、签名 App、微信权限和完整 App 验收仍待实机，两个最小页面组不能替代功能票全部条件。

`directed-reply` 含任务 11 的十一项普通页面场景：主动目标与非空方向、真实 22 条分页与较早目标、原输入/候选/编辑稿分离、丢包同键恢复与输入改变的新键、无消息/列表失败重试/绑定拒绝、目标来源不再有效后失败并转草稿、联系人或连接变化后的迟到列表与生成成功/失败、新生产会话不恢复输入，以及具名参数/角色/范围拒绝。每项使用独立随机库与真实生产 handler；同组串行复用本轮唯一无头浏览器。模型脚本只在外部模型边界返回受控候选，不能证明自然表达质量，也不把这些页面操作当作原生验收。

页面 CLI 的构建/运行子进程及共用 Python 测试环境主动剥除全部 `LANGSMITH_` / `LANGCHAIN_` 追踪配置与凭据，并明确关闭当前和旧版 tracing 开关；调用方覆盖值也不能重新开启。合成模型仍会经过真实 LangChain 回调，不能靠替换模型阻止外部 trace。检查命令只使用自有回环收集器和假密钥：

```bash
node tests/headless/tracing-isolation-check.mjs          # 真实 pipeline 正控制与隔离效果
node tests/headless/tracing-isolation-check.mjs --pages  # 另跑限定 draft-rewrite 一组
node tests/headless/rewrite-lifecycle-check.mjs          # 实际未知命令故障与随机库收尾
```

改写 App/页面入口只共用 tempdir、Python 启动、ready 和清理生命周期，各自保留资源登记。控制通道失败仍关闭本轮 stdin，尝试触发 Python 的原有 finally 清理；退出码或清理未确认则保留私有 `cleanup-unconfirmed.json`（自有 PID、退出状态、已限定的随机 `_test` 库名），不撤销登记或解除租约，不包含 token/连接串。故障检查须另核验本轮库和进程后才清理自有诊断目录。

全机用户租约为 `.notalone-desktop-tests/headless.lock`，跨工作树和独立命令互斥，复用私有归属检查；不创建 App broker 或 App token。到期/中断只通知本轮 `ChildProcess` 收尾；控制器停读、HTTP/PG/临时目录、浏览器退出和自有进程组均需确认，失败保锁且不抢占陈旧锁、不杀未知 PID。`--status` 只提供归属线索，不能证明残余资源已清理。

`artifacts/headless-pages/` 保存仅合成资料的页面截图及 `resources.json`。资源记录为自有子树 RSS 之和的采样峰值，共享页可能重复计，不是精确物理内存或永久上限；Node 指页面控制器进程，构建/Swift 编译开销未计入该峰值。小型 Swift helper 以约 700 ms 间隔只读本轮浏览器 PID 的 AppKit 激活状态和 CoreGraphics 屏上窗口数，不截屏、不读取其他 App 的标题、无 AX/系统输入或 TCC 请求；有限采样不能保证采样间没有任何瞬时行为。

本轮最小两组 2/2 通过；12 次 owned PID 观测中 active 为 0、屏上窗口数为 0、激活策略为 prohibited。随后资源采集收窄为全局仅 PID/PPID、仅本轮子树读取 RSS/进程名，并等待在途采样后收尾；迟到组保留公开生成 Promise，释放真实 HTTP 后等其完成才检查新范围。只重跑该改写组，1/1 通过，8 次静默观测仍为 0/0；最新峰值 RSS：Chrome 子树 1,027,536 KiB、页面控制器 Node 156,256 KiB、合成 Python 153,584 KiB。正常收尾后租约 absent。公开 CLI 的范围拒绝、跨命令互斥、截止、中断收尾与不确定保锁通过；不更新原生或完整功能票的完成状态。

双轴评审后的隔离修复取得真实 red→green：旧隔离器在合成追踪父环境下向回环收集器发出 1 次 POST；修复后真实 pipeline 正控制 1 次、隔离 0 次，公共 CLI→Node→Python 的实际改写组 1/1 且 trace 为 0。该次 8 次 owned PID 观测仍为 active 0 / 屏上窗口 0 / prohibited；RSS 采样峰值 KiB 为 Chrome 子树 1,035,920 / 控制器 Node 160,000 / 合成 Python 155,120，正常清理与租约 absent。未知命令故障使实际夹具 exit 1、随机库残留 0，同时未确认 marker 保留、诊断先保留后由检查者核验清理；CLI 10/10 与共享传输 6/6 通过。此次只重跑受影响改写组，没有重跑两组或原生 App。

官方接口核验：[Playwright BrowserType](https://playwright.dev/docs/api/class-browsertype)、[BrowserServer](https://playwright.dev/docs/api/class-browserserver)、[Apple NSRunningApplication](https://developer.apple.com/documentation/appkit/nsrunningapplication?language=objc)、[窗口信息](https://developer.apple.com/documentation/coregraphics/cgwindowlistcopywindowinfo(_:_:))。Context7 本轮不可用，官方一手资料与已安装 Playwright 1.64.0、macOS SDK 的实际编译/运行均已核对。

追踪隔离核对 [LangSmith 的 LangChain 追踪](https://docs.langchain.com/langsmith/trace-with-langchain)与实际安装 `langchain-core 1.5.5` / `langsmith 0.11.0` / `langchain 1.3.15`：环境开关可自动安装真实回调，检查显式等待 trace flush；本轮只处理合成正文与 owned loopback，不审阅真实追踪密钥，也不据风险推断历史数据已上传。

## 安全检查与预约 App 验收

`npm test` 默认只执行 TypeScript 检查和测试 CLI 的合成回归（`tests/scheduling/`、`tests/headless/command.test.mjs`）：未协调调用拒绝、跨独立命令副本/TMPDIR 互斥、启动预算、到期、Ctrl+C/SIGTERM、崩溃与损坏租约，以及 Playwright 门禁和限定文件发现。合成孩子固定为 Node；原始 Electron API 的拒绝检查也显式使用 Node 可执行文件，避免门禁回归时打开桌面。命令明确报告真实 App 未运行。这些结果不能证明窗口、业务 UI、后端 HTTP 接线、签名包或实机验收通过；安全目录从真实 App 全量中排除。

真实 App 验收会显示窗口并使用桌面焦点。必须由主 Agent 先协调用户认可的有限时段，再执行下面的显式命令。参数只是实施门禁，不能代替用户对该时段的认可；当前原任务的 App 验收仍暂停，直到本调度修复安全检查和两轴评审完成。`npm start` 是用户正常打开 App 的入口，不能当作绕过测试门禁的自动验收方式。

```bash
npm run test:app -- --interactive --coordinator main-agent \
  --from '<预约开始，带时区的 ISO8601>' --until '<预约截止，带时区的 ISO8601>' \
  --max-launches 4 -- tests/windows.spec.ts
```

开始时间必须已到、截止尚未到，两者间隔最多一小时；构建也计入预约时段。必须给出最小相关的 `tests/<name>.spec.ts` 文件，可加 `--grep` 缩小用例和 `--output artifacts/<name>` 保存合成输出。每次 Electron 首次启动、重启和重复实例都消耗统一预算；测试失败即停，不自动重试、重复运行或扩展全量。`workers: 1` 保留为单个命令内部约束，全机互斥另由租约负责。功能阶段只验收必要组，最终集成才在一次预约中显式以 `--suite` 替代文件列表，并给出适合该组的启动预算（最大 250）；不由每个 Agent 重复执行完整回归。

租约位于 OS 用户账户目录中的 `.notalone-desktop-tests/interactive.lock`，使用 OS 用户信息而非 HOME/TMPDIR/userData 或工作树路径决定位置。目录、记录和本机 Unix socket 均核验所有者与私有权限，随机 token 只传给本 runner 的孩子，不写入记录或输出。主配置在 fixture 前检查活 runner；fixture 与独立启动/重启也检查随机 token、工作树归属、截止时间和预算。直接 `npx playwright test` 默认失败关闭；`--list` 只列出用例，不能证明运行。生产窗口的 show/focus 与正常快捷键行为保持原状，没有通过隐藏 App 或未知 headless 参数伪造静默 UI 验收。

到期或 Ctrl+C 先关闭新启动资格，再要求本 runner 的孩子收尾；App 守卫同时检查截止及活 runner。兜底只对本次 spawn/launch 返回且仍存活的 ChildProcess 发信号，强制回收不算产品认证停读通过。结束后还核验本轮进程组消失和启动登记归零；EPERM、疑似 PID 复用、未完成登记或其他不确定性都保留锁，不依据未知 PID 终止任何进程。runner 崩溃留下的锁即使到期也不自动抢占。

```bash
npm run test:app:status  # 只读租约归属线索，App 不运行，不自动解锁
```

状态文件和 PID 只提供线索。出现 `app_test_locked`、`app_test_lease_unsafe` 或 `app_test_cleanup_unconfirmed` 时，主 Agent 必须先核验上轮自己创建的资源已收尾；未知归属时继续暂停，不能以删除锁或按进程名 kill 继续测试。恢复旧工作树之前必须先合入最新集成提交并审计新增启动路径；尚未合入门禁的旧脚本不会被机器租约自动拦截，暂停/恢复由主 Agent 协调，不新增常驻监控。

原 [App/HTTP 测试接缝](../.scratch/mac-desktop-app/spec.md)继续保留。没有可靠独立桌面 runner 时将真实 UI 项列为预约验收，不用 DOM 检查替代原证据。以下测试组说明的是既有约定和已实现夹具范围，本轮安全 CLI 通过不会更新其实际 App 验收结果。

包含真实 Python 宿主的测试需先激活 Conda `NotAlone`。测试使用当前工作树的 `backend/src`，隔离 dotenv 的读取和写回、握手、owner、模型、CLI/探针和 App 配置。测试准备阶段只对自己随机新建的 `_test` 库显式迁移，App 始终运行真实只读诊断；完成后只清理本轮拥有的库。数据库不可用场景使用受控回环端口，其他生命周期场景使用已迁移的隔离库，不连接已有数据库。

`tests/setup.spec.ts`、`tests/setup-stale.spec.ts`、`tests/setup-recovery.spec.ts` 与 `tests/setup-concurrency.spec.ts` 使用本轮随机 `_test` PostgreSQL 库、正式迁移和真实 `notalone.server.command` / HTTP。受控解释器夹具只从独立 `synthetic.env` 加载本轮本人与合成密钥，继续禁止默认 dotenv，并把模型 URL 固定到无服务的回环端口；CLI 与探针使用不存在的本轮路径。覆盖首次初始化、既有配置、缺失或不存在的运行身份、密钥保存失败、启动失败恢复、经验证的复用服务重启、具名 IPC 限制与迟到响应失效；新增响应丢失后的明确重载、失败刷新失效，以及同库两个真实客户端并发初始化。延迟夹具只控制真实后端的 HTTP 传输，PG 锁只安排并发写入窗口，不替换业务仓储。测试完成只清理本轮库、配置和进程，不调用真实模型或微信。

`tests/contact-*.spec.ts` 同样使用随机新建、正式迁移的 `_test` 库及当前工作树真实 HTTP，包含两个合成联系人和同库另一 owner。验证真实统计、本人就绪与空列表、两窗选择、目录外 ID 与过期草稿拒绝、隐藏恢复、A→B→A 清空、断线/连接更换撤销旧成功和失败、相同 userData 重启清空；延迟目录只在本轮回环传输边界安排，不替换联系人业务模块。目录外参数无法从 UI 构造的场景经过公开具名桥接，结果仍核验真实两窗；不使用私有会话模块或通用 renderer 请求。草稿、截图与测试输出均使用合成文字，只清理本轮创建的库、配置、握手与进程。SSE 的联系人失效验证由任务 19 延续。

`tests/draft-rewrite.spec.ts` 与 `tests/rewrite-*.spec.ts` 使用真实生产回复装配、LangChain 调用、HTTP、随机 `_test` 库和正式持久化，只把外部模型替换成可捕获输入的受控模型。两个本人联系人、另一 owner 的资料和有效绑定均为合成准备；不证明绑定 UI、真实微信或模型语义质量。覆盖默认不读取历史、明确开启后的联系人范围、真实 1–3 候选/风险提醒/原文快照、编辑与选择、真实响应丢失后的幂等恢复、新输入和重新生成、实际绑定撤销拒绝、真实超时/失败、迟到结果失效、隐藏恢复、重启清空与受限桥接。延迟和丢包只安排真实回环 HTTP 传输，模型故障仍经过真实运行时与错误契约；不替换业务仓储、不读取剪贴板或微信，不访问供应商服务。

任务 09 最新普通页面验收 `draft-rewrite-acceptance` 为 9/9 green（单个无头 Chrome、真实隔离 HTTP/PG）；首轮最后一场景因页面尚未初始化而失败，补齐公开控件可见等待后末轮通过，不能称业务缺陷的 red → green。生产控制器正常停读后在同一 userData 新建会话，不恢复草稿、编辑、语气和本次要求；该结果不证明原生 App 重启、隐藏/恢复、剪贴板、签名或真实模型质量。完整评审与修复增量均已清零，任务 09 的普通页面条件已 resolved；P3 共享场景修复只另跑新会话 1/1，与此前完整 9/9 分开记录。任务 09 的历史 9 条 App 行为已通过；首轮完整回归为 95/96，旧占位按钮断言已修正，末轮完整回归在用户要求解决桌面干扰时中止为 21 passed / 75 did not run（exit 130）。用户随后选择只继续不触桌面的工作：当前保留原实现，合入门禁并把独立重启改为 `launchApp`；类型与构建通过不更新 App 验收结果。候选单选、标签布局/快照措辞及联系人条件已由本轮普通页面验收；门禁下的原生 App 重启与最终签名 App 仍待后续预约，不能称完整 App 回归通过。详见[任务 09 记录](../.scratch/mac-desktop-app/issues/09-draft-rewrite.md)。

`tests/import-preview.spec.ts` 由实际 App 选择、预览、手动确认与取消，连接同一真实 HTTP／随机 `_test` 库。自动化只替换必要的系统文件选择返回，不替换导入业务；覆盖有效单联系人资料、损坏、混合联系人、群聊、多本人、库内身份冲突、文件内容变化、换文件、换归属和双窗口迟到结果。任意路径和目录外联系人经过公开具名桥接拒绝；无正文、完整路径或摘要交给渲染层。门禁引入前源码 14 项预览及全组 101 项已有历史通过记录；后续不触桌面的构建签名产物按原源版本保留，UUID 去重只检查类型与 build，没有重打包或运行 App。真实系统文件选择器与签名包 UI 列为任务 20 的待实机项，等用户安排验收时段；自动化中的必要对话框 I/O 替代不能证明这两项通过。

关系资料页的只读链路读取当前联系人有效记忆、当前本人有效记忆、当前联系人 pending 候选和来源目录。`auto` 展示为“自动采纳（可撤销）”，`manual` 展示为“手动采纳”，pending 明示不是已确认事实；来源聊天时间、保存时间和有效期分开，未知或不完整时间不补造。来源目录只解析实际匹配的来源记录，其余消息、观察或人工引用保留未知说明；已有版本和候选引用可展开，当前公开接口没有完整历史正文。各栏独立加载和重读，连接、联系人范围或更新的读取操作会废弃旧响应；业务 SSE 尚未接入；管理页的具名编辑与删除行为见下段。

`memory-reading-full` 与 `memory-stale-full` 分别验证九个资料/独立重读/真实空结果场景和六个迟到成功/失败场景，每场景使用新随机库与页面上下文。原十条 App 用例的公开页面断言共用；四栏加载、失败和独立重读只安排真实回环传输，旧操作的公开 refresh Promise 完成后才核对可见页面。当前两组 15/15 green，单个无头 Chrome、85 次自有进程静默采样未见激活或可见窗口，真实资源收尾确认、两租约 absent；固定候选完整双轴 Standards hard 0 / possible 0、Spec P0–P3 全 0，任务 13 的普通页面条件已 resolved。首次完整组仅因相同保存时间命中两张卡的旧选择器而失败，限定对应记忆卡后通过，生产源码没有变化。实际 App、签名和原生能力仍须各自验收。

关系资料管理页支持补充本人或联系人资料、修正当前版本、单条删除、撤销自动采纳，以及确认或丢弃待确认候选。补充与确认均沿用 `manual`，候选 `self` 保存到本人、`contact/shared` 保存到当前联系人。本人修正在一个后端事务中创建新 ID/manual 版本、引用旧版并使旧版退出当前上下文；不覆盖历史回复依据快照。撤销自动采纳调用既有删除接口，不删除来源消息，不承诺恢复。所有写操作仅允许管理页的具名能力，范围或版本失效必须重读；提交后受影响列表核对失败不显示成功，连接或联系人变化会废弃旧操作结果。

任务 14 最新普通页面验证在源 `3a9be09` 上完成：`memory-editing-full` 12/12、受影响 `memory-reading-full` 9/9 与 `memory-stale-full` 6/6，单 CLI 最多两组、deadline 240 秒、每组串行独立随机库/上下文，单 Chrome，quiet active/window 0、资源正常收尾且两 leases absent。相关后端 12 模块 123/123 通过，外层 HTTP 夹具认证 stopped/exit 0、精确本轮库缺席。旧回复依据与新生成上下文的真实 HTTP 回归已通过，模型只在外部 provider 边界返回合成结果。首次新增迟到测试因断言请求也被自身代理挂起导致 deadline/cleanup_unconfirmed；该轮不记通过，主协调核验并回收唯一已证明的后端与库后单独安全释放租约。后续夹具 HTTP 有五秒可取消超时，运行器持续保存自有进程身份；修正后四种迟到场景与最终完整组正常通过。任务仍 claimed，最终两轴评审由主协调安排；没有原生 App、剪贴板、微信或真实模型质量验收。

`tests/memory-reading.spec.ts` 与 `tests/memory-stale.spec.ts` 已准备上述公开 App 用例，包含 A→B→A、同范围重读、连接失效、独立失败和受限参数。夹具使用当前工作树真实 HTTP 与随机 `_test` PostgreSQL 库，仅延迟或拒绝本轮回环传输来安排迟到结果。**本轮实际 App 用例未运行，其原生生命周期与签名验收仍待认可时段**；上述普通页面 green 覆盖当前资料 React 交互与真实隔离 HTTP/PG，不代表完整 Mac App 或微信渠道验收。类型检查、构建和历史夹具 HTTP 自检不能单独替代页面验收。`tests/fixtures/memory-database.py check-http` 在激活 Conda `NotAlone`、显式禁用默认 dotenv 并指定本轮独立 `synthetic.env`/握手路径后，可只核验合成数据的公开列表契约与隔离；它不启动 Electron，不读取真实微信、剪贴板或私人资料，不调用模型，结束后认证停读并只清理自己创建的后端、临时目录与库。

任务 08 的 `tests/import-submit.spec.ts` 与 `tests/import-submit-stale.spec.ts` 已准备公开 App 操作：正式保存、真实五步任务、原失败任务恢复、文件变动拒绝、取消/换联系人/换连接后的迟到成功与失败、保存响应丢失后重新确认，以及首份渠道身份后的明确认证停读重启。合成模型仅替换外部 provider，HTTP、持久任务、调度、回复范围与 PostgreSQL 使用生产模块；文件选择只替换必要对话框 I/O。这些 App 用例本轮未运行，没有 UI red/green、截图、真实微信或语义质量验收证据，任务保持 claimed。首份身份不会自动授权同步，用户明确重启只沿用既有开关与确认范围。

无桌面 HTTP 检查可以单独执行，入口自动隔离 dotenv 读写、握手、模型、CLI/探针，随机创建 `_test` 库并仅迁移和清理该库：

```bash
conda activate NotAlone
NOTALONE_DISABLE_DOTENV=1 PYTHONNOUSERSITE=1 PYTHONPATH="$PWD/backend/src:$PWD/backend:$PWD/desktop/tests/fixtures" \
  python desktop/tests/fixtures/import_http_check.py
```

以上命令从仓库根目录执行，Conda 未初始化的 shell 须先加载其 `etc/profile.d/conda.sh`。它已验证同 body 新建重放与并发复用原 contact/task，结果为零新增与原消息数重复，名称/文件/owner/确认方式/来源状态/撤销身份的拒绝，原任务失败恢复与前台回复优先调度；不能替代桌面或微信集成验收。HTTP 首份导入以 owner 行 UPDATE 锁串行，CLI 仍遵循原 owner KEY SHARE 与本人渠道身份 UPDATE 锁；重放额外锁定原渠道身份、联系人、来源与确认记录，不把 HTTP 的锁约束称为所有入口的同一行为。

`tests/binding-consent.spec.ts`、`tests/binding-stale.spec.ts` 通过实际 App、当前工作树生产启动命令及真实 HTTP 使用随机 `notalone_binding_<UUID>_test` 库，正式迁移只作用本轮库。夹具明确 seed 合成 Owner 渠道身份，并以独立的合成 CLI 可执行文件替代微信；它不证明 setup→首份导入→重启的首用完整链路。覆盖未预选/刷新/群聊排除、同名 UUID 选择、新建与追加、开关已开时新增读取、改名/消失/冲突重确认、撤销取消/超时重试/成功后零新增 tail、CLI 与本人渠道缺失、受限桥接与旧连接成功/失败失效。等待只在合成 CLI 进程与回环传输边界安排，数据库与同步业务模块保持真实。可对签名包运行同一测试；没有读取真实微信、模型、私人配置或业务库，也没有使用 CGEvent。

使用 Playwright 的 experimental Electron 支持，在真实窗口上操作公开按钮和原生关闭/菜单。测试使用独立随机用户数据目录并正常回收进程；不读取 React 私有状态，不访问已有业务数据。构建源码资源与打包 App 共用同一行为测试：

```bash
NOTALONE_TEST_APP_EXECUTABLE="$PWD/out/NotAlone-darwin-arm64/NotAlone.app/Contents/MacOS/NotAlone" \
  npm run test:app -- --interactive --coordinator main-agent \
    --from '<预约开始，带时区的 ISO8601>' --until '<预约截止，带时区的 ISO8601>' \
    --max-launches 4 -- tests/windows.spec.ts --output artifacts/packaged
```

窗口测试验证双窗口打开、关闭隐藏、互相恢复、菜单恢复、整体隐藏后仅恢复目标窗口、退出回收，以及随包 logo 加载和真实未就绪状态。macOS 的 `hide` 菜单角色由 Cocoa 执行，`MenuItem.click()` 不执行该默认动作；自动化确认公开菜单项后，通过 `Menu.sendActionToFirstResponder('hide:')` 执行原生隐藏，再操作窗口菜单并读取两窗可见结果。实际 CUA 点击菜单另行核验同一边界。后端测试通过公开 App 操作和本机 HTTP 核验单实例、受控启动/复用、认证、断线重试、握手非法或变化、迟到状态、退出失败/超时与恢复；包含实际 `notalone.server.command` 和 `BackendServer` 的启动/停读场景。入口资源故障只修改隔离构建副本，不损坏签名包。

`tests/desktop-controls.spec.ts` 验证注册结果、改键与重启恢复、注册/保存失败保留旧键、正文置顶按钮、隐藏恢复及退出注销。注册失败场景在隔离启动包装中先安排系统注册，再同步加载原始 App 入口；只控制必要系统边界，不替换业务模块，不调用快捷键回调，签名包跳过该夹具。截图在 `test-results/` 或指定 `artifacts/` 目录中，均不提交。这些自动验收不证明全局键盘派发、联系人隔离、剪贴板、权限或真实微信渠道可用；另行完成的两次系统按键实机结果见[权限与验收台账](../docs/macos-app-permissions-and-errors.md)。

`tests/startup-diagnostics.spec.ts` 验证 Python/包缺失、数据库不可用、缺基线、账本漂移、待迁移和必要结构缺失，以及公开路径修正和重试。真实只读 Python 入口与实际 `BackendServer` 均来自当前工作树。App 以 `/` 为工作目录、清空 Conda 变量并限制 PATH，检查无需预先激活终端的启动条件；这项自动化不等同于用户在 Finder 双击的实机验收。`tests/startup-cancellation.spec.ts` 在受控 Python 包装边界延迟诊断并忽略 SIGTERM，验证超时/退出回收自有子进程、迟到结果不能启动后端；释放后仍执行真实诊断入口。

`tests/startup-setup.spec.ts` 联合真实首启 HTTP 与本轮迁移库，验证账本漂移同时阻止既有运行时复用和初始化后的重启，修正测试条件后由公开操作恢复；路径停读未获确认时，配置保持不变且不另起服务。测试只故意修改并恢复本轮已执行的账本 checksum，不提供业务库补写记录或恢复工具。

`tests/startup-path-recovery.spec.ts` 分别验证项目目录不可访问和有效目录内缺少后端源码的提示及修正。机器 schema 检查包含 setup 状态查询依赖的 `owner.created_at`；本轮测试库故意缺列时先阻止启动，测试准备恢复后再从 App 重试。失联恢复用例仍操作原真实后端，不能把断线当作已停读。

## 非秘密启动配置与退出

主进程读取当前 userData 中的 `backend-launch.json`。在“应用配置 → 机器环境”可查看、修正和保存下列非秘密绝对路径。Python 和项目目录必须同时提供；没有可核验的项目环境时阻止启动和复用，显示恢复说明：

```json
{
  "pythonExecutable": "/绝对路径/Conda环境/bin/python",
  "projectDirectory": "/绝对路径/NotAlone",
  "envFilePath": "/绝对路径/受控配置.env",
  "backendInfoPath": "/绝对路径/backend.info",
  "wechatCliPath": "/绝对路径/wechat-cli",
  "syncProbePath": "/绝对路径/notalone-sync-probe"
}
```

未保存时，`envFilePath` 默认使用所选项目根目录 `.env`，`backendInfoPath` 默认使用 `~/.notalone/backend.info`；受控运行可用 `NOTALONE_ENV_FILE` / `NOTALONE_BACKEND_INFO` 提供初始值。已保存路径优先于这些初始环境变量。CLI/探针可留空，显示对应渠道不可用；诊断只检查可执行文件，不运行 helper，缺 helper 不阻塞独立的后端配置能力。保存文件只含路径，不含配置内容、模型密钥或握手 token。

诊断固定调用已核验的绝对解释器及 `-m notalone.startup_diagnostics --migrations ...`，诊断就绪后才允许 `-m notalone.server.command`；两者从所选项目的 `backend/src` 加载代码，不依赖 Finder 的 PATH、工作目录或其他 checkout 的 editable install。只读入口使用有界连接和 READ ONLY 事务，仅核对必要 schema 元数据、审计基线与迁移账本，不读取联系人/聊天正文、不迁移或接管业务库、不创建参考库。缺基线、文件或账本漂移、待迁移和必要结构缺失分别显示恢复说明；已有业务库的升级需要另行明确授权。机器就绪与本人身份/模型首启分开显示。

主进程确认没有持有运行时或未完成的启动任务时，才允许直接保存。连接查询失败产生的“尚未连接”仍可能持有原服务；此时先点击“停止服务以修改路径”，通过原已验证目标认证确认停读并等待服务退场，才恢复路径编辑。失败保留旧目标、原路径和停读恢复入口，不能保存新路径或另起后端。保存与新连接串行，落盘前再次核验资格；保存不会自动连接。点击“重新检查并连接”重新经过只读门禁，重复重试不会启动多个后端。

握手必须是当前用户拥有、没有组/其他用户访问权限的普通文件，拒绝符号链接、重复字段和非法 `127.0.0.1:1–65535` 地址。HTTP 不跟随重定向，不向界面转发原始错误、stdout/stderr 或 token。认证 POST 返回 `state: stopped` 后可以退出；响应未确认时只向原连接查询状态。断线、超时和子进程消失都不能代替停读确认。退出失败会打开管理后台并保留“重试停读并退出”；不启动新读取，不改持久同步开关。只回收本 App 创建并仍持有身份的子进程，不根据握手 PID 杀复用实例。

握手和启动配置以非阻塞方式打开后再核验普通文件，拒绝符号链接；FIFO 不会卡住连接或退出，启动配置限制为 8 KiB。正常连接阶段的明确重试会重新认证最新合法握手，成功后替换连接；退出开始后则固定原已验证目标，认证中的新握手不能改变关闭目标。连接中明确退出会取消尚未发生的启动，并在最终 spawn 前复查；已创建的子进程仍等待握手、认证确认与受控收尾。

## 工程边界

| 目录 | 职责 |
| --- | --- |
| `src/main/` | 窗口、菜单、资源、单实例、全局快捷键和非秘密桌面设置；`startup/` 管理路径与只读机器门禁，`backend/` 管理启动、握手、认证 HTTP、连接与退出状态；`contacts/` 管理两窗本次联系人和草稿，`imports/` 管理单文件预览、一次确认、提交与持久任务进度，`reply/` 管理本次改写、幂等和编辑状态，`memory/` 管理资料查询、具名编辑及范围/版本失效 |
| `src/preload/` | 具名窗口、桌面设置、联系人、历史预览、改写、资料查看和后端桥接及非秘密状态订阅，不暴露通用 IPC、URL 请求或认证信息 |
| `src/renderer/` | React 界面、交互与展示状态 |
| `src/shared/` | 跨进程桥接类型 |
| `tests/` | 实际 Electron App 公开行为自动化、统一启动门禁；`scheduling/` 只验证安全命令 |
| `scripts/` | 本地资源编译、白名单打包、图标与 ad-hoc 签名、安全检查和预约测试租约 |

历史预览的公开具名桥接为 `imports.getState()`、`chooseFile()`、`setTarget(target)`、`preview({ selectionRevision })`、`confirmPreview({ selectionRevision })`、`cancelConfirmation({ selectionRevision })` 和 `onStateChanged`。渲染层只持有展示数据与本次选择版本。任务 08 的主进程提交操作调用 `ImportController.takeConfirmedSelection(selectionRevision)`，返回 `{ generation, body }`；`body` 包含本轮系统选择的 `path`、`expected_content_sha256` 和二选一的 `contact_id`／`new_contact_name`。该方法同步核对连接 generation、两窗联系人范围及选择版本，并立即消耗确认；提交前再次核对 generation 后，以 `BackendHost.requestJson` 调用 `POST /api/imports/commit`。提交失败或取消必须重新预览确认，不能缓存 body 作为重试授权。服务器从一次读取的同一文档校验摘要、规范化并原子写入，内容不同返回 `409 / import_file_changed`，预览身份冲突返回 `422 / import_identity_conflict`；旧 HTTP 调用的摘要参数仍为可选。

正式导入新增 `submit`、`refreshTask`、`retryTask`、`runTask`、`reloadSyncHost`，均只接受 `{ selectionRevision }`，仅管理窗口可调用。主进程从真实 commit 取得 contact/task 后刷新目录、来源和原任务；渲染层不能传路径、body、摘要或任务 UUID。重试先恢复原失败任务，再明确启动同一任务，保留成功步骤；任务进度只按持久 status/step/count 展示，最终完成要求五步均成功。停止查看只废弃本次窗口结果，不宣称撤回已落库资料。

渲染层开启 context isolation、进程沙箱、关闭 Node 集成；正常界面只从受控 `notalone://app/` 资源加载，设置 CSP、拒绝导航/新窗口/网页权限。主进程校验桥接的窗口、主框架、精确资源来源、参数个数和类型。入口资源失败时使用无脚本的安全中文说明页，来源校验拒绝它调用桥接；可从原生菜单重试。临时界面会话使用内存分区；默认应用配置目录是 `~/Library/Application Support/NotAloneDesktop`，与历史 App 分开；`desktop-settings.json` 只保存 `helperShortcut`，不保存草稿、候选、置顶状态或业务资料。

联系人、导入、数据库、记忆、检索及候选生成由 [Python 后端](../backend/README.md)提供。平台原生截图、OCR 与会话定位由 [Mac 原生探针](../native/macos/README.md)提供，Windows 平台适配尚未实现。

新 UI 继续遵守[产品边界](../CONTEXT.md)：用户确认联系人与读取范围、查看并编辑候选、亲自发送；后端接入后桌面退出必须停止本次后台读取。原 Swift 主界面已按 [ADR-036](../architecture/adr/036-retire-swift-main-interface.md) 退役，新宿主边界见 [ADR-037](../architecture/adr/037-electron-dual-window-host.md)。

已核对的官方接口资料：[Electron 安全](https://www.electronjs.org/docs/latest/tutorial/security)、[BrowserWindow](https://www.electronjs.org/docs/latest/api/browser-window)、[原生菜单](https://www.electronjs.org/docs/latest/api/menu)、[App 生命周期](https://www.electronjs.org/docs/latest/api/app)、[全局快捷键](https://www.electronjs.org/docs/latest/api/global-shortcut)、[系统文件选择器](https://www.electronjs.org/docs/latest/api/dialog)、[拖动区域](https://www.electronjs.org/docs/latest/tutorial/custom-window-interactions)、[资源协议](https://www.electronjs.org/docs/latest/api/protocol)、[打包器](https://electron.github.io/packager/main/)、[Playwright Electron](https://playwright.dev/docs/api/class-electron)。调度修复没有可用 Context7，回退核对 [Playwright 配置](https://playwright.dev/docs/test-configuration)、[Node Unix socket](https://nodejs.org/api/net.html)、[ChildProcess](https://nodejs.org/api/child_process.html)、[OS 用户信息](https://nodejs.org/api/os.html#osuserinfooptions) 和 [文件打开标志](https://nodejs.org/docs/latest-v25.x/api/fs.html#file-open-constants)。本轮实际 Node 25.2.1、安装的 Playwright 1.64.0 / Electron 44.7.0 与锁定文件一致；Playwright 的脱离进程组行为也与安装版本源码核对，只用于保守的归属探测，不据此终止未知组。前期真实 Electron 已有独立验收记录，本轮仅通过安全命令/类型检查，文档不能替代预约 App 验收。
