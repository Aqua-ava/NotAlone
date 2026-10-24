# 票21 ANECompilerService 根因追加审计

日期：2026-10-25。基线：`503065236e509534cb303c7d02672f40f970f4e9`；隔离 worktree：`/private/tmp/notalone-21-vision2.hoWxQl`。本追加不改变原有 2500ms、accurate、0.90 confidence 或联系人人工门。

## 结论更新

原结论“客户端等待 ANE 模型编译 XPC”成立，但不能再描述为 ANE 服务单纯无响应或死锁。系统 `ANECompilerService` 资源报告包含与 NotAlone OCR 调用相关的持续编译样本，以及长时间高 CPU／大额文件 backing store 写入。客户端在 2500ms 内等不到编译完成，是当前直接症状；编译器为何为文字模型产生这种长时工作仍只有 Apple 私有实现能解释。

没有找到可逆、公开且能在不变产品合同下绕过该编译路径的修复。票保持 claimed，不能把本审计当作 21 通过，也不能用 VisionKit transcript 或 fast 结果冒充正式正例。

## 当前固定红反馈环

当前 HEAD 下，内存绘制的同一 800×72 合成图像素 SHA-256 为 `2de93b11fa1b3cebd299528b3f057f8bf3d5aa9c5a64d50675ea31aa355009a9`。当前 async Vision 复跑 2507.0ms 超时；VisionKit 正例 160.5ms 返回正确 transcript；错配反例 67.6ms 拒绝；VisionKit 预热后 Vision 仍 2510.2ms 超时；legacy fast 36.1ms 返回 0 行。新增差分如下：

| 唯一变量 | 结果 | 解释 |
| --- | --- | --- |
| 中英两个识别语种 | 2509.7ms 超时 | 当前基线 |
| 仅 `zh-Hans` | 2505.1ms 超时 | 不是英文语种组合导致 |
| revision 3 自动语言检测 | 2505.3ms 超时 | 不是固定语言选择导致 |
| 同像素 32BGRA `CVPixelBuffer` | 2507.2ms 超时 | 不是 `CGImage` 输入适配导致 |
| x86_64 cross-compiled | 启动即 `Bad CPU type` | 本机 Rosetta 未安装；没有安装系统组件 |

机器结果：[native-gap-probe-results.json](native-gap-probe-results.json)。探针：[language-path-probe.swift](language-path-probe.swift)、[bounded-run.py](bounded-run.py)。

探针源码 SHA-256 `043fc12f6369329d92e5e5941d74c60622fc238f3a4f32eb8f509e6c52e1eb2e`；arm64 诊断二进制 SHA-256 `78714a5c0b1a04b4acc6afdbed693887218643cac0e29a637607dd4dde1a75c1`。

## ANECompilerService 新证据

只读读取 `/Library/Logs/DiagnosticReports/`。最新报告的摘要：

- 命令 `ANECompilerService`，标识 `com.apple.ANECompilerService`，位于 AppleNeuralEngine 私有框架的 XPC service。
- 时间范围 2026-10-24 11:04:45 至 2026-10-25 00:05:53（+08:00），事件为 disk writes，系统执行动作 `none`。
- 记录 34.36GB “file backed memory dirtied”，持续 46868.19 秒，平均 733.11KB/s，Steps 16871、每步 10.49MB。
- `On Behalf Of` 样本明确包含 `notalone-sync-probe`，该报告还列出 `native-ocr-legacy-cpu`／OCR 诊断 ancestry。
- 纯 Apple 栈显示 `ANECProcedureCompiler::Compile` → `ZinCompilerCoreClassic::CompileProcedure` → `ZinMirBuilder` → `ZinMirSpatialSplitter`。因此报告时它仍在做编译工作，不是仅停留在 XPC 消息分发。
- 10/22 与 10/23 另有 CPU resource 报告，分别约 94%／95 秒和 71%／127 秒。它们是 microstackshot/resource 报告，不是崩溃报告。

报告 SHA-256 为 `2ca23e8de651dc5f8014929f358ffce1697b699d884e5b0167c67aa949a00eb6`；不复制原始大报告，只保留脱敏摘要：[ane-compiler-report-summary.json](ane-compiler-report-summary.json)。

