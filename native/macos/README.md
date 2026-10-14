# Mac 微信同步探针

## 当前正式会话定位入口

按 ADR-049 的窗口/区域边界及 ADR-050 的单帧修订，正式 `--session --json --single-frame` 仅在微信前台取得当前唯一窗口的一帧，在本机内存分析布局，再只识别同帧顶部和选中行名称。兼容 `--minimal-region` 参数，正式路径不读取人工 profile、不 OCR 正文或其他列表，不保存或上传画面，不操作微信。

成功协议为 `automatic-window-v2`，包含图像取得时的 UTC `captured_at` 及两处名称质量。识别后不再截第二帧；仍核对前台、窗口与几何，名称不一致/低分及未知布局失败关闭。结果只描述采集时点，同窗切换可能由下一轮发现，不保证返回时仍在同一会话。新宿主要求显式单帧参数，旧二进制在采集前拒绝；后端不将旧协议自动确认成单帧观察。

单次入口的实现及合成证据见[任务01](../../.scratch/foreground-contact-follow/issues/01-single-frame-locator.md)。连续跟随由任务04实施，真实 App、权限归属及耗时由任务06验收；此 README 和合成测试不证明实机集成已通过。

## 历史校准与验证记录

以下保留旧 profile、正文诊断及菜单栏试验的历史说明，不能作为现行正式 session 的采集约束或运行证据；现行入口以上述说明及[桌面说明](../../desktop/README.md)为准。

这是 NotAlone 的技术验证程序，不是正式产品。它包含一个保留给合成自检的命令行工具，以及一个带独立 macOS App 身份的菜单栏验证程序。两者都只在 Mac 微信处于前台时截取指定的聊天区域，在本地运行 OCR，并比较连续结果中的新增文本。

当前 CLI 的 `--session --json`、追加 `--minimal-region` 和文字 `--session` 共用采集前安全门禁。缺少受控 `NOTALONE_FOREGROUND_LAYOUT` 指向的0600已验证profile时，在创建 App、检查权限或读取窗口前返回 `minimal_region_layout_unverified`。候选新增逐区display filter采集、细条摘要前后复验、两处名字与置信度输出；不会回退整窗捕获。17:06–17:16的唯一现场校验未通过、未形成profile，真实裁剪与质量仍未证明；旧诊断、watch 和菜单栏路径不能作为新宿主定位或权限证明。

新增首片 `--calibrate-minimal-region --json` 由 Electron 的“窗口 → 校准微信最小定位区域…”菜单显式调用。它等待用户手工打开微信4.0.6（29387）的唯一前台窗口，仅在该窗口上显示透明框选器，用户按说明选两处名字和三条无文字细条并确认。只输出当前版本、进程/窗口标识及相对窗口几何；不调用ScreenCaptureKit、Vision、AX、微信输入或网络，不请求系统权限。取消、超时、跨屏、版本或窗口变化均不产生新选择。主进程保存的状态为 `selected-awaiting-verification`，不证明可信布局、OCR质量或自动绑定，不被session路径消费。

2026-10-10 的真实 App 坐标校准已通过公开菜单与表单：用户再次明确要求直接操作电脑后，主 Agent 在16:39–16:49（UTC+8）、预算1次的有限现场轮次查看当前微信窗口、填写五处几何并提交。实际测试1/1通过（30.9秒），只保存0600待校验选择，正常菜单退出；自有App、隔离目录已回收，租约absent。电脑控制画面未写入仓库，不是探针最小采集、可信布局或自动绑定证据；session门禁保持关闭。早期菜单不可用和框选超时的失败证据保留，拖动框选尚无成功实机验收。

同一菜单现有“输入坐标”路径，提供可访问的窗口宽高与五处区域表单，区域以相对窗口左上角的点坐标表示。探针 `--calibrate-minimal-region --json --coordinates` 从stdin接受最多4096字节、只含schemaVersion/windowSize/regions的JSON，严格校验字段、有限数值和原几何限制，核对唯一微信4.0.6（29387）窗口的实际尺寸及前后元数据一致，再输出待校验选择。表单可在NotAlone前台使用，因为原生端仅查询窗口元数据；没有截图、OCR、微信控制或联系人确认。此路径不验证画面或跨屏布局，不被session采集消费。

16:21–16:31（UTC+8）预算1次的早期坐标轮次未保存选择，到期返回124/1 interrupted。后续成功轮次的临时固定阶段诊断确认表单提交、原生校验与保存均完成；早期失败根因仍未知，不宣称已定位并修复。临时诊断已移除，既有成功阶段文件只作为本轮测试产物保留。源码与构建检查不能代替后续真实最小采集、OCR质量和新宿主权限验收。

它不会：

