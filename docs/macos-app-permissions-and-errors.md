# macOS App 权限与启动错误记录

状态：维护中  
最后更新：2026-10-08
适用范围：`NotAloneApp.app`、`NotAloneSyncProbe.app`、`notalone-sync-probe` 和随主 App 打包的 `wechat-cli`

这是一份长期维护的权限与错误台账。凡是新增系统权限、修改权限说明文字、替换 CLI/探针、调整签名或新增用户可见错误，都必须先更新本文档，再更新代码、构建脚本和回归验证。

2026-10-08：旧 Swift 主窗口及其构建入口已按 ADR-036 退役，新 UI 尚未实现。本文中 `NotAloneApp.app`、`macos_app/` 和主 App 的权限／签名验收属于历史记录，不再是当前操作入口；独立原生探针仍保留。未来桌面宿主需重新记录权限归属和实际验收，不能直接继承旧 App 的验证结论。本次只删除源码与旧构建调用，不停止正在运行的程序、不修改 TCC、不删除本机旧构建产物或私人数据。

2026-10-08 目录整理：现有独立探针由 `macos_sync_probe/` 移至 `native/macos/`，Python 后端移至 `backend/`。本次只更新工程位置与调用路径，探针内部构建、bundle id、权限说明及签名策略保持原有行为；历史主 App 路径与验收记录保留。验证使用隔离构建与合成测试；普通构建遇到缓存中的旧绝对路径时，仅用 `swift package clean` 清理探针的 SwiftPM 生成缓存后重建，不清理独立 `build/` 产物，不运行或替换 App、不触发微信采集、不修改 TCC。

2026-10-08 只读 AX 可行性验证：用户明确要求先验证系统接口能否替代会话定位 OCR，并手动将测试会话置于微信前台。本轮使用 `research/wechat-ax-check.swift` 独立诊断程序，不接入正式探针或后端，不修改 App、签名、entitlements、TCC 或 App 权限声明。静默预检通过 `AXIsProcessTrusted()` 返回已授权；此结果只证明当前执行环境，不证明未来 Electron 安装包已获得权限。检查只在微信前台时读取窗口与控件结构，以及已知当前会话标题控件的最小属性，不读取消息正文、输入框、其他联系人行的文字，不点击、滚动、切换或发送。实际标题若可读也只在本地进程内短时处理，输出只有脱敏状态与计数；不截图、不上传或落盘。缺权限时停止，不自动申请。

实机结果为 macOS 15.7.5、微信 4.0.6.240（用户版本页；Bundle 元数据为 4.0.6、build 29387）：两次运行 `xcrun swift research/wechat-ax-check.swift --wait` 均返回 `chat_title_not_exposed`，分别检查 5、6 个控件，仅有窗口、组和标准按钮。第二次确认窗口数为 1、焦点窗口等于主窗口，未触发列表剪枝；子节点属性读取 4 次成功、2 次为 `AXError.noValue`，6 个控件的标识属性均为 `noValue`，没有找到 `big_title_line_h_view` 标题控件。这证明本次只读路径没有取得当前会话标题，不能推导为所有版本或其他访问方式都不可用。未验证选中状态、联系人绑定或 Windows，正式探针与 OCR 保留。`swiftc -typecheck` 与 `git diff --check` 通过；程序退出码 0 表示诊断完成，不表示 AX 会话定位可用。脱敏明细记录在被忽略的 `research/cross-platform-input-research-20261008.md`，无真实姓名或消息正文。

2026-10-08 AX 按位置补测：用户明确要求验证 `AXUIElementCopyElementAtPosition`，并确认已将微信会话置于前台、鼠标停在顶部会话标题。独立程序 `research/wechat-ax-point-check.swift` 只查询这个测试点，不移动鼠标、不截图、不点击、不扫描窗口。先核验微信进程、主窗口、顶部区域和鼠标稳定；只对该点命中的小型文字／标题按钮控件读取最小文本属性，窗口、组、输入框或正文区域不读文字。返回对象必须属于同一微信进程、主窗口和授权标题区域，焦点或鼠标变化时停止。坐标和实际文字只在本地进程内处理，输出仅含脱敏状态、标准角色和错误码。沿用已有辅助功能授权，不设置无障碍属性、不修改权限、签名或正式探针。

