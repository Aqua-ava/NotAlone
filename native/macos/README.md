# Mac 微信同步探针

## 当前正式会话定位入口

按 ADR-049 的窗口边界、ADR-050 的单帧语义和 ADR-052 的顶部名称修订，正式 `--session --json --single-frame` 仅在微信前台取得当前唯一窗口的一帧，在本机内存分析布局，再只识别顶部名称。该入口与名称预览共用采集及OCR。兼容 `--minimal-region` 参数，正式路径不读取人工 profile、不 OCR 正文或左侧会话行，不保存或上传画面，不操作微信。

成功协议为 `automatic-header-v3`，包含图像取得时的 UTC `captured_at`、`display_name` 及 `quality` 中的 `layout_verified`、`display_name_confidence`、`name_complete`，不提供或伪造左侧名称。原始低分／截断文字可传递，正式后端仅在完整且置信度至少0.90时核验唯一私聊与已有确认绑定；旧单帧v2仍兼容，预览协议不能提供正式资格。识别后不再截第二帧，仍核对前台、窗口与几何，未知布局失败关闭。结果只描述采集时点，同窗切换可能由下一轮发现，不保证返回时仍在同一会话。

单次入口的实现及合成证据见[任务01](../../.scratch/foreground-contact-follow/issues/01-single-frame-locator.md)。连续跟随由任务04实施，真实 App、权限归属及耗时由任务06验收；此 README 和合成测试不证明实机集成已通过。

## 直接查看自动识别的会话名称

显式开发入口 `--preview-session-name` 打开“微信会话名称 · 自动识别”悬浮窗。无需提前填写姓名或确认绑定，将微信测试会话放到前台后，窗口直接显示顶部名称区域的实际 OCR 文字和置信度；每轮结束后休息2秒，不并发采集。此开发预览仅识别顶部，不识别左侧选中行，也不以0.90或名称一致性过滤原始文字。未知前台、识别失败、观察中或超过5秒的结果不显示为当前名称；切到其他应用即清名暂停，后续读到文字即可继续显示。

预览图像和名称仅在本机内存处理，不落盘、不上传、不输出终端；报告只含固定事件与聚合次数，不识别正文、访问CLI、数据库或模型。预览协议为 `preview-header-v1`，由同一正式顶部识别结果投影，不向正式定位接口提供身份或生成资格；正式观察保留完整性、0.90及已有绑定规则。浮窗不抢焦点，点击“结束”或最长20分钟后退出。仍由主Agent经有限 `test:app` 的 `tests/native-session-name-preview.spec.ts` 和 `NOTALONE_SESSION_NAME_PREVIEW=1` 启动。生命周期通过不能代替实际读名正确性或正式App绑定验收。

## 前台状态可视验收（无图像采集）

`--foreground-status --json` 是严格参数的开发诊断入口，不创建窗口，仅输出系统前台分类、正式前置检查及线程/GUI初始化布尔。正式观察将“未取得前台应用”投影为 `foreground_application_unavailable`，不再把未知当作确定的非微信前台；其他应用前台仍正常暂停。该失败不截图、OCR或读取微信窗口，GUI初始化布尔仅用于诊断，不授予采集资格。

显式开发入口 `--preview-foreground` 打开不主动激活的悬浮窗，每0.5秒显示系统前台分类与正式观察共用的采集前检查。用户切换微信/其他应用后，可记录自己的观察；过期或未知采样计为未验证，人工计数与机器采样分别报告。只查询前台及微信窗口元数据，不读取窗口标题，不截图、OCR、访问正文、CLI、数据库或模型；关闭即退出，最长8分钟。

启动仍由主Agent经桌面 `test:app` 的 `tests/native-foreground-status-preview.spec.ts` 和环境开关 `NOTALONE_FOREGROUND_STATUS_PREVIEW=1` 执行。该窗口只说明独立原生预览的前台检查，不认证正式Electron/HTTP状态传递或联系人匹配，也不授予视觉采集资格。实际显示和人工核对仍按本轮有限场次记录。

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

## 已退役的正文 OCR 诊断

旧默认采集、`--watch`、`--crop`、`--interval`、独立 `--show-text` 和历史 Swift 菜单栏正文诊断已退役；不再查询权限、捕获窗口或执行正文 OCR。无参数只展示帮助，`--self-test` 仅使用合成图片，不采屏或调用 OCR。`--session --show-text` 仅保留历史参数兼容，和 `--session` 一样不向终端输出名称。

正式定位使用顶部名称入口；微信不在前台、窗口不唯一或布局未知时拒绝该轮。日常开发和实际验收使用 `desktop/` 的 `npm run dev`，先执行 `npm run dev:status` 并复用已有实例。旧菜单栏目标只返回退役说明，不启动 App 或请求权限。

布局按需计算采样亮度，保持原有 DeviceRGB、预乘 RGBA、copy 绘制和整数公式。仅返回矩形的路径在返回前释放整帧像素，不跨轮缓存。合成基准只度量绘制及布局，不含捕获、OCR、IPC 或真实微信延迟，也不是 RSS 测量。

## 合成验证与计时

在仓库根目录先运行 `swift test --package-path native/macos`，再运行 `node --test native/macos/Tests/DiagnosticEntrypoints.test.mjs` 检查旧 CLI 入口拒绝及合成自检。入口测试不会运行正式观察或旧菜单栏 App。

使用 `$HOME/miniconda3/envs/NotAlone/bin/python native/macos/scripts/benchmark_layout.py --baseline <commit> --output <结果.json>` 对照指定基线与当前生产纯函数。驱动只构造合成 CGImage，以共享文件锁串行执行31组交错样本，保留源码摘要、原始样本、p50/p95和等价断言；临时可执行文件自动删除。调用前检查卷可用空间至少15 GiB，不把合成布局耗时或缓冲区推导解释成真实App延迟或RSS。
