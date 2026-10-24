# 原生 OCR 纯合成反馈环

本文件只用于诊断真实 `headerOcrStarted` 之后的超时。固定合成标题在端侧内存绘制，不截屏、不访问微信、不读业务库、不使用外部模型、不输出文字或图像。主会话独占实际窗口与采集。

`ocr-synthetic-diagnostic.swift` 直接链接现有 `build/cli/libNotAloneSyncCore.dylib`，调用公开 `LocalOcr.recognize`。它与正式 `recognizeHeader` 共用首次 `recognizeFragments`，但不覆盖后续私有文字回退、真实 ScreenCaptureKit 图像或前台门禁。合成通过不能代替真实顶部 OCR 验收。

编译前核验源码、动态库及 Swiftmodule 身份，构建输出只放独立临时目录：

```sh
diagnostic_dir=$(mktemp -d /private/tmp/notalone-ocr-synthetic.XXXXXX)
swiftc -O -parse-as-library \
  -I native/macos/build/cli -L native/macos/build/cli -lNotAloneSyncCore \
  -framework AppKit -framework CoreGraphics -framework CoreText \
  -Xlinker -rpath -Xlinker "$PWD/native/macos/build/cli" \
  .scratch/dsh-ts-migration/foreground-location/ocr-synthetic-diagnostic.swift \
  -o "$diagnostic_dir/ocr-synthetic-diagnostic"
```

由父进程统一设置有界截止并在超时后 `kill`、`wait`，记录退出码和固定 JSON stage。`ocr_completed` 表明调用已返回；`synthetic_text_exact` 表明正确识别合成值。两者分别判定，不能把识别错误误记成挂起。

1. 固定最小环境 `PATH=/usr/bin:/bin LANG=C LC_ALL=C`，运行 `main`，不初始化 `NSApplication`。
2. 固定同一环境、图像及动态库，仅将参数换成 `background`；它使用全局队列，`dispatchMain()` 保持主队列可运行，没有主线程同步等待。
3. 回到第一场的执行者和环境，仅增加 `HOME`；随后回到原基线，仅增加 `TMPDIR`。环境值由主会话继承，不写入日志。
4. 若仍不能区分，才增加更细的 `request_created`／`perform_started`／`perform_completed` 阶段，或在同一合成输入下单独初始化 `NSApplication`；不得一次同时改线程、环境及 Vision 配置。

每场报告 `Thread.isMainThread`、初始 `NSApp != nil`、`HOME`／`TMPDIR` 是否存在及毫秒数。背景模式不读取 AppKit 状态。不要用延长产品 2500ms 超时、降低识别质量、删除 fallback 或缓存上一轮结果替代定位原因。

当前执行边界与官方来源：Apple [Vision 静态图像说明](https://developer.apple.com/documentation/vision/detecting-objects-in-still-images)指出 `perform` 同步执行并建议后台队列；这不证明本次超时由主线程造成。锁定 DSH `687f282e8625c6b8d11ff58211a90524be2e4317` 的 `packages/core/scope/src/index.ts:137` 将生命周期交给 Cordis fiber；本项目 `host-plugin.ts:286` 清理前台服务，`NativeForegroundProbe.close` 负责终止并等待原生子进程。Vision 不经过 DSH 的模型／Tool 接口，本问题的原生调用无需修改 DSH 核心。
