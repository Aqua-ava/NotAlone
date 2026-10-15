import AppKit
import Foundation

// 名称预览只消费本轮识别结果，不接受预期姓名，也不确认联系人身份。
struct SessionNamePreviewReading {
    enum Kind { case recognized, paused, failed }
    let kind: Kind
    let name: String?
    let detail: String
    private let expiresAt: Date?

    var headline: String {
        switch kind {
        case .recognized: return "识别到：\(name ?? "")"
        case .paused: return "微信不在前台"
        case .failed: return "未识别出来"
        }
    }

    init(result: [String: Any], frontmost: ForegroundApplication = .wechat, now: Date = Date()) {
        if frontmost == .unknown {
            self.init(kind: .failed, detail: "暂时无法取得前台状态。")
            return
        }
        if frontmost != .wechat {
            self.init(kind: .paused, detail: "切回微信后自动识别。")
            return
        }
        guard result["ok"] as? Bool == true else {
            self.init(kind: .failed, detail: Self.failureMessage(result["error"] as? String))
            return
        }
        if result["wechat_in_front"] as? Bool == false {
            self.init(kind: .paused, detail: "切回微信后自动识别。")
            return
        }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard result["wechat_in_front"] as? Bool == true,
              result["capture_version"] as? String == "automatic-window-v2",
              let timestamp = result["captured_at"] as? String, let captured = formatter.date(from: timestamp),
              (0...5).contains(now.timeIntervalSince(captured)),
              let name = result["display_name"] as? String, !name.isEmpty, name.count <= 256,
              !name.contains("\n"), !name.contains("\r"),
              result["selected_row_name"] as? String == name,
              let quality = result["quality"] as? [String: Any], quality["layout_verified"] as? Bool == true,
              let header = quality["display_name_confidence"] as? Double,
              let row = quality["selected_row_name_confidence"] as? Double,
              header.isFinite, row.isFinite, (0.90...1).contains(header), (0.90...1).contains(row) else {
            self.init(kind: .failed, detail: "本次名称质量、时效或一致性未通过，等待下一次识别。")
            return
        }
        self.init(kind: .recognized, name: name, detail: "请直接核对这是否是当前微信会话的名称。",
                  expiresAt: captured.addingTimeInterval(5))
    }

    func current(at now: Date) -> Self {
        guard let expiresAt, now >= expiresAt else { return self }
        return Self(kind: .failed, detail: "上一次名称已过期，等待新的识别结果。")
    }

    private init(kind: Kind, name: String? = nil, detail: String, expiresAt: Date? = nil) {
        self.kind = kind; self.name = name; self.detail = detail; self.expiresAt = expiresAt
    }

    private static func failureMessage(_ code: String?) -> String {
        switch code {
        case "foreground_application_unavailable": return "暂时无法取得前台状态。"
        case "screen_capture_permission_missing": return "缺少屏幕录制权限。"
        case "session_name_confidence_low": return "名称识别置信度不足，等待下一次识别。"
        case "session_names_mismatch": return "顶部和选中行名称不一致，等待下一次识别。"
        case "header_name_unreadable", "row_name_unreadable": return "未读出完整会话名称。"
        case "automatic_layout_vertical_boundary", "automatic_layout_header_boundary",
             "automatic_layout_selection_ambiguous", "automatic_layout_sidebar_boundary",
             "minimal_region_layout_unverified": return "暂未定位到唯一的会话名称区域。"
        case "minimal_region_layout_changed", "automatic_capture_context_changed",
             "automatic_capture_window_metadata_changed", "automatic_capture_dimensions_changed":
            return "识别期间窗口发生变化，等待下一次识别。"
        case "calibration_wechat_version_unsupported": return "当前微信版本尚未适配。"
        case "calibration_windows_ambiguous", "calibration_wechat_instances_ambiguous":
            return "无法确定唯一的前台微信聊天窗口。"
        default: return "本次识别未完成，等待下一次识别。"
        }
    }
}

// 显式开发预览：复用正式观察，只在本机窗口展示；关闭即释放帧和名称。
@MainActor
public enum SessionCapturePreview {
    public static func runNames() {
        let application = NSApplication.shared
        application.setActivationPolicy(.accessory)
        let controller = SessionNamePreviewController()
        withExtendedLifetime(controller) {
            controller.show()
            application.run()
        }
    }

    public static func run() {
        let application = NSApplication.shared
        application.setActivationPolicy(.regular)
        let controller = SessionPreviewController()
        withExtendedLifetime(controller) {
            controller.show()
            application.run()
        }
    }
}

@MainActor
private final class SessionNamePreviewPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