这些报告证明系统编译器在该时段有实际长时间工作且样本 ancestry 含 NotAlone，不证明每次 OCR 请求都独占或产生全部写入，也不解释 Apple 内部图变换。读取 `aned` 进程样本被系统拒绝（需更高权限）；没有提权、终止进程、重启服务或清理缓存。

## 已排除的新假设

- 不是语种列表：零英文与自动检测均超时。
- 不是输入对象：`CVPixelBuffer` 超时。
- 不是缺少 GUI/进程身份：既有有效 Bundle、`NSApplication` 和真实 App 均失败。
- 不是 DSH/TS 生命周期：Vision 调用没有直接 DSH 接口，超时可在独立 Swift 合成进程复现。
- 不是所有 OCR 都不可用：VisionKit 走另一可用路径，但公开结果无 confidence，不能进入正式 0.90 门。
- macOS 27 release notes 中对应 ANE 后台限制段落明确写“iOS 27”；不能以该段直接推断 macOS 原因。独立 entitlement 页面则明确列出 macOS 27，因此另列为待真实签名验证的外部候选。
- `softwareupdate --list` 在本次检查时报告没有可安装更新；公开 macOS 27.2 RC release notes 中没有 Vision／ANE／OCR 相关修复条目。这只能说明当前没有可引用的 Apple 修复，不能证明该构建实际不存在内部修复。

## 后台 ANE entitlement 候选

官方 [Background Inference](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.background-tasks.continued-processing.inference) 页面把 `com.apple.developer.background-tasks.continued-processing.inference` 列为 macOS 27 起可用，并要求 App 在后台访问 Neural Engine 时声明。当前 Electron App 与两个原生可执行文件静态读取均没有 entitlement。

临时同源 CLI 的单变量结果：

| 签名 | 运行结果 |
| --- | --- |
| 无 entitlement，正常 linker ad-hoc 签名 | 进程启动，读取结果为 `false`，exit 1 |
| 加 entitlement 后 ad-hoc 重签 | `codesign --verify` 通过且可读出 true，进程启动即被系统杀死，exit 137 |

所以当前开发签名路径不能直接测试该权限。它是有条件的新候选：需要在正确的 Apple provisioning／签名与干净机器上，把权限同时部署到实际 ANE 调用进程，随后按固定合成图测 2500ms 和 confidence。当前证据不证明它会修复长时间编译；也未请求证书、修改产品 entitlements、构建或启动 App。

证据：[entitlement-evidence.json](entitlement-evidence.json)、[entitlement-read-probe.swift](entitlement-read-probe.swift)、[background-inference.entitlements](background-inference.entitlements)。

## 安全与恢复边界

每次 OCR 超时结束后，客户端进程被终止并 `wait`，但系统编译器任务不一定随客户端结束；继续重跑可能加重编译器负载。现有 `reproduce.sh` 已增加 `NOTALONE_ALLOW_ANE_PROBE=1` 显式许可门，默认拒绝重复 OCR。

不执行：清模型缓存、重启／终止 ANE 服务、修改系统设置或 entitlement、安装 Rosetta、提升权限、改签名、扩大产品预算、降 fast／VisionKit。没有操作 App、微信、真实资料、数据库、模型或外部发送。

可行恢复路径仍是：

1. 在健康 Mac 上以当前固定图、代码、accurate revision 3、中英配置和 2500ms 运行一次，核对是否返回名称且 confidence ≥ 0.90。
2. 或等待 Apple 对 macOS 27／M6 ANECompilerService 长编译行为的公开修复。
3. 若用户明确要求本机恢复实验，只能另行批准受控重启或 Apple 推荐步骤；本会话没有把这些未验证动作当修复。

## 主会话操作

当前无需也没有新增 App／微信操作。不要为本结论启动 App、切换或滚动微信。若之后在健康 Mac 上验证，仍由 root 唯一占用桌面，只允许一个指定私聊、当前唯一前台窗口、自动定位名称区，输入帧不保存；任何截图正文、列表或其他 App 读取均越界。
