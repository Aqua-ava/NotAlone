# OCR 实验台

用于单独复现 Ticket 21 中 macOS Vision 顶部名称 OCR 的耗时与置信度问题。该工具不接入 NotAlone 产品后端，不读取微信正文或其他联系人列表，不保存或上传原始图片。

## 使用

```bash
swiftc -O -swift-version 5 \
  -framework AppKit -framework Vision -framework ImageIO -framework UniformTypeIdentifiers \
  OCRTestWindow.swift -o /tmp/notalone-ocr-lab

/tmp/notalone-ocr-lab
```

窗口提供：

- 选择本地图片。
- 读取剪贴板中的截图，适合用系统截图工具复制微信顶部名称。
- 运行固定的 `800×72`、`合成A1` 合成图，复现既有诊断条件。
- 显示 OCR 文本、逐行首候选置信度、替代候选和实际耗时。

固定条件为 accurate、revision 3、`zh-Hans` + `en-US`、关闭语言校正、2500ms 截止和最低首候选置信度 0.90。超过截止后仍会继续等待本次 Apple Vision 调用返回，以便区分“稳定约 2510ms 返回”和“长时间不返回”。
