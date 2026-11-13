# 原生标题 OCR 超时：纯合成诊断

日期：2026-10-24。范围：21 的真实原生 OCR 超时定位；尚未修复或签收真实窗口验收。本子任务没有采集屏幕、操作微信／UI、读取业务库、调用外部模型、发送消息或修改系统服务／权限／探针产物。

## 已确认的位置

根反馈环已证明真实前台检查及窗口采集完成，约 134ms 进入 `headerOcrStarted` 后超过 2500ms；真实探针被终止并等待。四场前序合成对照由根执行：主线程、后台队列、主线程仅加 `HOME`、主线程仅加 `TMPDIR` 都超时，不能据此给产品增加环境变量或改线程。

本子任务对自有合成进程取两次 1 秒、5ms 间隔的 `sample`。只按 `Popen` 返回的自有 PID 采样，采样前核对其可执行路径；全部自有子进程均已终止并 `wait`。原始堆栈只在私有临时目录；仓库记录仅保留函数签名、计数和合成阶段。

默认核心库调用的 178/178 样本：

```text
LocalOcr.recognize → LocalOcr.recognizeFragments
→ VNImageRequestHandler performRequests:gatheredForensics:error:
→ VNRecognizeTextRequest internalPerformRevision:inContext:error:
→ TextRecognition → semaphore_wait_trap

com.apple.anef.p4 工作线程：
Espresso::AOT::MILCompilerForANE::CompileUsingANEF
→ _ANEClient compileModel:options:qos:error:
→ _ANEDaemonConnection compileModel:sandboxExtension:options:qos:withReply:
→ NSXPCConnection 同步等待回复
```

在公开 API 指定 CPU 的另一个进程中，179/179 样本仍出现同一 ANE 编译和 XPC 等待链。它证明执行当时的等待位置，不证明服务内部原因、系统整体状态或永久死锁；不能直接认定 CPU API 被忽略。

## 同图单变量矩阵

独立 runner 内存绘制 800×72 的合成标题，四场像素 SHA-256 都是 `2de93b11fa1b3cebd299528b3f057f8bf3d5aa9c5a64d50675ea31aa355009a9`。主线程、`NSApp` 未初始化、最小 `PATH/LANG/LC_ALL` 环境固定。直接 Vision 使用与核心库一致的准确模式、`zh-Hans/en-US`、关闭语言纠错、默认 revision 3。

| 对照 | 唯一变化 | 进入阻塞前阶段 | 结果 |
| --- | --- | --- | --- |
| library | 现有公开 `LocalOcr.recognize` | `ocr_started` 15.4ms | 2509.0ms 超时 |
| direct | 同配置直接调用 Vision | `perform_started` 22.2ms | 2511.3ms 超时 |
| devices | 仅查询当前支持的设备 | `perform_started` 26.1ms | 2511.5ms 超时 |
| cpu | 查询后仅为支持的 stage 选择 CPU | `perform_started` 16.9ms | 2512.1ms 超时 |

实际支持列表只有 `main` stage，设备为 Neural Engine、GPU、CPU；没有猜测不存在的 stage 或强设不支持的设备。调用 `setComputeDevice` 后再以 `computeDevice(for:)` 读回确认为 CPU，仍在 2500ms 截止超时。补充一次仅延长**合成诊断**到 30 秒的默认配置观察仍没有 `perform_completed`，30012.0ms 后终止；产品及原反馈环 2500ms 预算未改。

完整机器证据：[首轮矩阵](native-ocr-diagnosis-matrix.json)、[CPU 采样事件](native-ocr-diagnosis-cpu-sample.json)、[CPU 读回与 30 秒对照](native-ocr-diagnosis-followup.json)、[可重放反馈环结果](native-ocr-diagnosis-replay.json)。首轮矩阵的源码哈希为加入 CPU 读回日志前的版本；后两份证据记录新增读回后的源码／二进制哈希。

## 可重放入口

[Swift runner](native-ocr-diagnosis-vision.swift) 链接现有核心库，编译仅写入独立临时目录。最终程序：`/private/tmp/notalone-native-ocr-vision-st9gs77k/native-ocr-diagnosis-vision-v2`。

重新编译时从仓库根目录执行，不替换既有探针：

```sh
diagnostic_dir=$(mktemp -d /private/tmp/notalone-native-ocr-vision.XXXXXX)
swiftc -O -parse-as-library \
  -I native/macos/build/cli -L native/macos/build/cli -lNotAloneSyncCore \
  -framework AppKit -framework CoreGraphics -framework CoreText \
  -framework CoreML -framework Vision -framework CryptoKit \
  -Xlinker -rpath -Xlinker "$PWD/native/macos/build/cli" \
  .scratch/dsh-ts-migration/foreground-location/native-ocr-diagnosis-vision.swift \
  -o "$diagnostic_dir/native-ocr-diagnosis-vision"
```

```sh
"$HOME/miniconda3/envs/NotAlone/bin/python" \
  .scratch/dsh-ts-migration/foreground-location/native-ocr-diagnosis-run.py \
  --runner /private/tmp/notalone-native-ocr-vision-st9gs77k/native-ocr-diagnosis-vision-v2 \
  --mode cpu --timeout-ms 2500
```

该入口实际执行 exit 1，`timed_out=true`、`child_exit=-9`、CPU 读回确认成功，2509.7ms 完成回收，标准错误 0 字节。只有实际识别返回且合成内容匹配才 exit 0；识别错误与超时分开记录，不把外层记录程序的成功当作 OCR 通过。

原 CLI SHA-256 为 `8000f5f452e49d5310e6a7a09030d8704ec6c796355348c93a304b5010a359a1`；它动态依赖的核心库 SHA-256 为 `dd8b19019add02b2a01e6ab9e3bbaf42838ea6876e9c0f1a474d2795ffb4801d`。诊断前后核心库哈希一致。主程序哈希本身不能锁定 OCR 实现。