- 保存原始截图；
- 写入 NotAlone 正式聊天历史；
- 调用模型或网络服务；
- 读取微信数据库、切换会话、滚动聊天、写入输入框或发送消息。

## 前置条件

- macOS 15 或更高版本；
- Swift 6 命令行工具；
- Xcode 16.4，以及已在 Xcode 中登录的 Apple Account Personal Team（用于稳定的开发签名）；
- 已打开 Mac 微信，并切换到一个无敏感内容的测试会话；
- 在“系统设置 -> 隐私与安全性 -> 屏幕与系统音频录制”中，允许运行 `swift` 的终端或宿主应用截取屏幕。

首次测试请使用测试消息，不要使用真实私人聊天内容。

## 构建与测试

在本目录运行（从仓库根目录先 `cd native/macos`）：

```bash
swift test
swift run notalone-sync-probe --help
swift run notalone-sync-probe --self-test
```

若搬迁目录后出现 `PCH was compiled with module cache path`，先在本目录运行 `swift package clean` 清理生成缓存，再重新构建；它不会清理 `build/` 中的独立 App 或 CLI 产物。

正常的完整 Xcode/Swift 工具链应使用上述 SwiftPM 命令。也可以用以下脚本
单独编译命令行程序并运行核心逻辑自检：

```bash
zsh scripts/build_cli.sh
./build/cli/notalone-sync-probe --self-test
./build/cli/notalone-sync-probe --help
```

`build_cli.sh` 默认明确使用 ad-hoc 签名，不扫描钥匙串或自动选择证书。未来如需指定签名身份，可显式设置 `NOTALONE_PROBE_SIGNING_IDENTITY`；这不会证明稳定的屏幕录制权限或可分发性。当前阶段仅完成源码与纯逻辑验证，未执行该脚本、签名或原生采集。

`build/` 已被本目录忽略，不会进入版本控制。

## `--session --json` 输出契约

`notalone-sync-probe --session --json` 把结果写成一行 JSON 信封，**无论成功、权限缺失还是定位失败都以退出码 0 结束**；调用方必须读 `ok` 字段，而不是退出码：

- `ok=true`：`wechat_in_front` 等字段有效；
- `ok=false`：`error_code` 给出稳定分类（如 `screen_capture_permission_missing`、`wechat_not_frontmost`、`selected_row_not_found`、`probe_failed`），`message` 给出面向用户的说明。

Python 侧的探针适配器（`src/notalone/front_sync/probe_adapter.py`）就是这样判定的：先解析 stdout，再检查 `ok`，因此权限缺失与定位失败也能带着结构化原因返回给调用方。不带 `--json` 的纯文本模式仍按命令行惯例返回非零退出码。

## 菜单栏 App 验证

菜单栏 App 已降级为轻量状态入口：不再每 3 秒拉起 `notalone-front-sync`
子进程轮询，而是查询常驻后端（`notalone-server`）的 `/api/sync/*` HTTP
端点；同步开关与“立即检查一次”同样经后端 API 生效。旧 Swift 主窗口已退役，
当前调试需要在仓库根目录激活 `NotAlone` conda 环境后手动运行
`notalone-server`；关闭调试时在该终端按 Ctrl-C 停止后台，退出菜单栏程序
不代替停止这个独立后台。连接信息经握手文件（`~/.notalone/backend.info`，可用
`NOTALONE_BACKEND_INFO` 覆盖）发现；后端不可用时菜单栏标题给出清晰
提示。绑定候选只在菜单中展示计数；当前确认入口使用 CLI
`notalone-front-sync confirm-binding`，新主界面后续另行设计。

自动状态查询仍每 3 秒触发，同一连接同时最多一个请求；上一轮未结束时
跳过本轮，不积累等待任务。每轮检查握手，后端换代、握手缺失或退出时取消
旧查询并忽略其晚返回结果。状态 GET 的请求与资源超时均为 5 秒，超时沿用
“后端不可用”提示，下一轮可重试；手动开关和“立即检查一次”保留原等待方式，
其结果不会被更早的自动查询覆盖。此查询只访问本机后端，不采集消息正文。

命令行进程在当前 Codex 运行环境中无法稳定收到 ScreenCaptureKit 的截窗回调，不能作为真实采集验证的载体。真实权限验证应从 Xcode 启动已签名的独立 App：

1. 在 Xcode 打开 `Xcode/NotAloneSyncProbe/NotAloneSyncProbe.xcodeproj`。
2. 选择 `NotAloneSyncProbe > My Mac`，按 `Cmd-R` 运行。
3. 菜单栏出现 NotAlone 后，点击“请求屏幕录制权限”。

