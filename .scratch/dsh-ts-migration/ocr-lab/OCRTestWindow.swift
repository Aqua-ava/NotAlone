import AppKit
import ImageIO
import UniformTypeIdentifiers
import Vision

private let timeoutMilliseconds: Double = 2_500
private let minimumConfidence: Float = 0.90

private struct OCRLineSnapshot {
    let index: Int
    let confidence: Float
    let text: String
    let alternatives: [String]
}

private struct OCRSnapshot {
    let lines: [OCRLineSnapshot]
    let elapsedMilliseconds: Double
}

private enum OCRLabError: LocalizedError {
    case imageUnavailable
    case unsupportedRevision
    case unsupportedLanguages

    var errorDescription: String? {
        switch self {
        case .imageUnavailable:
            return "没有可识别的图片。"
        case .unsupportedRevision:
            return "当前系统不支持 Vision revision 3。"
        case .unsupportedLanguages:
            return "当前系统不支持简体中文与英文识别。"
        }
    }
}

private final class OCRLabAppDelegate: NSObject, NSApplicationDelegate {
    private var window: NSWindow?
    private var imageView: NSImageView!
    private var statusLabel: NSTextField!
    private var timingLabel: NSTextField!
    private var confidenceLabel: NSTextField!
    private var sourceLabel: NSTextField!
    private var resultView: NSTextView!
    private var progress: NSProgressIndicator!
    private var currentImage: CGImage?
    private var recognitionGeneration = 0
    private var timeoutWorkItem: DispatchWorkItem?
    private let recognitionQueue = DispatchQueue(
        label: "notalone.ocr-lab.recognition",
        qos: .userInitiated
    )