收尾以精确 PID 独立核对本子任务 9 个合成子进程均已不存在；4 份 JSON 可解析，Python 反馈环语法通过，原 CLI 和核心库哈希均保持不变。无自有常驻进程；最终 runner 与两份私有堆栈留供根复核，未写入 Git 索引或创建提交。

## 边界与后续

目前证据已降低真实 ScreenCaptureKit 裁片、仅主线程阻塞、仅遗漏 `HOME/TMPDIR`、核心库独有封装问题的可能性；没有证明可以采用某个替代设备、较低质量模式或不同模型 revision。默认和 CPU 配置都未得到可用结果，保留红证据，不修改 ANE 服务、系统设置、签名或权限。

现有 `AutomaticSessionCaptureTests` 使用注入识别，`SessionObservationWorkerTests` 使用注入观察，不能锁定此真实 Vision 挂起。正确回归接缝是上述有外部截止和进程回收的真实合成 Vision 调用；之后必须重新通过原 `verify-real-native.py` 的同一 2500ms 真实前台窗口反馈环，才可签收原生能力。纯合成公开入口只覆盖首次识别，不覆盖正式私有文字回退。

Apple [Vision 文档](https://developer.apple.com/documentation/vision/detecting-objects-in-still-images)说明 `perform` 同步执行并建议后台队列；它不证明本次故障由主线程导致。本机 SDK 的 `VNRequest.h:126–144` 及 Swift overlay `VNRequest.supportedComputeStageDevices/setComputeDevice` 已核对；没有使用已弃用 `usesCPUOnly`。

DSH 锁定源码 `687f282e8625c6b8d11ff58211a90524be2e4317` 的 `packages/core/scope/src/index.ts:137–145` 管理 scope 生命周期；项目 `host-plugin.ts:286` 经前台服务收尾回收探针。纯原生 Vision 不经过 DSH 的模型或 Tool 接口，没有修改 DSH 核心的依据。

## 公开 revision 的单变量对照

随后仅追加一个纯合成分支。检验前已向根报告可证伪假设：如果只与默认 revision 3 的模型路径有关，另一仍公开支持且准确模式支持固定中英语言的 revision 应在同预算返回；如果所有合格 revision 都在 `perform` 后超时，则停止此分支。没有以本对照直接替换产品模型。

Apple 官方 [revision](https://developer.apple.com/documentation/vision/vnrequest/revision) 允许选择算法／实现版本，[supportedRevisions](https://developer.apple.com/documentation/vision/vnrequest/supportedrevisions) 提供运行时支持集合，[supportedRecognitionLanguages()](https://developer.apple.com/documentation/vision/vnrecognizetextrequest/supportedrecognitionlanguages%28%29) 提供当前请求配置支持的语言。三个官方 Markdown 正文均已读取；本机 `VNRequest.h:82–97`、`VNRecognizeTextRequest.h:39–47,91–106` 已交叉核对。旧 revision 常量的弃用信息不替代实际运行时能力检查，也不构成产品回退建议。

纯元数据 inventory exit 0，没有创建图像或调用 `perform`：

- `request.revision` 默认值、`defaultRevision`、`currentRevision` 均为 3。
- `supportedRevisions` 为 `[1,2,3]`。
- revision 1 准确模式仅支持 1 种语言，含英语、不含 `zh-Hans`，只查询能力，未执行 OCR。
- revision 2 支持 8 种语言、revision 3 支持 33 种，均含固定的 `zh-Hans` 与 `en-US`；读回 revision 与请求值一致。

随后使用同一 v3 runner，对 revision 3 与 revision 2 都先检查公开支持及固定语言，再只改变传入的 revision 整数。合成像素、主线程、未初始化的 `NSApp`、最小环境、准确模式、中英语言顺序、关闭语言纠错和 2500ms 截止保持一致。两场都没有选择 CPU 或修改其他设备配置。

| revision | 进入 `perform` | 总耗时 | 反馈环退出 | 结果 |
| --- | ---: | ---: | ---: | --- |
| 3，当前默认基线 | 12.7ms | 2509.6ms | 1 | 超时，kill、wait，子进程 -9 |
| 2，公开支持的替代 | 11.1ms | 2509.8ms | 1 | 超时，kill、wait，子进程 -9 |

两场标准错误都是 0 字节，均无 `perform_completed`。所有满足固定中文条件的公开 revision 都失败，按预先约定停止，没有继续组合设备／线程／环境变量或操作系统服务。此结果降低“仅默认 revision 3 一条路径失败”的解释力度；revision 2 未另取堆栈，因此不能把它也认定为同一 ANE 服务内部故障。

完整记录：[revision 元数据](native-ocr-diagnosis-revisions-inventory.json)、[revision 矩阵](native-ocr-diagnosis-revisions-matrix.json)。新源码 SHA-256 为 `1429a754de7ef52b12540fd19a8f67dcfa0b7313d17069112e48fcc008d13e90`；v3 runner SHA-256 为 `56c36b1ecdf76f39cd2c781c4f31e156f7e46daa5bb9ee3ca1377aebb577bb1a`。上一节 v2 的历史失败记录不改写。

可重放命令如下；将 `--revision 2` 改成 `3` 即为同程序的默认基线对照：

```sh
"$HOME/miniconda3/envs/NotAlone/bin/python" \
  .scratch/dsh-ts-migration/foreground-location/native-ocr-diagnosis-run.py \
  --runner /private/tmp/notalone-native-ocr-vision-st9gs77k/native-ocr-diagnosis-vision-v3 \
  --mode revision --revision 2 --timeout-ms 2500
```
