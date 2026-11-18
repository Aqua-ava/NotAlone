# Mac 微信前台定位探针

本目录提供正式前台名称定位与显式开发诊断。产品读取和授权合同见[微信同步](../../architecture/current/wechat-sync.md)，实际 App 验收使用[桌面热更新入口](../../desktop/README.md#日常开发热更新)，先核验 `pnpm run dev:status` 并复用实例。

## 当前正式会话定位入口

正式 `--session --json --single-frame` 仅在微信前台获取当前可见唯一窗口的一帧，在端侧内存分析布局，再只识别顶部名称；兼容的 `--minimal-region` 不恢复人工 profile 依赖。它不 OCR 正文或左侧会话行，不保存或上传画面，不操作微信。

宿主通过 `--session-worker --json` 复用观察进程。启动先对一张 `800×72` 合成名称图做本机 Vision 预热，不请求录屏或采集微信；完成后发送唯一 ready 行。预热中到达的真实请求由上层报告 `probe_warming`，不伪装为已经完成的本轮 OCR。显式 `NOTALONE_SESSION_WORKER_MEASUREMENTS=1` 只输出固定预热阶段与单调时间，不输出文字或图像。

当前成功协议为 `automatic-header-v4`，包含实际图像取得时点 `captured_at`、`display_name`、布局完整性和原始置信度。旧 v3／v2 的兼容范围由正式适配器判断，预览协议不能授予正式资格。识别后不截第二帧，仍复核前台、窗口与几何；结果只描述采集时点，同窗切换可能由下一轮发现。

后端按 ADR-132 核验完整标题、有界名称匹配与配置账号的既有稳定绑定。原始 0.30／0.50 不单独阻断，无关群名缺失不作全局门；真实歧义、不完整标题、失证、过期和分支质量失败仍拒绝。低于 0.30 的无回退顶部输入、文字回退和旧双名称协议仍各有质量合同，不能把预览看见文字当成身份认证。

代码入口：[单帧采集](Sources/NotAloneSyncCore/AutomaticSessionCapture.swift)、[工作进程](Sources/NotAloneSyncCore/SessionObservationWorker.swift)、[后端定位器](../../backend-ts/src/foreground/foreground-location-locator.ts)。安全合成测试见 [SessionCaptureSafetyTests.swift](Tests/NotAloneSyncProbeTests/SessionCaptureSafetyTests.swift)，不替代实际窗口、权限或微信验收。

## 直接查看自动识别的会话名称

`--preview-session-name` 是独立开发预览，不需要预先提供姓名或建立绑定。悬浮窗显示顶部实际文字与置信度，每轮结束等待两秒，不并发；未知前台、观察中、失败或超过五秒时清名，离开微信暂停。它不以统一 0.90 门槛过滤原始显示。

预览名称和图像仅在内存，报告仅有固定事件与聚合计数；不读取正文、CLI、数据库或模型。`preview-header-v1` 不授予联系人或生成资格，最长二十分钟，明确结束或关闭后释放。既有测试文件 `desktop/tests/native-session-name-preview.spec.ts` 仅是显式诊断夹具，执行前核对其现场及开发模式兼容条件；当前产品验收仍在 `pnpm run dev` 中核对。

## 前台状态可视验收（无图像采集）

`--foreground-status --json` 只输出前台分类、正式前置检查及初始化布尔；未知前台与确定非微信分别表达。`--preview-foreground` 是非激活浮窗，每 0.5 秒展示相同元数据，最长八分钟。两者均不采图、OCR、读正文、访问 CLI 或调用模型，不请求权限。

观察和人工核对分别记录。独立诊断通过不认证 Electron／HTTP 状态传递或联系人匹配；实际 App 与微信操作按[桌面验收](../../docs/agents/engineering.md#桌面验收)协调，不使用历史签名包替代热更新实例。

## 前置条件

- macOS 15+，Swift 6 工具链及对应本机 SDK；具体目标见 [Package.swift](Package.swift)。
- 合成自检不需要打开微信或录屏权限。真实观察只在任务明确范围内使用测试会话，并由实际宿主取得系统录屏许可。
- 构建前核对输出卷和临时卷至少 15 GiB 空间；权限和签名排查见[指南](../../docs/guides/macos-app-permissions-and-errors.md)。

## 构建与测试

从仓库根目录执行最小相关检查，按需扩大：

```bash
swift test --package-path native/macos --filter <测试名>
swift test --package-path native/macos
node --test native/macos/Tests/DiagnosticEntrypoints.test.mjs
```

显式编译独立 CLI 并查看合成自检／帮助：

```bash
zsh -f native/macos/scripts/build_cli.sh
native/macos/build/cli/notalone-sync-probe --self-test
native/macos/build/cli/notalone-sync-probe --help
```

`build_cli.sh` 默认 ad-hoc 签名，不自动选择证书；自检不采屏或调用 OCR。开发资源的完整准备入口见[仓库探针与核心库](../../desktop/README.md#仓库探针与核心库)。这些原生构建不构成打包或发布验收授权。

若搬迁后出现模块缓存路径错误，先核对缓存归属，再在本目录用 `swift package clean` 清理本项目 SwiftPM 生成缓存；它不清除独立 `build/` 产物或业务资料。所有构建目录均不提交。

## `--session --json` 输出契约

JSON 模式返回带 `ok` 的单行信封；调用方必须解析协议结果，不能只凭进程退出码判成功。`ok=false` 使用固定 `error_code` 分类，成功字段也须核验协议版本、范围、新鲜度和质量。TypeScript 消费入口见[前台定位模块](../../backend-ts/src/foreground/foreground-location-locator.ts)，旧 Python 适配器不在当前运行路径。

## 已退役的正文 OCR 诊断

旧默认采集、`--watch`、`--crop`、`--interval`、独立 `--show-text` 和 Swift 菜单栏正文诊断已退役。无参数只展示帮助；`--session --show-text` 仅保留兼容，不向终端显示名称。正式路径不依赖旧 profile、两处名称一致或正文差分。

## 历史校准与验证记录

旧 profile 校准、菜单栏、坐标表单及阶段失败／通过记录见[原生探针历史](../../docs/history/desktop-development-history.md#原生探针整理前记录)。当时暂停、签名和验证结果只覆盖原场次，不要求新任务复现旧产品路径。

## 合成验证与计时

`python3 native/macos/scripts/benchmark_layout.py --baseline <commit> --output <结果.json>` 是独立的合成布局性能工具，仅依赖 Python 标准库驱动 Swift／CoreGraphics。它不属于产品后台，不需要恢复 Conda 或旧 Python 服务。先确认基线与空间；保留原始样本、p50／p95、源码摘要和等价断言。

合成基准只度量绘制及布局，不包含真实采集、OCR、IPC 或微信延迟，也不是 RSS 测量。性能改动需使用相同工作负载比较，不能把缓冲区估算当成整机内存结果。