    func applicationDidFinishLaunching(_ notification: Notification) {
        installMainMenu()
        buildWindow()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    private func installMainMenu() {
        let mainMenu = NSMenu()
        let applicationItem = NSMenuItem()
        let applicationMenu = NSMenu()
        applicationMenu.addItem(
            withTitle: "退出 OCR 实验台",
            action: #selector(NSApplication.terminate(_:)),
            keyEquivalent: "q"
        )
        applicationItem.submenu = applicationMenu
        mainMenu.addItem(applicationItem)
        NSApp.mainMenu = mainMenu
    }

    private func buildWindow() {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 980, height: 740),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "OCR 实验台"
        window.minSize = NSSize(width: 860, height: 650)
        window.center()
        window.isReleasedWhenClosed = false
        window.setFrameAutosaveName("NotAloneOCRLabWindow")
        self.window = window

        guard let content = window.contentView else { return }
        content.wantsLayer = true
        content.layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor

        let title = label(
            "OCR 实验台",
            frame: NSRect(x: 24, y: 694, width: 400, height: 30),
            font: .systemFont(ofSize: 24, weight: .semibold),
            color: .labelColor
        )
        content.addSubview(title)

        let subtitle = label(
            "同一张图片按产品当前 OCR 条件在本机内存中识别，不保存或上传原始画面。",
            frame: NSRect(x: 24, y: 667, width: 900, height: 20),
            font: .systemFont(ofSize: 13),
            color: .secondaryLabelColor
        )
        content.addSubview(subtitle)

        let chooseButton = button("选择图片…", action: #selector(chooseImage))
        chooseButton.frame = NSRect(x: 24, y: 620, width: 112, height: 32)
        content.addSubview(chooseButton)

        let clipboardButton = button("读取剪贴板", action: #selector(readClipboard))
        clipboardButton.frame = NSRect(x: 148, y: 620, width: 112, height: 32)
        content.addSubview(clipboardButton)

        let syntheticButton = button("固定合成图", action: #selector(runSyntheticImage))
        syntheticButton.frame = NSRect(x: 272, y: 620, width: 112, height: 32)
        content.addSubview(syntheticButton)

        let retryButton = button("重新识别", action: #selector(recognizeCurrentImage))
        retryButton.frame = NSRect(x: 396, y: 620, width: 96, height: 32)
        content.addSubview(retryButton)

        let copyButton = button("复制识别文本", action: #selector(copyRecognizedText))
        copyButton.frame = NSRect(x: 504, y: 620, width: 120, height: 32)
        content.addSubview(copyButton)

        let mode = label(
            "准确 · revision 3 · zh-Hans + en-US · 语言校正关闭",
            frame: NSRect(x: 640, y: 626, width: 316, height: 20),
            font: .monospacedSystemFont(ofSize: 11, weight: .regular),
            color: .secondaryLabelColor
        )
        mode.alignment = .right
        content.addSubview(mode)

        let imageFrame = NSBox(frame: NSRect(x: 24, y: 338, width: 432, height: 258))
        imageFrame.boxType = .custom
        imageFrame.titlePosition = .noTitle
        imageFrame.fillColor = NSColor.controlBackgroundColor
        imageFrame.borderColor = NSColor.separatorColor
        imageFrame.borderWidth = 1
        imageFrame.cornerRadius = 8
        content.addSubview(imageFrame)

        imageView = NSImageView(frame: NSRect(x: 16, y: 16, width: 400, height: 226))
        imageView.imageScaling = .scaleProportionallyUpOrDown
        imageView.imageAlignment = .alignCenter
        imageView.wantsLayer = true
        imageView.layer?.cornerRadius = 5
        imageView.layer?.masksToBounds = true
        imageFrame.contentView?.addSubview(imageView)

        let emptyHint = label(
            "把微信顶部名称截图复制到剪贴板，再点“读取剪贴板”",
            frame: NSRect(x: 16, y: 106, width: 400, height: 40),
            font: .systemFont(ofSize: 14),
            color: .tertiaryLabelColor
        )
        emptyHint.alignment = .center
        emptyHint.maximumNumberOfLines = 2
        imageFrame.contentView?.addSubview(emptyHint)

        sourceLabel = label(
            "尚未选择图片",
            frame: NSRect(x: 24, y: 310, width: 932, height: 20),
            font: .monospacedSystemFont(ofSize: 11, weight: .regular),
            color: .secondaryLabelColor
        )
        content.addSubview(sourceLabel)

        let statusFrame = NSBox(frame: NSRect(x: 480, y: 338, width: 476, height: 258))
        statusFrame.boxType = .custom
        statusFrame.titlePosition = .noTitle
        statusFrame.fillColor = NSColor.controlBackgroundColor
        statusFrame.borderColor = NSColor.separatorColor
        statusFrame.borderWidth = 1
        statusFrame.cornerRadius = 8
        content.addSubview(statusFrame)

        statusLabel = label(
            "等待图片",
            frame: NSRect(x: 496, y: 530, width: 444, height: 42),
            font: .systemFont(ofSize: 26, weight: .semibold),
            color: .labelColor
        )
        content.addSubview(statusLabel)

        timingLabel = label(
            "耗时 —",
            frame: NSRect(x: 496, y: 488, width: 444, height: 28),
            font: .monospacedSystemFont(ofSize: 16, weight: .medium),
            color: .labelColor
        )
        content.addSubview(timingLabel)

        confidenceLabel = label(
            "最低置信度 —（门槛 0.90）",
            frame: NSRect(x: 496, y: 454, width: 444, height: 24),
            font: .monospacedSystemFont(ofSize: 14, weight: .regular),
            color: .labelColor
        )
        content.addSubview(confidenceLabel)

        let evidenceTitle = label(
            "判定规则",
            frame: NSRect(x: 496, y: 416, width: 444, height: 22),
            font: .systemFont(ofSize: 12, weight: .semibold),
            color: .secondaryLabelColor
        )
        content.addSubview(evidenceTitle)

        let evidence = label(
            "必须同时满足：2500ms 内返回、至少一行文字、所有首候选置信度 ≥ 0.90。",
            frame: NSRect(x: 496, y: 378, width: 444, height: 34),
            font: .systemFont(ofSize: 12),
            color: .secondaryLabelColor
        )
        evidence.maximumNumberOfLines = 2
        content.addSubview(evidence)

        progress = NSProgressIndicator(frame: NSRect(x: 496, y: 353, width: 20, height: 20))
        progress.style = .spinning
        progress.controlSize = .small
        progress.isDisplayedWhenStopped = false
        content.addSubview(progress)

        let resultScroll = NSScrollView(frame: NSRect(x: 24, y: 24, width: 932, height: 270))
        resultScroll.borderType = .bezelBorder
        resultScroll.hasVerticalScroller = true
        resultScroll.autohidesScrollers = true
        resultScroll.drawsBackground = true

        resultView = NSTextView(frame: resultScroll.contentView.bounds)
        resultView.isEditable = false
        resultView.isSelectable = true
        resultView.isRichText = false
        resultView.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
        resultView.textColor = .labelColor
        resultView.backgroundColor = .textBackgroundColor
        resultView.textContainerInset = NSSize(width: 10, height: 10)
        resultView.string = "识别结果会显示在这里。\n\n测试建议：\n1. 用系统截图工具截取微信顶部联系人名称。\n2. 按 Control 键截图可直接复制到剪贴板。\n3. 点击“读取剪贴板”，观察耗时和置信度。\n\n原始图片只保留在本窗口内存中；本工具不写入文件、不联网。"
        resultScroll.documentView = resultView
        content.addSubview(resultScroll)

        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func label(
        _ text: String,
        frame: NSRect,
        font: NSFont,
        color: NSColor
    ) -> NSTextField {
        let field = NSTextField(labelWithString: text)
        field.frame = frame
        field.font = font
        field.textColor = color
        field.lineBreakMode = .byTruncatingTail
        return field
    }

    private func button(_ title: String, action: Selector) -> NSButton {
        let button = NSButton(title: title, target: self, action: action)
        button.bezelStyle = .rounded
        return button
    }

    @objc private func chooseImage() {
        guard let window else { return }
        let panel = NSOpenPanel()
        panel.title = "选择要识别的图片"
        panel.prompt = "识别"
        panel.allowedContentTypes = [.image]
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        panel.beginSheetModal(for: window) { [weak self] response in
            guard response == .OK, let url = panel.url else { return }
            do {
                let image = try self?.loadImage(url: url)
                if let image {
                    self?.present(
                        image: image,
                        source: "用户选择的图片 · 不保存副本"
                    )
                }
            } catch {
                self?.showImageError(error)
            }
        }
    }

    @objc private func readClipboard() {
        let pasteboard = NSPasteboard.general
        if let image = pasteboard.readObjects(
            forClasses: [NSImage.self],
            options: nil
        )?.first as? NSImage {
            var proposedRect = NSRect(origin: .zero, size: image.size)
            guard let cgImage = image.cgImage(
                forProposedRect: &proposedRect,
                context: nil,
                hints: nil
            ) else {
                showImageError(OCRLabError.imageUnavailable)
                return
            }
            present(image: cgImage, source: "剪贴板图片 · 只在本窗口内存中处理")
            return
        }

        if let png = pasteboard.data(forType: .png),
           let image = decodeImage(data: png) {
            present(image: image, source: "剪贴板 PNG · 只在本窗口内存中处理")
            return
        }

        if let tiff = pasteboard.data(forType: .tiff),
           let image = decodeImage(data: tiff) {
            present(image: image, source: "剪贴板 TIFF · 只在本窗口内存中处理")
            return
        }

        showImageError(OCRLabError.imageUnavailable)
    }

    @objc private func runSyntheticImage() {
        do {
            present(
                image: try makeSyntheticHeader(text: "合成A1"),
                source: "固定 800×72 合成名称图 · 文本：合成A1"
            )
        } catch {
            showImageError(error)
        }
    }

    @objc private func recognizeCurrentImage() {
        guard let currentImage else {
            showImageError(OCRLabError.imageUnavailable)
            return
        }
        recognize(image: currentImage, source: sourceLabel.stringValue)
    }

    @objc private func copyRecognizedText() {
        let text = resultView.string.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.setString(text, forType: .string)
        statusLabel.stringValue = "识别文本已复制"
        statusLabel.textColor = .systemGreen
    }

    private func loadImage(url: URL) throws -> CGImage {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
            throw OCRLabError.imageUnavailable
        }
        return image
    }

    private func decodeImage(data: Data) -> CGImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else {
            return nil
        }
        return CGImageSourceCreateImageAtIndex(source, 0, nil)
    }

    private func present(image: CGImage, source: String) {
        currentImage = image
        imageView.image = NSImage(
            cgImage: image,
            size: NSSize(width: image.width, height: image.height)
        )
        sourceLabel.stringValue = "\(source) · \(image.width)×\(image.height) px"
        recognize(image: image, source: sourceLabel.stringValue)
    }

    private func recognize(image: CGImage, source: String) {
        recognitionGeneration += 1
        let generation = recognitionGeneration
        timeoutWorkItem?.cancel()

        statusLabel.stringValue = "正在识别…"
        statusLabel.textColor = .labelColor
        timingLabel.stringValue = "耗时 —"
        confidenceLabel.stringValue = "最低置信度 —（门槛 0.90）"
        resultView.string = "正在等待 Apple Vision 返回。\n\n目标：\(source)"
        progress.startAnimation(nil)

        let timeout = DispatchWorkItem { [weak self] in
            guard let self, self.recognitionGeneration == generation else { return }
            self.statusLabel.stringValue = "已超过 2500ms，仍在等待 Apple Vision"
            self.statusLabel.textColor = .systemOrange
            self.timingLabel.stringValue = "已超过 2500ms"
            self.resultView.string = "系统 OCR 超过 2500ms 仍未返回。\n\n继续等待本次调用的最终结果；也可以直接换图重新测试。"
        }
        timeoutWorkItem = timeout
        DispatchQueue.main.asyncAfter(
            deadline: .now() + timeoutMilliseconds / 1_000,
            execute: timeout
        )

        recognitionQueue.async { [weak self] in
            let started = ProcessInfo.processInfo.systemUptime
            let result: Result<OCRSnapshot, Error>
            do {
                let request = VNRecognizeTextRequest()
                request.revision = 3
                guard request.revision == 3,
                      VNRecognizeTextRequest.supportedRevisions.contains(3) else {
                    throw OCRLabError.unsupportedRevision
                }
                request.recognitionLevel = .accurate
                request.automaticallyDetectsLanguage = false
                request.usesLanguageCorrection = false
                request.recognitionLanguages = ["zh-Hans", "en-US"]
                let supported = try request.supportedRecognitionLanguages()
                guard request.recognitionLanguages.allSatisfy(supported.contains) else {
                    throw OCRLabError.unsupportedLanguages
                }

                try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
                let elapsed = (ProcessInfo.processInfo.systemUptime - started) * 1_000
                let lines = (request.results ?? []).enumerated().compactMap {
                    index, observation -> OCRLineSnapshot? in
                    let candidates = observation.topCandidates(3)
                    guard let first = candidates.first else { return nil }
                    return OCRLineSnapshot(
                        index: index + 1,
                        confidence: first.confidence,
                        text: first.string,
                        alternatives: candidates.dropFirst().map(\.string)
                    )
                }
                result = .success(OCRSnapshot(
                    lines: lines,
                    elapsedMilliseconds: elapsed
                ))
            } catch {
                result = .failure(error)
            }

            DispatchQueue.main.async {
                guard let self, self.recognitionGeneration == generation else { return }
                self.finish(result: result)
            }
        }
    }

    private func finish(result: Result<OCRSnapshot, Error>) {
        timeoutWorkItem?.cancel()
        timeoutWorkItem = nil
        progress.stopAnimation(nil)

        switch result {
        case .failure(let error):
            statusLabel.stringValue = "识别失败"
            statusLabel.textColor = .systemRed
            timingLabel.stringValue = "耗时 —"
            confidenceLabel.stringValue = "最低置信度 —（门槛 0.90）"
            resultView.string = error.localizedDescription

        case .success(let snapshot):
            let minimum = snapshot.lines.map(\.confidence).min()
            let text = snapshot.lines.map(\.text).joined(separator: "\n")
            let withinDeadline = snapshot.elapsedMilliseconds <= timeoutMilliseconds
            let confidencePassed = (minimum ?? 0) >= minimumConfidence
            let hasText = !snapshot.lines.isEmpty

            timingLabel.stringValue = String(
                format: "耗时 %.1f ms（目标 ≤ %.0f ms）",
                snapshot.elapsedMilliseconds,
                timeoutMilliseconds
            )
            confidenceLabel.stringValue = minimum.map {
                String(format: "最低置信度 %.4f（门槛 %.2f）", $0, minimumConfidence)
            } ?? "最低置信度 —（未识别到文字）"

            if !withinDeadline {
                statusLabel.stringValue = "超时后返回"
                statusLabel.textColor = .systemOrange
            } else if !hasText {
                statusLabel.stringValue = "未识别到文字"
                statusLabel.textColor = .systemRed
            } else if !confidencePassed {
                statusLabel.stringValue = "置信度不足"
                statusLabel.textColor = .systemOrange
            } else {
                statusLabel.stringValue = "通过"
                statusLabel.textColor = .systemGreen
            }

            var report = [
                "识别文本",
                text.isEmpty ? "（无）" : text,
                "",
                "逐行候选",
            ]
            if snapshot.lines.isEmpty {
                report.append("（无候选）")
            } else {
                for line in snapshot.lines {
                    report.append(String(
                        format: "第 %d 行  confidence=%.4f  %@",
                        line.index,
                        line.confidence,
                        line.text
                    ))
                    for (alternativeIndex, alternative) in line.alternatives.enumerated() {
                        report.append("  候选 \(alternativeIndex + 2)：\(alternative)")
                    }
                }
            }
            report += [
                "",
                "判定",
                "耗时：\(withinDeadline ? "通过" : "未通过")",
                "文字：\(hasText ? "通过" : "未通过")",
                "置信度：\(confidencePassed ? "通过" : "未通过")",
                "",
                "原始图片：仅本进程内存，未保存、未上传。",
            ]
            resultView.string = report.joined(separator: "\n")
        }
    }

    private func showImageError(_ error: Error) {
        statusLabel.stringValue = "无法读取图片"
        statusLabel.textColor = .systemRed
        timingLabel.stringValue = "耗时 —"
        confidenceLabel.stringValue = "最低置信度 —（门槛 0.90）"
        resultView.string = error.localizedDescription
        progress.stopAnimation(nil)
    }

    private func makeSyntheticHeader(text: String) throws -> CGImage {
        guard let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
              let context = CGContext(
                data: nil,
                width: 800,
                height: 72,
                bitsPerComponent: 8,
                bytesPerRow: 3_200,
                space: colorSpace,
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
                    | CGBitmapInfo.byteOrder32Big.rawValue
              ) else {
            throw OCRLabError.imageUnavailable
        }
        context.scaleBy(x: 2, y: 2)
        context.setFillColor(CGColor(gray: 0.96, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: 400, height: 36))
        let font = CTFontCreateWithName("PingFangSC-Medium" as CFString, 14, nil)
        let title = NSAttributedString(
            string: text,
            attributes: [
                NSAttributedString.Key(kCTFontAttributeName as String): font,
                NSAttributedString.Key(kCTForegroundColorAttributeName as String):
                    CGColor(gray: 0.12, alpha: 1),
            ]
        )
        context.textPosition = CGPoint(x: 10, y: 11)
        CTLineDraw(CTLineCreateWithAttributedString(title), context)
        guard let image = context.makeImage() else {
            throw OCRLabError.imageUnavailable
        }
        return image
    }
}

private let application = NSApplication.shared
private let delegate = OCRLabAppDelegate()
application.delegate = delegate
application.setActivationPolicy(.regular)
application.run()