@MainActor
private final class SessionNamePreviewController: NSObject, NSWindowDelegate {
    private let window = SessionNamePreviewPanel(contentRect: NSRect(x: 0, y: 0, width: 540, height: 310),
        styleMask: [.titled, .closable, .nonactivatingPanel], backing: .buffered, defer: false)
    private let headline = NSTextField(wrappingLabelWithString: "等待微信会话…")
    private let detail = NSTextField(wrappingLabelWithString: "打开微信测试会话，这里会自动显示实际读到的名称。")
    private let timing = NSTextField(labelWithString: "")
    private let deadline = Date().addingTimeInterval(1200)
    private let uptimeDeadline = ProcessInfo.processInfo.systemUptime + 1200
    private var timer: Timer?
    private var flight: Task<Void, Never>?
    private var reading: SessionNamePreviewReading?
    private var nextObservation: TimeInterval = 0
    private var recognized = 0
    private var paused = 0
    private var failed = 0
    private var finished = false

    func show() {
        window.title = "微信会话名称 · 自动识别"
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.level = .floating
        window.hidesOnDeactivate = false
        window.isFloatingPanel = true
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        headline.frame = NSRect(x: 24, y: 193, width: 492, height: 82)
        headline.font = .systemFont(ofSize: 27, weight: .semibold)
        detail.frame = NSRect(x: 24, y: 127, width: 492, height: 58)
        detail.font = .systemFont(ofSize: 15)
        timing.frame = NSRect(x: 24, y: 96, width: 492, height: 24)
        timing.font = .monospacedDigitSystemFont(ofSize: 12, weight: .regular)
        let instructions = NSTextField(wrappingLabelWithString: "只核对当前微信会话名称。结果仅在本窗口显示；切到其他应用后暂停。")
        instructions.frame = NSRect(x: 24, y: 39, width: 350, height: 48)
        instructions.textColor = .secondaryLabelColor
        for label in [headline, detail, timing, instructions] { window.contentView?.addSubview(label) }
        let finish = NSButton(title: "结束", target: self, action: #selector(closePreview))
        finish.frame = NSRect(x: 400, y: 43, width: 116, height: 36)
        finish.bezelStyle = .rounded
        window.contentView?.addSubview(finish)
        if let screen = NSScreen.main {
            let area = screen.visibleFrame
            window.setFrameTopLeftPoint(NSPoint(x: max(area.minX, area.maxX - 564), y: area.maxY - 30))
        } else { window.center() }
        window.orderFrontRegardless()
        print("{\"event\":\"session_name_preview_ready\",\"duration_seconds\":1200}")
        fflush(stdout)
        refresh()
        let timer = Timer(timeInterval: 0.25, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in self?.refresh() }
        }
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }

    private func refresh() {
        guard !finished else { return }
        let remaining = min(deadline.timeIntervalSinceNow, uptimeDeadline - ProcessInfo.processInfo.systemUptime)
        guard remaining > 0 else { closePreview(); return }
        timing.stringValue = "识别成功\(recognized)次 · 未识别\(failed)次 · 剩余\(Int(ceil(remaining)))秒"
        let frontmost = ForegroundApplication.current()
        if frontmost != .wechat {
            reading = SessionNamePreviewReading(result: [:], frontmost: frontmost)
        }
        if let reading { render(reading.current(at: Date())) }
        guard flight == nil, ProcessInfo.processInfo.systemUptime >= nextObservation else { return }
        reading = nil
        headline.stringValue = "正在识别…"
        headline.textColor = .secondaryLabelColor
        detail.stringValue = "等待当前窗口的本次识别结果。"
        flight = Task { @MainActor [weak self] in
            guard let self else { return }
            let result = await AutomaticSessionCapture.observe()
            guard !Task.isCancelled, !finished else { return }
            // 原生已核对采集前后上下文；显示前再检查前台，避免保留离开微信后的名称。
            let reading = SessionNamePreviewReading(result: result, frontmost: ForegroundApplication.current())
            render(reading)
            switch reading.kind {
            case .recognized: recognized += 1
            case .paused: paused += 1
            case .failed: failed += 1
            }
            nextObservation = ProcessInfo.processInfo.systemUptime + 2
            flight = nil
        }
    }

    private func render(_ value: SessionNamePreviewReading) {
        reading = value
        headline.stringValue = value.headline
        detail.stringValue = value.detail
        headline.textColor = value.kind == .recognized ? .systemGreen
            : value.kind == .paused ? .secondaryLabelColor : .systemOrange
    }

    @objc private func closePreview() {
        guard !finished else { return }
        finished = true
        timer?.invalidate(); timer = nil
        flight?.cancel(); flight = nil
        reading = nil
        headline.stringValue = ""; detail.stringValue = ""
        let summary: [String: Any] = ["event": "session_name_preview_closed",
            "observations": recognized + paused + failed, "recognized_samples": recognized,
            "paused_samples": paused, "failed_samples": failed, "saved_images": 0,
            "saved_names": 0, "runtime_frame_count_verified": false]
        if let data = try? JSONSerialization.data(withJSONObject: summary, options: [.sortedKeys]),
           let text = String(data: data, encoding: .utf8) { print(text); fflush(stdout) }
        window.orderOut(nil)
        NSApp.terminate(nil)
    }