此工程使用 `com.javahello.notalone.NotAloneSyncProbe` 作为稳定的 bundle id，并以当前 Personal Team 的 `Apple Development` 证书签名。首次获准后，后续在同一工程内修改、重新构建和运行，不应再被 macOS 当作临时 adhoc App。

以下脚本仍可用于离线编译检查，但它会生成 adhoc 签名的 App，因此不要拿它验证屏幕录制权限持久性：

```bash
zsh scripts/build_app.sh
open build/NotAloneSyncProbe.app
```

首次启动时，若尚未获得授权，菜单栏会显示“需要屏幕录制权限”。用户可点击“请求屏幕录制权限”触发 macOS 的授权流程；在系统设置中允许后，点击“重新检测权限”即可启动观察，无需重启 App。

- `等待微信前台`：未采集；切换到其他 App 时也会回到这个状态。
- `微信画面未变化`：仍在当前微信会话，但不会再次运行 OCR。
- `无法确定聊天区域`：没有可靠找到左侧会话列表、顶部标题栏或底部输入栏的边界；本轮不会猜测范围或运行 OCR。
- `识别 N 行，新增 M 行`：仅显示计数，聊天正文不会出现于界面、日志或磁盘。

菜单中的“查看本次 OCR 文本”由用户主动打开。它会显示最近一次 OCR 的原始文本片段、临时说话人判断和置信度，方便逐项和微信画面对照；结果只保留在 App 内存中，退出 App 后清空。打开该窗口会让 NotAlone 成为前台应用，因此同步会暂停，直到你切回微信。

菜单中的“查看本次裁剪范围”同样由用户主动打开。它在最近一次内存画面上以红线标出左侧会话列表、顶部标题栏和底部输入栏三条边界，并以红框标出实际 OCR 区域，便于验证只有中间的消息内容被识别；预览不会保存为图片文件。

App 运行期间，你可以切到微信的无敏感测试会话。它不会切换会话、滚动、输入、点击或发送微信消息。菜单栏的“退出验证”会停止观察。

单次、默认不显示 OCR 正文的检查：

```bash
swift run notalone-sync-probe
```

持续观察并明确要求在终端显示 OCR 结果：

```bash
swift run notalone-sync-probe --watch --show-text
```

使用上方临时编译方式时，将命令中的 `swift run notalone-sync-probe` 替换为
`./build/cli/notalone-sync-probe`。

菜单栏 App 首次捕获时会动态定位左侧会话列表、顶部标题栏和底部输入栏三条边界，随后复用它们的位置；只有窗口尺寸变化或任一边界被拖动时才重新扫描。它不使用固定比例。命令行工具保留 `--crop x,y,width,height`，仅用于显式的算法诊断，例如：

```bash
swift run notalone-sync-probe --watch --crop 0.38,0.16,0.58,0.70
```

## 当前验证目标

1. 微信前台时能捕获窗口；切换到其他 App 后不采集。
2. 能动态定位左侧会话列表、顶部标题栏和底部输入栏三条边界；任一边界移动后重新定位。
3. 无法可靠定位时不运行 OCR，也不读取会话列表、标题栏或输入栏。
4. 画面变化后，本地识别可见文本，并按左右位置给出临时说话人分类。
5. 同一段 OCR 文本不在同一次探针运行中重复报告。

这只是视觉能力验证。它尚未处理多行气泡聚合、可靠时间戳、会话标题匹配、正式持久化或联系人绑定。

候选公开菜单“校验微信最小定位区域…”仅静默预检权限，最多等待60秒微信回到前台。校验已选五处区域后写入0600 profile；新选区或重校验先撤销旧profile。原始小帧仅内存，后端质量解析已准备，自动绑定及小窗自动采用仍未完成。纯布局3项、session参数4项通过不等于真实裁剪通过。ScreenCaptureKit接口已与本机SDK及[Apple sourceRect](https://developer.apple.com/documentation/screencapturekit/scstreamconfiguration/sourcerect)、[SCContentFilter](https://developer.apple.com/documentation/screencapturekit/sccontentfilter)、[captureImage](https://developer.apple.com/documentation/ScreenCaptureKit/SCScreenshotManager/captureImage%28contentFilter%3Aconfiguration%3AcompletionHandler%3A%29)核对；文档不能代替实机。

现场失败后补充 `verification_stage` 固定阶段，并在主进程保存0600 `foreground-layout-verification.json`：只含状态、安全错误码与固定阶段，不能携带原生输出、名称或图像。窗口未取得前台、几何变化、权限缺失、OCR质量和采集失败分别说明；结果不授予采集资格。公开App用例等待该结果后立即核对成功或失败，不以等待profile超时替代原因。此诊断补丁已通过类型、构建与纯测试，尚未新跑真实校验。
