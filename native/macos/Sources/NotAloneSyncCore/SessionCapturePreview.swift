import AppKit
import Foundation

// 显式开发预览：复用正式观察，只在本机窗口展示；关闭即释放帧和名称。
@MainActor
public enum SessionCapturePreview {
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
                guard NSWorkspace.shared.frontmostApplication?.bundleIdentifier == "com.tencent.xinWeChat" else { return nil }
                return try CalibrationContext.resolve(requireForeground: true)
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
