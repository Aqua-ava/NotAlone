# Mac 微信同步探针

这是 NotAlone 的技术验证程序，不是正式产品。它包含一个保留给合成自检的命令行工具，以及一个带独立 macOS App 身份的菜单栏验证程序。两者都只在 Mac 微信处于前台时截取指定的聊天区域，在本地运行 OCR，并比较连续结果中的新增文本。

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

在本目录运行：

```bash
swift test
swift run notalone-sync-probe --help
swift run notalone-sync-probe --self-test
```

正常的完整 Xcode/Swift 工具链应使用上述 SwiftPM 命令。也可以用以下脚本
单独编译命令行程序并运行核心逻辑自检：

```bash
zsh scripts/build_cli.sh
./build/cli/notalone-sync-probe --self-test
./build/cli/notalone-sync-probe --help
```

`build/` 已被本目录忽略，不会进入版本控制。

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