    func windowWillClose(_ notification: Notification) { closePreview() }
}

@MainActor
private final class SessionPreviewController: NSObject, NSWindowDelegate {
    private let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1040, height: 780),
        styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
    private let canvas = SessionPreviewCanvas(frame: NSRect(x: 20, y: 20, width: 1000, height: 600))
    private let status = NSTextField(wrappingLabelWithString: "点击下方按钮，再切回已确认的测试私聊。5 秒后只识别一次，结果会在此展示。")
    private let button = NSButton(title: "开始识别（5 秒后）", target: nil, action: nil)
    private var flight: Task<Void, Never>?
    private var expiry: Timer?

    func show() {
        window.title = "微信 OCR 本机预览 · 不保存、不上传"
        window.isReleasedWhenClosed = false
        window.delegate = self
        status.frame = NSRect(x: 20, y: 670, width: 1000, height: 90)
        status.font = .systemFont(ofSize: 15)
        button.frame = NSRect(x: 20, y: 630, width: 240, height: 32)
        button.target = self; button.action = #selector(captureOnce)
        window.contentView?.addSubview(canvas)
        window.contentView?.addSubview(status)
        window.contentView?.addSubview(button)
        window.center(); window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        expiry = Timer.scheduledTimer(withTimeInterval: 480, repeats: false) { _ in
            Task { @MainActor in NSApp.terminate(nil) }
        }
    }

    @objc private func captureOnce() {
        guard flight == nil else { return }
        button.isEnabled = false
        canvas.image = nil; canvas.regions = nil; canvas.needsDisplay = true
        status.stringValue = "请现在切回已确认的测试私聊，保持微信在前台；5 秒后采集一次。"
        flight = Task { @MainActor in
            defer { flight = nil; button.isEnabled = true }
            do { try await Task.sleep(nanoseconds: 5_000_000_000) } catch { return }
            guard !Task.isCancelled else { return }
            var firstImage: CGImage?
            var regions: AutomaticSessionRegions?
            var names: [Name] = []
            let result = await AutomaticSessionCapture.observe(context: {
                try AutomaticSessionCapture.foregroundContext()
            }, capture: { context in
                let image = try await AutomaticSessionCapture.captureWindow(context)
                if firstImage == nil {
                    firstImage = image
                    regions = try? AutomaticSessionRegions.detect(image, windowSize: context.frame.size)
                }
                return image
            }, recognize: { image in
                let name = try recognizeName(image, policy: .conditionalASCIIRecheck)
                names.append(name)
                return name
            })
            guard !Task.isCancelled else { return }
            canvas.image = firstImage; canvas.regions = regions; canvas.needsDisplay = true
            func nameLine(_ index: Int, _ title: String) -> String {
                guard names.indices.contains(index) else { return "\(title)：未执行 OCR" }
                return "\(title)：\(names[index].text ?? "未识别出完整名称")  ·  置信度 \(String(format: "%.3f", names[index].confidence))"
            }
            let verdict: String
            if result["wechat_in_front"] as? Bool == false { verdict = "未采集：微信不在前台。请点击按钮后切回微信。" }
            else if result["ok"] as? Bool == true { verdict = "识别通过；请核对红框顶部名称、蓝框选中行名称是否正确。" }
            else { verdict = "未通过：\(result["stage"] as? String ?? "context") / \(result["error"] as? String ?? "unknown")。无框表示区域尚未定位成功。" }
            status.stringValue = "\(verdict)\n\(nameLine(0, "顶部名称"))\n\(nameLine(1, "选中行名称"))"
            window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
        }
    }

    func windowWillClose(_ notification: Notification) {
        flight?.cancel(); expiry?.invalidate()
        canvas.image = nil; canvas.regions = nil; status.stringValue = ""
        NSApp.terminate(nil)
    }
}

@MainActor
private final class SessionPreviewCanvas: NSView {
    var image: CGImage?
    var regions: AutomaticSessionRegions?
    override var isFlipped: Bool { true }
    override func draw(_ dirtyRect: NSRect) {
        NSColor.windowBackgroundColor.setFill(); bounds.fill()
        guard let image else { return }
        let scale = min(bounds.width / CGFloat(image.width), bounds.height / CGFloat(image.height))
        let rect = NSRect(x: 0, y: 0, width: CGFloat(image.width) * scale, height: CGFloat(image.height) * scale)
        NSImage(cgImage: image, size: NSSize(width: image.width, height: image.height))
            .draw(in: rect, from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
        guard let regions else { return }
        for (region, color) in [(regions.header, NSColor.systemRed), (regions.row, NSColor.systemBlue)] {
            color.setStroke()
            let border = NSBezierPath(rect: NSRect(x: region.minX * scale, y: region.minY * scale,
                width: region.width * scale, height: region.height * scale))
            border.lineWidth = 3; border.stroke()
        }
    }
}