按位置实机结果：同一 macOS 15.7.5 / 微信 4.0.6.240（Bundle 4.0.6、build 29387），既有辅助功能授权仍有效。运行 `xcrun swift research/wechat-ax-point-check.swift --wait`，两次对用户指定点的查询均返回 `point_query_failed`、错误码 `-25208`；本机 Apple SDK 核对为 `AXError.notImplemented`。没有取得标题控件，也没有进入文字读取分支；此结果仅证明限定微信应用对象的这条按位置调用未通过，不代表所有 AX 功能都不可用。`swiftc -typecheck`、11 项合成范围检查（`--self-test`）及 `git diff --check` 通过，实机程序退出码 0 只表示诊断完成。没有访问数据库、调用 CLI 正文读取或改变绑定；正式探针及 OCR 保留。脱敏命令和结果续记于同一调研报告。

## 1. 产品边界

NotAlone 的本地读取必须满足以下条件：

- 只读取用户已确认绑定的微信联系人范围；联系人数据按 `owner_id + contact_id` 隔离。
- `wechat-cli` 只读读取本机微信数据；不得通过 CLI、后台进程或 Tool 发送微信消息。
- 屏幕采集只用于微信处于前台时定位当前会话；原始画面只在端侧内存中处理，不持久化、不上传。
- 权限申请必须对应明确功能，不能为了绕过错误而改成更宽泛的权限或要求用户开启 Full Disk Access。

## 2. 当前权限清单

历史主 App 记录了 P-01/P-02 两类权限；当前保留的独立探针使用 P-02。新主界面未实现，主 App 的权限配置路径已删除，不能照此构建。其他权限不应被 NotAlone 主动申请。

| 编号 | 权限 | 触发目标 | 配置位置 | 触发时机 | 允许后能做什么 |
| --- | --- | --- | --- | --- | --- |
| P-01 | 访问其他 App 的数据 | `NotAloneApp.app` 启动签名后的 `wechat-cli` | `macos_app/App/Info.plist` 的 `NSAppDataUsageDescription` | 用户开启 CLI 全量同步，并且后台需要读取已绑定会话时 | 通过本机只读 CLI 更新已绑定微信会话消息 |
| P-02 | 屏幕与系统音频录制 | 主 App 启动的前台同步探针，或独立菜单栏探针 | `macos_app/App/Info.plist`（历史）、`native/macos/App/Info.plist` 的 `NSScreenCaptureUsageDescription` | 用户进行前台微信会话定位/屏幕采集时 | 在微信前台读取当前窗口的会话标题、选中行和聊天区域定位信息 |

### P-01：访问其他 App 的数据

系统弹窗标题和说明目前是：

> “NotAloneApp.app”想访问其他 App 的数据。
>
> NotAlone 仅在你开启 CLI 全量同步后，通过本机只读 CLI 读取已绑定的微信会话数据，用于更新消息；不会发送消息或读取未绑定联系人。

