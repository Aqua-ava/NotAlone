# 21 原生 Vision 阻塞只读复核
日期：2026-10-24；核对当前 HEAD `feecc40ed420`。结论：没有找到有 Apple 一手依据、尚未验证且保持原合同的新增修复线索；不建议重复既有排列。
本次只读源码、既有合成技术证据及 Apple 官方资料；零 OCR/探针/App/桌面/微信/业务库/模型调用，未改正式源、权限、签名、Git/index、票据或目标状态。

## 已试覆盖（本轮未重跑）
| 维度 | 现有实际覆盖 | 结果及来源 |
| --- | --- | --- |
| 真实输入 | 前台窗口完成采集和顶部定位，进入 `headerOcrStarted` | 2500ms 超时；[21现态](../issues/21-foreground-contact-location.md:54) |
| 合成输入/封装 | 800×72 sRGB、32-bit premultipliedLast/big-endian CGImage；同像素核心库与直接 Vision | 均超时；[生成器](../foreground-location/native-ocr-diagnosis-vision.swift:150)、[矩阵](../foreground-location/native-ocr-diagnosis-matrix.json) |
| 线程/环境 | 主线程、后台队列、仅补 HOME、仅补 TMPDIR | 均超时；[既有结论](../foreground-location/native-ocr-diagnosis-conclusion.md:7) |
| 当前 CPU 接口 | 按已配置请求查询 stage 支持表，从返回对象选择 CPU；main stage 读回 CPU | 2500ms 超时；[实现](../foreground-location/native-ocr-diagnosis-vision.swift:102)、[读回/延长对照](../foreground-location/native-ocr-diagnosis-followup.json) |
| 旧 CPU 接口 | 同图同预编译 binary，usesCPUOnly=true/false 各一次且读回一致；不混用 stage setter | 均超时，2510.4/2509.2ms 回收；[交接](../native-cpu-legacy-flag-diagnostic/handoff.md:16) |
| 公开 revision | 默认3、支持固定中英准确模式的2；1不支持中文，仅查能力 | 2/3均超时；[元数据](../foreground-location/native-ocr-diagnosis-revisions-inventory.json)、[矩阵](../foreground-location/native-ocr-diagnosis-revisions-matrix.json) |
| 时长/堆栈 | 默认直接 Vision 一次30秒；默认与CPU各采样 | 30秒仍无完成；样本见ANE编译/XPC等待，不证明服务内因；[结论](../foreground-location/native-ocr-diagnosis-conclusion.md:23) |

## 代码与一手合同复核
正式 [CaptureSupport.swift](../../../native/macos/Sources/NotAloneSyncCore/CaptureSupport.swift:384) 仍为 accurate、zh-Hans/en-US、关闭纠错、CGImage handler；本轮源码 SHA256 `4a544f071921eae39f7f2c0e7af6ba0a0ab50e4f80bfc13c56977943ce2987b5`。
[Apple setter](https://developer.apple.com/documentation/vision/vnrequest/setcomputedevice(_:for:)) 与 SDK27 `VNRequest.h:119–144` 一致：支持表取决于当前配置，赋值在 perform 才校验；读回不是执行成功或不触发ANE编译的保证。
[Apple usesCPUOnly](https://developer.apple.com/documentation/vision/vnrequest/usescpuonly) 仍是已弃用的逐请求CPU配置；本轮官方Markdown SHA `59868d156bde38db86a572a9c4a659a2e524545d228b9d202b1b5794393acbc0`，与既有研究一致，不能再作为未测候选。
[图像handler官方入口](https://developer.apple.com/documentation/vision/vnimagerequesthandler) 与 SDK27 `VNRequestHandler.h:70–112` 支持CGImage/像素缓冲等输入；未找到切换输入会避开本故障模型初始化的合同。CVPixelBuffer/其他像素格式未被上述矩阵穷尽，不等于有修复依据。
[helper原帖824639](https://developer.apple.com/forums/thread/824639) 本轮实际读取仍Replies 0/Participants 1；Null bundleID与仅fast可用都是发帖者报告，缺本机同因或Apple确认，不能据此改bundle/签名、初始化NSApplication或降低识别质量。
[macOS27官方说明](https://developer.apple.com/documentation/macos-release-notes/macos-27-release-notes) JSON本轮SHA `eb03b4cbd293b1f8b1a0164d6fe6da56eb59b0ad6e5d92a3dd50530aafe1220c`；正文无VNRecognizeTextRequest/ANECompilerService/TextRecognition/26A434/Espresso条目，不等于Apple不存在内部问题。
既有后台推理权限、DTS全局daemon上下文及资源diag的适用边界已由[官方调研](../native-helper-official-research/handoff.md:18)、[只读审计](../native-probe-readonly-audit/handoff.md:17)记录；本轮没有新增证据能将本GUI启动helper归为该上下文或确认为权限拒绝。

## 停止与恢复条件
保留21原生正向缺口，不将“等待位置”升级成“ANE服务死锁/权限原因”；也不声称所有API组合均已证明无效。
当前同机无新证据时停止重跑；下一步应等明确的新技术条件，例如Apple针对该环境的原因/修复信息，或可用的健康Mac同冻结图/runner/2500ms环境对照，不能用更多准备材料替代修复。
重启Mac、清模型缓存或操作ANE服务尚非已证明修复；本轮不建议执行，也不以这类外部状态变化推断21已通过。
恢复后通过门仍为真实合成Vision返回且内容匹配 → 原2500ms前台名称区域反馈环 → 官方宿主的npm run dev App验收；不接受mock、手动退化、fast/语言降级、延长产品预算或改DSH核心替代。
SDK `VNRequest.h` SHA仍 `d39042324814bb1a02a09856bc0ca2a2f0356db57075aad07b3d8573e462ac35`；`VNRequestHandler.h` SHA `d71b71675cd2c2304dc4cd5743898126d71f24cd5f423e2a1c53653c48445b29`。未复制SDK/原始日志或敏感资料。
