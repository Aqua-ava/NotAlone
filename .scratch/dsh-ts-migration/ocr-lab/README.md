# 微信顶部 OCR 实验台

用于亲自复现 Ticket 21 中“微信窗口在前台，点击后立即截图并识别顶部名称”的完整本机路径。该工具不接入 NotAlone 产品后端，不切换或滚动微信会话，不读取聊天正文和其他联系人列表，不保存或上传原始截图。

## 使用

```bash
xcrun swiftc -O -swift-version 5 \
  -framework AppKit \
  OCRTestWindow.swift -o /tmp/notalone-ocr-lab/OCRTestWindow

/tmp/notalone-ocr-lab/OCRTestWindow
```

从仓库根目录启动实验台，或通过 `NOTALONE_PROJECT_DIR` 明确指定仓库目录。先打开微信目标私聊，在窗口中点击“立即截图并识别”，或从菜单栏“OCR 抓取”启动。工具会：

1. 把微信应用切回前台，但不切换会话。
2. 调用现有 `notalone-sync-probe --session --json --single-frame`。
3. 只截取当前唯一可见微信窗口，并在内存中定位、裁剪顶部名称区域。
4. 以 accurate、revision 3、`zh-Hans` + `en-US`、关闭语言校正执行 OCR。
5. 显示微信顶部名称、截图耗时、OCR 耗时、探针总耗时、置信度、名称完整性和各阶段完成情况。

探针默认位于 `native/macos/build/cli/notalone-sync-probe`，可用环境变量 `NOTALONE_SYNC_PROBE` 指定其他同契约可执行文件。单次调用最多等待 30 秒；超过 2500ms 时界面会立即标记，以便观察是否继续卡在 `headerOcrStarted`。

该工具复用现有原生探针的隐私边界：截图只在探针进程内存中处理，名称只显示在当前本地窗口，不写普通日志。