这是 macOS 的正常授权入口。Apple 说明默认 AppData 授权只在 App 保持打开时有效，退出后会重置；稳定签名不能使这种默认授权永久保存。参见 [WWDC23 隐私说明](https://developer.apple.com/videos/play/wwdc2023/10053/) 和 [NSAppDataUsageDescription](https://developer.apple.com/documentation/bundleresources/information-property-list/nsappdatausagedescription)。同一次 App 运行中反复出现弹窗仍需排查进程生命周期、重复读取和签名，不能据此扩大权限。

2026-10-02 新诊断确认当前构建的 CLI 与动态库均完整且通过严格签名检查，不能沿用下述历史缺库结论。当前代码存在两项生命周期问题：复用既有后端时每轮轮询重复初始化会话列表；正常退出只管理自有子进程，复用后端继续读取。修复采用同连接初始化幂等和已认证回环 `POST /api/runtime/shutdown`，在当前同步读取正常停止后才确认成功；超时不得声称已停，不修改绑定或持久同步总开关，也不按 PID 猜测终止其他服务。

关闭期间的新业务请求以及此前排队的引擎操作必须拒绝重新读取，关闭操作幂等；认证 `GET /api/runtime/status` 返回 `running`、`stopping` 或 `stopped`，后两者只保留关闭协议与缓存状态查询。传输失联只重置初始化状态，仍保留本次已验证运行时的连接凭据用于有界关闭，不根据握手文件的后续变化去关闭另一实例。

嵌套签名改为动态库、helper、主 App 由内到外分别签名，分别保留各自 identifier；签名时不使用 `--deep`，验证时仍递归严格检查。Apple 明确指出 `--deep` 会把相同选项应用到全部嵌套代码，参见 [macOS 分发签名说明](https://developer.apple.com/documentation/xcode/creating-distribution-signed-code-for-the-mac/)。这些修复可用合成接缝与构建检查验证；同一次 App 运行授权后的真实读取仍须单独实机验收。

2026-10-02 修复验证：最终 App 重建及 App／探针严格签名通过；Swift 33 项、隔离全量 Python 1,141 项 OK（3 项跳过），36 个迁移通过，本次 `_test` 库清理完成。Standards 初评 2 项、Spec 初评 3 项，修复后两轴复审均 0 剩余。用户亲自允许后，20 秒实机采样未见重复 sessions 初始化，App→后端仅一条链；正常退出后 App、后端、读取进程及握手文件均清理。最后重新打开新版并恢复原联系人和草稿。此窗口的同步状态为 active、全局流在线；部分历史补齐仍报告 `cli_message_table_missing`，不能因此说全部历史已完整，也不能以短时进程采样保证永久无弹窗。

补充类型检查：三个后端源模块 `mypy` 当前报告 65 项；固定基线的影子文件对照同样 65 项，差分新增 0。测试及构建通过不替代未通过的静态类型检查，既有类型欠账仍保留。

#### 已记录的历史错误

2026-09-08 曾出现以下组合：

- 系统授权框持续重复出现；
- App 同步状态显示 `cli_command_failed`；
- CLI 失败输出中出现 `tool_error`；
- Follow 流显示未运行。

确认根因不是权限说明文案，也不是联系人绑定，而是 App 只打包了 `wechat-cli`，漏掉它运行时动态加载的 `libWCDB.dylib`。bundled CLI 启动即退出，同步流程反复创建失败访问进程，最终表现为权限框反复出现。

永久防线：

1. `macos_app/scripts/build_app.sh` 必须同时复制并签名 `wechat-cli` 与 `libWCDB.dylib`。
2. `BackendSupervisor` 通过 `WECHAT_CLI_WCDB_LIB` 显式传入动态库路径，不依赖 Finder 的工作目录。
3. 缺少动态库时不得留下半可用的 bundled CLI；后端应回退到完整的 PATH CLI。
4. 每次构建后必须验证 App、helper 和动态库的签名，以及 bundled CLI 的只读事件流能持续运行。

实现记录见：[App bundled CLI 运行时依赖修复](../.scratch/local-wechat-cli-observation/issues/09-app-bundled-cli-runtime-dependency.md)。

### P-02：屏幕与系统音频录制

这项权限只服务于前台同步探针，不等同于微信数据库读取权限。菜单栏探针启动时只检查权限，不会自动反复请求；用户点击“请求屏幕录制权限”后才调用 `CGRequestScreenCaptureAccess()`。

常见用户可见状态：

- `需要屏幕录制权限`
- `NotAlone: 请允许权限后重新检测`
- `未授予屏幕与系统音频录制权限。请在系统设置中允许启动探针的应用后重试。`
- 机器可读错误码：`screen_capture_permission_missing`

处理方式：

1. 打开“系统设置 -> 隐私与安全性 -> 屏幕与系统音频录制”。
2. 允许实际执行采集的、已签名的 NotAlone App/探针。
3. 回到菜单栏选择“重新检测权限”，不需要反复重启 App。

权限记忆依赖代码签名身份。`native/macos/scripts/build_app.sh` 和 `build_cli.sh` 优先使用本机稳定的 Apple Development 证书；退回 ad-hoc 时，每次重建都可能需要重新授权，不能把这种构建当作权限持久性验证。

## 3. 不应主动申请的权限

当前产品代码和 entitlements 未使用以下权限：

- Full Disk Access：不应要求用户开启；微信读取范围由只读 CLI 和已绑定联系人约束。
- Accessibility：当前产品不使用辅助功能控制微信，不点击、滚动、输入或发送。上方用户授权的独立 AX 诊断只验证最小会话定位属性，使用当前执行环境的既有授权，不扩大为正式产品权限或微信操作能力。
- Automation / Apple Events：不控制其他 App 的 UI，不添加自动化权限。
- 摄像头、麦克风、通讯录、定位、蓝牙、日历和提醒事项：当前功能不需要。
- 网络访问权限：主流程只访问本机 `127.0.0.1` 后端，不因本地 HTTP 请求要求额外系统权限。

JSON 导入使用用户主动打开的文件选择器，只读取用户选择的文件；这不是启动时的系统权限申请，也不能扩展为扫描用户文件系统。

## 4. 错误对照表

| 用户看到的现象/错误码 | 含义 | 优先检查 | 不要做什么 |
| --- | --- | --- | --- |
| “想访问其他 App 的数据”反复弹出 | 跨 App 运行的默认授权会重置；同次运行还可能有重复初始化、遗留后端或签名/打包问题 | 完整运行时、各嵌套 identifier、已认证连接初始化次数、退出停读及只读流是否存活 | 不要声称稳定签名等于永久授权，不要要求 Full Disk Access |
| `cli_command_failed` / `tool_error` | CLI 已启动但命令失败 | 直接运行 `--version` 和只读 `tail`；查看是否缺动态库、CLI 版本不兼容或微信状态不可读 | 不要把原始 stderr、聊天正文或凭据显示到 UI/日志 |
| `cli_not_found` | 找不到 CLI | bundled helper、`PATH`、`NOTALONE_WECHAT_CLI` | 不要静默换成未签名的临时构建 |
| `cli_timeout` | CLI 超时 | 微信是否可读、进程是否残留、当前操作是否超出超时边界 | 不要无限创建新的 CLI 子进程 |
| `cli_output_invalid` | CLI 返回不符合 JSON/事件契约 | CLI 版本和输出协议 | 不要猜测或继续写入消息 |
| `cli_key_refresh_required` | 本机 CLI 读取密钥需要刷新 | 按 CLI 自身的本机密钥刷新流程处理 | 不要在 NotAlone 中保存或回显密钥 |
| `cli_message_table_missing` | CLI 能运行，但微信本地库找不到当前已绑定会话的消息表；覆盖范围无法确认 | 当前会话在本机微信的可用消息范围，后续实际消息事件或用户显式重试 | 不要据此声称没有消息、补齐成功；不推进游标、不改绑、不读取别的会话 |
| `screen_capture_permission_missing` | P-02 未授权 | 系统设置中的屏幕与系统音频录制开关、实际签名主体 | 不要改成 Accessibility 或要求 Full Disk Access |
| `probe_not_found` / `probe_timeout` / `probe_output_invalid` | 前台定位探针不可用、超时或输出损坏 | 探针路径、签名、探针自检和前台状态 | 不要猜测当前联系人，也不要把错误联系人写入数据库 |
| `后端不可用` / `后端状态读取失败` | 本地 `notalone-server` 未启动、握手失败或 API 超时 | `~/.notalone/backend.info`、后端 PID、`127.0.0.1` API | 不要把后端连接问题误判为 macOS 权限问题 |
| `无法连接后端`（握手地址无效） | 握手 address 不是合法的 `127.0.0.1:端口`，客户端在请求前安全拒绝 | 本机后端启动和握手格式；端口须在 1–65535 | 不回显地址或 token，不接受外部主机，不请求新权限 |
| `聊天资料导入失败，请核对文件和联系人后重试。` / `import_commit_failed` | 导入提交端点返回已知业务失败，不能显示为回复拒绝 | 用户主动选择的文件和联系人、后端导入状态 | 不回显响应原文、文件路径或数据库错误，不因此修改绑定或请求额外权限 |
| `消息暂时无法接续，请重新加载。` | 桌面对账无法与旧显示区间衔接，或分页游标异常；不是数据库丢消息的证明 | 在当前联系人重新加载消息列表，核对本机后端状态 | 不无限扫描历史、不回显正文或游标，不扩大联系人范围或请求额外权限 |
| `runtime_stopping` / `后端关闭未获确认` | 运行时正收尾，或未在有界时间内确认停读 | 同一已验证回环连接的运行状态、正常退出清理 | 不得把超时当已停，不得猜 PID 杀复用实例，不改持久同步总开关 |
| `后端返回错误状态 500`（生成候选时） | 模型运行或 Skill 辅助资源读取失败；不是 macOS 权限弹窗 | 模型服务连通性、Skill 资源是否属于当前版本、是否出现重复 `read_file`；先重试候选生成 | 不要反复点击权限允许，不要回显模型原始错误，也不要因此发送消息 |
| `回复生成超时` / `本次生成尝试过多` | 模型或只读 Tool 在本次有界运行内未完成 | 运行预算、模型响应、Skill 资源反馈和候选请求台账 | 不要把未完成请求当成已生成或已发送 |
| `Follow 流：未运行` | Follow 当前没有启动或已退出 | Follow 控制状态、CLI 可用性和用户是否启动人工验证 | 不要把状态文字当作消息发送失败，也不要自动发送消息 |

适配层只向 UI 暴露稳定错误码和安全说明，不回显 CLI 原始输出、数据库路径、完整会话标识、聊天正文或凭据。相关实现：[CLI 错误定义](../backend/src/notalone/wechat_cli/errors.py)、[前台探针适配器](../backend/src/notalone/front_sync/probe_adapter.py)。

2026-10-03 桌面连接修复范围：握手解析、普通 HTTP 客户端和 SSE 共用回环地址校验；直接构造非法连接也在请求前返回既有安全连接错误，避免强制解包崩溃。验证只使用合成握手、临时路径和合成本机服务；不读取真实 backend.info、不启动 App 或微信读取进程、不改变权限／签名，不替换当前 App。独立临时构建目录中的 Swift 37 项与真正 App 目标编译通过，Standards／Spec 两轴均 0；打包与实机集成不在本轮验证范围。详细红绿过程和命令见 [连接地址修复任务](../.scratch/native-app-backend/issues/17-validate-backend-connection.md)。

2026-10-03 导入错误分类修复完成：仅对导入提交端点的 `409 import_commit_failed` 显示上述固定中文说明；未知或非法 409 保持普通状态错误，真实回复端点沿用原拒绝原因。测试接缝为公开 `importCommit` 和错误说明，只使用合成本机 HTTP 响应，不读取或导入真实文件，不触发记忆提取。7 项导入回归、完整 Swift 44 项和真正 App 目标编译通过，Standards／Spec 及夹具补审均 0。首次全量验证因新增合成服务的退出等待卡住而中止；夹具启动与回收统一到 MainActor 后，相关与全量重跑通过，生产协议未变。详细过程见 [导入错误分类任务](../.scratch/native-app-backend/issues/18-import-error-classification.md)，未进行打包替换或实机验证。

2026-10-01 继续验收时，CLI 1.6.20 对一个可唯一解析的确认绑定连续返回
`table <REDACTED> not found in 9 message shards`，该绑定无既有游标；
同一 helper 读取一位已有游标的联系人正常。将明确的消息表缺失分类为
`cli_message_table_missing`，补齐保持“无法确认完整性”，不解释成成功空结果。
原始错误中的表名和会话标识不展示或保存，不请求额外权限。
同步管理顶部复用同一安全说明展示“最近读取问题”，避免长会话列表
遮挡覆盖异常；详细补齐卡片仍保留原有阶段、计数和用户控制。

### 已记录的启动崩溃：后端进程重启

2026-10-01 自主启动验收中，主 App 连续意外退出。系统报告为
`SIGABRT`，关键调用链为 Foundation `COPY_SETTER_IMPL` →
`BackendSupervisor.launch` → `AppModel.ensureBackendLaunched`。
当时运行的 `.app` 是 2026-09-09 构建，早于当前源码中的握手路径和并发启动修复。

验证与修复范围：用当前源码重建稳定签名 App；通过合成后端和公开
`launch` / `terminate` 接缝核验顺序重启。Foundation `Process` 每个实例
只能运行一次，后端重启应创建独立进程、管道与回调状态；旧进程回调
不得覆盖新进程连接或错误。不为此新增权限，不改微信绑定或用户配置。
自动化重启回归和重建后实机结果记录于本次验收规格。

本轮已通过 3 项重启回归；重建后的原生 App 完成两位合成联系人的导入、
记忆管理、真实模型候选和依据展示。App 与两个 helper 的严格签名检查通过，
恢复普通环境后全局会话流在线。真实微信新增消息延迟仍未端到端验证；
旧业务库的迁移账本和历史补齐失败另行记录，不将启动成功视为全部集成可用。

同轮发现手工打包脚本漏编译新增加的导入来源列表与回复依据视图，导致
`ImportedSourcesView` / `ReplyEvidenceCard` 找不到而无法构建。打包应收集
两个 Swift 目标中的全部源文件，并显式使用与 Swift Package 一致的 Swift 6
语言模式；固定构建检查必须编译真正的 App，而不只运行核心库测试。

2026-10-03 初始化恢复修复完成：首次 setup 查询短暂失败时，使用既有轮询重试；成功查明状态后停止重查，未初始化时仍等待用户完成向导。进行中防重入，连接更换、真实断线和退出后旧结果失效；后续同步状态与关闭等待返回后再次检查有效性，不能因旧结果启动新连接的订阅或重启新后端。同连接 attach 幂等保留，手动首启提交共享请求有效性检查。沿用既有安全错误说明，不新增权限、读取范围或外部连接。公开 Core 初始化恢复 9 项与既有连接回归通过，完整 Swift 53 项通过；Standards 初评仅一项重复登记的维护性建议，私有函数合并后最终 Standards／Spec 均 0。不读取真实资料、不替换运行中的 App；真实界面及事件通道未端到端验收。App 目标编译与具体命令记录见 [初始化恢复任务](../.scratch/native-app-backend/issues/19-recover-setup-subscription.md)。

2026-10-03 桌面分页修复完成：初次与历史分页仍每页 50 条，对账与历史游标独立；每轮最多补 10 页、一次累计最多 20 页，未衔接段先在端侧内存缓冲。到限、游标异常或无衔接末页时使用上述固定提示，保留已显示列表并等待用户重载。失联／换连接废弃旧请求和缓冲，保留已提交列表与历史游标；联系人切换、来源清空或用户重载重置完整分页。沿用原联系人权限与删除行为，不新增权限、持久化或外部连接。10 项合成分页测试与完整 Swift 63 项通过，真正 App 目标编译通过；审查提出一处重复请求登记建议，合并后相关复验通过，最终 Standards／Spec 均 0。未替换当前 App，真实界面与消息通道未端到端验收。审查与命令证据见 [消息分页任务](../.scratch/native-app-backend/issues/20-message-pagination-continuity.md)。

2026-10-04 菜单栏状态轮询修复完成：初次和 Timer 同步领取 Core 单请求资格后才创建任务；连接更换／握手缺失／退出取消旧查询并忽略其成功、错误和清理，手动操作结果使此前轮询失效。仅自动状态 GET 的请求与资源超时设为 5 秒，超时沿用既有“后端不可用”安全提示，POST 开关／检查保留原等待方式。新 Core 纳入 App／CLI 手工和 Xcode 源清单，不修改签名或权限。相关 14 项与完整探针 35 项通过；SwiftPM App 编译、脚本语法／源码清单与禁用签名的 Xcode 双架构构建通过，Standards／Spec 均 0。Xcode 保留既有 bundle identifier、最低系统版本不一致及跳过 AppIntents metadata 三条警告。测试只用合成接缝，不新增正文读取或持久化；未运行／替换 App，真实 UI、HTTP 超时和微信集成未端到端验收。详细结果见 [菜单栏轮询任务](../.scratch/native-app-backend/issues/21-menubar-status-polling.md)。

## 5. 构建前后的固定检查清单

2026-10-02 的记忆日期展示重建沿用现有 P-01/P-02、bundle id 和稳定签名，
不新增权限或修改 helper。当前 PATH 中的 CLI 安装入口不可用时，先把当前 App
中已验证的 `wechat-cli` 与 `libWCDB.dylib` 复制到仓库外临时目录，将该目录作为
本次构建子进程 PATH 的前缀并显式传入库路径，再运行唯一打包入口；构建前退出 App，
构建后核验完整 helper 与签名，避免打包脚本移除旧副本后失去可用运行时。
此操作只保留既有二进制，不复制微信数据、密钥或配置，也不更改全局 PATH。

### 旧主 App 构建检查（历史，入口已删除）

2026-10-02 来源语义核验验收重建只调整记忆置信度说明与待处理标题，沿用上述
临时 helper 保全流程、现有 P-01/P-02 与稳定签名，不新增权限或改变绑定。

- [ ] 只使用 `zsh macos_app/scripts/build_app.sh` 构建主 App。
- [ ] 主 App 的 `Contents/Info.plist` 保留 P-01/P-02 两个说明键，文案和本文档一致。
- [ ] `Contents/Helpers/wechat-cli` 存在且可执行。
- [ ] `Contents/Helpers/libWCDB.dylib` 存在且可读。
- [ ] 核心库、helper、运行时库和主 App 使用稳定签名，各自 identifier 分别为 `com.notalone.app.core`、`com.notalone.wechat-cli`、`com.notalone.wechat-cli.wcdb` 和 `com.notalone.app`；无稳定证书时明确标记为 ad-hoc。
- [ ] 运行 `codesign --verify --deep --strict --verbose=2 macos_app/build/NotAloneApp.app`。

### 当前自动化检查

- [ ] 从仓库根目录运行 `swift test --package-path native/macos -q`。
- [ ] `conda activate NotAlone` 后运行相关 Python 合成测试。
- [ ] `git diff --check`。

### 旧主 App 人工验收（历史，新宿主需重新验证）

- [ ] 干净启动新构建的主 App并允许 P-01：同一次运行检查是否仍随同步轮次重复出现；退出后重新申请属于 macOS 默认授权期限，不据此宣称失败或永久授权。
- [ ] P-01 授权后，只能看到已绑定范围的只读同步；不发送消息。
- [ ] P-02 由用户明确点击请求，授权后用“重新检测权限”恢复，不重复弹窗。
- [ ] 微信不在前台、会话无法定位或权限缺失时，系统应失败关闭，不猜测联系人。
- [ ] 选中已绑定联系人的消息或输入改写草稿后，候选生成显示 1-3 条可编辑文本、依据和引用；生成失败不触发任何外部发送。
- [ ] 真实微信验收与本地自动化分开记录；自动化通过不能代替用户手动操作微信。

## 6. 新增权限或新弹窗时的变更规则

发现新的系统弹窗或用户可见错误时，先记录以下信息，再改代码：

1. 弹窗标题和完整说明文字。
2. 触发它的 App bundle id、可执行文件、父进程和具体用户动作。
3. 是首次申请、重复申请，还是权限已有但功能失败。
4. 读取范围、写入范围和是否会接触真实联系人数据。
5. 可复现命令、稳定错误码、最小回归测试和人工验收步骤。

然后同步更新：

- 本文档的权限清单和错误对照表；
- 对应 `Info.plist`、entitlements 和构建/签名脚本；
- 自动化回归测试；
- 当前桌面宿主的 README（实现后）或 `native/macos/README.md` 的用户操作说明；
- 对应 `.scratch/` 任务文件及验证结果。

未经上述记录和验证，不得把新的系统权限申请直接交给用户处理。
