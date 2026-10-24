# 票21 Vision／ANE 阻塞审计与最小可行边界

> 2026-10-25 后续证据：从 `50306523` 重新核对后，ANECompilerService 资源报告显示实际长时编译与大额写入，且新增 entitlement／新语种／像素路径边界。结论更新与唯一桌面矩阵见[追加审计](ane-compiler-addendum.md)。原票仍保持 claimed。

日期：2026-10-25。代码基线：`dd1f3070f21a4a37dd06d11c6ea5a504ea4fd9a7`；隔离 worktree 为 `/private/tmp/notalone-21-vision.NOomqD`。本审计不修改产品、07 UI、10 extraction、共享宿主编排、数据库或发布材料。

## 结论

在不改变 `accurate`、中文／英文识别、0.90 置信度和 2500ms 合同的前提下，没有找到可签收的产品修复。

当前 macOS `27.0.1 (26A434)`／Apple M6 上，正式 `LocalOcr.recognize`、直接 `VNRecognizeTextRequest`、macOS 15+ async `Vision.RecognizeTextRequest` 和 macOS 26+ `RecognizeDocumentsRequest` 都会在请求开始后超过 2500ms 不返回。旧证据的采样位置仍是 `TextRecognition` 等待 ANE 模型编译 XPC 回复。新接口没有绕开该实现。

同一固定像素图上，`VisionKit.ImageAnalyzer` 的 Live Text 路径可以在 165.0ms 正确返回合成文字；错误固定图也会在 448.2ms 内返回不等结果。它证明机器、合成输入和不落盘约束本身可用，但公开结果只有 transcript，没有 candidate confidence，不能冒充正式 Vision 正例。

因此本票仍受系统 Vision accurate 路径阻塞。可恢复条件是健康 Mac 上用同一固定图／配置得到 2500ms 内准确且带 confidence 的 Vision 结果，或 Apple 修复该系统路径；不能靠延长产品预算、降 fast、改 contract 或把 transcript 当 confidence 解除。

## 固定材料与边界

- 两张图都由程序在本进程内存绘制，不截屏、不读取 App／微信／业务库、不调用模型或外部服务。
- 正例图为 800×72 sRGB，像素 SHA-256 `2de93b11fa1b3cebd299528b3f057f8bf3d5aa9c5a64d50675ea31aa355009a9`，文字固定为 `合成A1`。
- 反例图同为 800×72，像素 SHA-256 `a3d130964d8f86614f995d0179d78048af1497221278079bd3c80e9343f60a25`，文字固定为 `合成B2`，断言仍要求 `合成A1`。
- 所有运行都经父进程 2500ms 有界等待；超时后只终止并回收该次自有子进程。每场 stderr 为 0 字节，未保存任何原始图像。
- 当前本机 `sw_vers` 为 27.0.1／26A434，arm64，模型报告 Mac18,5；SDK 为 macOS 27.0。

诊断源码：[modern-vision-probe.swift](modern-vision-probe.swift)。固定结果：[probe-results.json](probe-results.json)。源码 SHA-256 为 `e067bf00a578a072b32704828d85d32a227d25adeb7efcbb49e45f8af3f5f7fe`，编译程序 SHA-256 为 `b8101e718b801046daed06007ba1484d181dd0912ca35659c5b0b308b9b67738`。

可从隔离 worktree 复跑：

```sh
./.scratch/dsh-ts-migration/root-next-21/reproduce.sh /path/to/NotAlone
```

脚本只创建精确 `/private/tmp/notalone-21-vision-repro.*` 临时目录并在退出时清理。它预期以 1 结束，因为其中显式包含超时、错配和 fast 零结果反例；每个 JSON 的 `timed_out`、`ocr_completed`、`synthetic_text_exact`、`line_count` 才是逐场判定。

## 2500ms 证据

| 场景 | 唯一新增变量 | 结果 | 判定 |
| --- | --- | --- | --- |
| 当前 `LocalOcr.recognize` | 现有产品公开入口 | 2506.2ms 超时，`-9` | 正式链路失败 |
| 当前直接 `VNRecognizeTextRequest` | 去掉产品封装 | 2507.3ms 超时，`-9` | 不是 DSH／封装逻辑 |
| async `Vision.RecognizeTextRequest` | macOS 15 官方新接口 | 2504.7ms 超时，`-9` | 新 API 不绕开阻塞 |
| async Vision + 有效 Bundle | 仅补 `CFBundleIdentifier` | 2506.1ms 超时，`-9` | 不是 null bundle 身份 |
| async Vision + `NSApplication.shared` | 仅初始化 GUI 应用对象 | 2508.1ms 超时，`-9` | 不是缺少 App 初始化 |
| `RecognizeDocumentsRequest` | macOS 26 官方新 OCR 管线 | 2506.6ms 超时，`-9` | 另一官方 Vision 请求同样阻塞 |
| VisionKit 正例 | 同一固定正图 | 555.3ms；复跑 165.0ms；文字精确 | 文字正例通过，但无 confidence |
| VisionKit 反例 | 固定 B2 图，仍期望 A1 | 448.2ms；`exact=false` 并 exit 1 | 反例在预算内可拒绝 |
| VisionKit 预热后 async Vision | 同进程、同图、先 Live Text 后 Vision | 三次 2514.0／2512.3／2508.8ms 均超时 | 预热不共享有效模型路径 |
| 旧 Vision fast | 仅把 accurate 改为 fast | 123.6ms，0 行；加 exact custom word 后 48ms，仍 0 行 | 不满足准确／置信度合同 |

VisionKit 预热的三场中， Live Text 已在 102.5／100.6／65.7ms 完成并匹配固定文字；随后正式 Vision 仍没有 `perform_completed`。这不是总预算不足，而是两条路径没有共享成功初始化。

## 根因与官方合同

- 已有两次本机采样显示：产品入口和直接 Vision 都停在 `TextRecognition`，ANE worker 位于 `MILCompilerForANE::CompileUsingANEF` → `_ANEClient compileModel` → `_ANEDaemonConnection ... withReply`。该证据证明阻塞位置，不证明 ANE daemon 永久故障或权限拒绝。
- SDK 的 async `RecognizeTextRequest` 与旧 `VNRecognizeTextRequest` 使用相同 revision 3／准确文字能力；前者只是官方异步包装，本机仍超时。
- SDK `VisionKit.ImageAnalysis` 只公开 `transcript` 和 `hasResults(for:)`，没有 candidate confidence。不能根据文字相等自行构造 0.90 分数。
- 官方 fast 路径实际返回 0 行，不能作为 accurate 名称识别替代；即使未来可用，也属于主会话已明确拒绝的合同降级。
- DSH 锁定版本和 TS 宿主只在启动、HTTP 和进程回收边界接管前台观察；Vision 请求属于原生 SDK 调用，没有直接 DSH 接口，也没有修改 DSH 核心的依据。

## 可行实现选择

1. **当前可安全做的产品降级：无。** 继续展示上次结果会违反新鲜性；伪造 confidence、把 transcript 当正式识别或扩大等待都违反既定边界。
2. **安全但未实现的预览兜底。** 可以把 VisionKit transcript 仅作为“当前名称未确认”的候选展示，同时保持 confidence 为空、绑定为空、生成门关闭。它需要原生协议、TS API 和 UI 明确表达缺失 confidence，超出本票已确认正式定位路径；不能据此解除 21。
3. **不接受的合同替换。** “VisionKit 完整文字 + CLI 全名单唯一精确匹配”可能比模糊 OCR 更强，但它替代了现行 0.90 confidence 门，必须由用户确认并形成新 ADR。本会话没有采用。
4. **继续等待外部条件。** 最安全的是在另一台健康 Mac 上以同一固定图、源码和 2500ms 入口复跑；若通过，可确认本机系统状态问题；若同样失败，则需 Apple 对 macOS 27 Vision accurate 路径的修复。重启机器、清模型缓存、终止 ANE 服务均未被证明为修复，不应作为验收捷径。

## 主会话唯一桌面矩阵

当前没有获批的产品补丁，因此**不需要为本分支新增 App／微信验收操作**。真实 App 和微信仍应由 root 唯一占用。

若 root 仅为诊断预览而批准一次只读 Live Text 操作，严格按以下矩阵：

1. 先执行 `cd desktop && npm run dev:status`；若已有当前项目热更新实例，只复用它；无实例才启动 `npm run dev`。不运行打包版。
2. 使用用户指定的单个私聊；只把唯一可见微信窗口置前，不切换、不滚动、不读取左侧列表或聊天正文。
3. 复用现有自动布局结果，只把内存中的顶部名称裁片交给 VisionKit；父进程保留 2500ms 有界截止。不得保存截图、名称、帧缓冲或日志正文。
4. 预期只能得到 transcript，不能得到正式 confidence；界面必须保持“联系人未确认”、生成按钮禁用，不得自动绑定、生成候选或发送消息。
5. 正常退出开发实例，核对自有进程消失。该操作仅验证替代路径在真实裁片上的吞吐，不签收正式 Vision，不证明产品集成。

## 验证与清理

已实际运行：正式当前入口、直接 Vision、async Vision、Bundle 身份、NSApp 初始化、Documents 请求、VisionKit 正反例、VisionKit 预热三场、legacy fast 两场。所有超时子进程均被终止并 `wait`，无 `sleep` 轮询。没有操作 App、微信、桌面、PostgreSQL、模型、权限、签名、TCC 或系统服务，没有 Git push／PR／打包。

本审计只保留源码、固定摘要和不含私密数据的证据；生成的二进制、app bundle 和临时日志在提交前移除。未修改隔离 worktree 的产品源码，未在共享主工作树写文件。
