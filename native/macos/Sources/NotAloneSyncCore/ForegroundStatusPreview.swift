import AppKit
import Foundation

enum ForegroundApplication: String {
    case wechat, preview, other, unknown

    var label: String {
        switch self {
        case .wechat: return "微信"
        case .preview: return "本验收窗口"
        case .other: return "其他应用"
        case .unknown: return "未取得前台应用"
        }
    }

    @MainActor
    static func current() -> Self {
        guard let application = NSWorkspace.shared.frontmostApplication else { return .unknown }
        if application.processIdentifier == ProcessInfo.processInfo.processIdentifier { return .preview }
        return application.bundleIdentifier == "com.tencent.xinWeChat" ? .wechat : .other
    }
}

struct ForegroundStatusReading {
    enum Preflight: Equatable {
        case ready, notForeground, blocked(String)

        var label: String {
            switch self {
            case .ready: return "前置检查通过（未截图、未做 OCR）"
            case .notForeground: return "判定微信不在前台"
            case .blocked(let code):
                switch code {
                case CalibrationContextFailure.instances.rawValue: return "微信未运行或存在多个实例"
                case CalibrationContextFailure.version.rawValue: return "微信版本不在当前支持范围"
                case CalibrationContextFailure.notVisible.rawValue: return "没有可见微信窗口"
                case CalibrationContextFailure.windows.rawValue: return "微信窗口不唯一或尺寸不支持"
                case CalibrationContextFailure.geometry.rawValue: return "微信窗口几何信息无效"
                default: return "无法取得有效前台窗口信息"
                }
            }
        }
    }

    let frontmost: ForegroundApplication
    let preflight: Preflight

    var headline: String {
        if (frontmost == .wechat && preflight == .notForeground)
            || (frontmost != .wechat && preflight == .ready) { return "前台判断不一致" }
        if frontmost == .unknown { return "前台状态未知" }
        if frontmost != .wechat { return "微信不在前台" }
        return preflight == .ready ? "微信在前台" : "微信在前台 · 前置检查未通过"
    }

    @MainActor
    static func observe(frontmost: @MainActor () -> ForegroundApplication = ForegroundApplication.current,
                        context: @MainActor () throws -> CalibrationContext? = AutomaticSessionCapture.foregroundContext) -> Self {
        let application = frontmost()
        do {
            return Self(frontmost: application, preflight: try context() == nil ? .notForeground : .ready)
        } catch {
            return Self(frontmost: application, preflight: .blocked(
                (error as? CalibrationContextFailure)?.rawValue ?? CalibrationContextFailure.unavailable.rawValue))
        }
    }
}

struct ForegroundPreviewEvidence {
    private(set) var matches = 0
    private(set) var mismatches = 0
    private(set) var unverified = 0

    mutating func record(expectedWechat: Bool, reading: ForegroundStatusReading, sampleAge: TimeInterval) {
        guard sampleAge.isFinite, (0...1.5).contains(sampleAge), reading.frontmost != .unknown else {
            unverified += 1
            return
        }
        if expectedWechat == (reading.frontmost == .wechat) { matches += 1 }
        else { mismatches += 1 }
    }
}

// 显式元数据预览，不调用捕获、OCR、CLI 或后端；不把本窗口当作生产App验收。
@MainActor
public enum ForegroundStatusPreview {
    public static func run() {
        let application = NSApplication.shared
        application.setActivationPolicy(.accessory)
        let controller = ForegroundPreviewController()
        withExtendedLifetime(controller) {
            controller.show()
            application.run()
        }
    }
}

@MainActor
private final class ForegroundPreviewPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

@MainActor
private final class ForegroundPreviewController: NSObject, NSWindowDelegate {
    private let window = ForegroundPreviewPanel(contentRect: NSRect(x: 0, y: 0, width: 560, height: 440),
        styleMask: [.titled, .closable, .nonactivatingPanel], backing: .buffered, defer: false)
    private let verdict = NSTextField(labelWithString: "正在读取前台状态…")
    private let system = NSTextField(labelWithString: "系统当前前台：等待采样")
    private let probe = NSTextField(wrappingLabelWithString: "正式探针前置检查：等待采样")
    private let timing = NSTextField(labelWithString: "")
    private let checks = NSTextField(labelWithString: "人工核对尚未记录")
    private let feedback = NSTextField(wrappingLabelWithString: "先点击微信，观察状态；再点击其他应用，观察是否变化。切换瞬间请等1秒再核对。")
    private let deadline = Date().addingTimeInterval(480)
    private let uptimeDeadline = ProcessInfo.processInfo.systemUptime + 480
    private var timer: Timer?
    private var reading: ForegroundStatusReading?
    private var sampledAt: TimeInterval = 0
    private var evidence = ForegroundPreviewEvidence()
    private var sampleCount = 0
    private var readyCount = 0
    private var finished = false

    func show() {
        window.title = "微信前台状态 · 可视验收"
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.level = .floating
        window.hidesOnDeactivate = false
        window.isFloatingPanel = true
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        verdict.frame = NSRect(x: 24, y: 362, width: 512, height: 40)
        verdict.font = .systemFont(ofSize: 25, weight: .semibold)
        system.frame = NSRect(x: 24, y: 326, width: 512, height: 24)
        probe.frame = NSRect(x: 24, y: 274, width: 512, height: 46)
        timing.frame = NSRect(x: 24, y: 246, width: 512, height: 22)
        timing.font = .monospacedDigitSystemFont(ofSize: 12, weight: .regular)
        let instructions = NSTextField(wrappingLabelWithString:
            "悬浮窗持续刷新，不主动抢焦点。这里只核对前台与窗口元数据，不截图、不做OCR、不读聊天。绿色仅表示前置检查通过。")
        instructions.frame = NSRect(x: 24, y: 181, width: 512, height: 56)
        instructions.textColor = .secondaryLabelColor
        checks.frame = NSRect(x: 24, y: 148, width: 512, height: 24)
        feedback.frame = NSRect(x: 24, y: 91, width: 512, height: 50)
        for label in [verdict, system, probe, timing, instructions, checks, feedback] {
            window.contentView?.addSubview(label)
        }
        addButton("我看到微信在前台", action: #selector(recordWechat), x: 20, width: 190)
        addButton("我看到其他应用在前台", action: #selector(recordOther), x: 207, width: 215)
        addButton("结束", action: #selector(finish), x: 437, width: 100)
        if let screen = NSScreen.main {
            let frame = screen.visibleFrame
            window.setFrameTopLeftPoint(NSPoint(x: max(frame.minX, frame.maxX - 584), y: frame.maxY - 30))
        } else { window.center() }
        // 不能activate或makeKey，否则验收窗口自身会改变被测前台。
        window.orderFrontRegardless()
        refresh()
        let timer = Timer(timeInterval: 0.5, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in self?.refresh() }
        }
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
        print("{\"event\":\"foreground_preview_ready\",\"duration_seconds\":480,\"captures\":0}")
        fflush(stdout)
    }

    private func addButton(_ title: String, action: Selector, x: CGFloat, width: CGFloat) {
        let button = NSButton(title: title, target: self, action: action)
        button.frame = NSRect(x: x, y: 30, width: width, height: 36)
        button.bezelStyle = .rounded
        window.contentView?.addSubview(button)
    }

    private func refresh() {
        guard !finished else { return }
        let remaining = min(deadline.timeIntervalSinceNow, uptimeDeadline - ProcessInfo.processInfo.systemUptime)
        guard remaining > 0 else { finish(); return }
        let current = ForegroundStatusReading.observe()
        reading = current
        sampledAt = ProcessInfo.processInfo.systemUptime
        sampleCount += 1
        if current.preflight == .ready { readyCount += 1 }
        verdict.stringValue = current.headline
        verdict.textColor = current.headline == "前台判断不一致" ? .systemRed
            : (current.headline == "微信在前台" ? .systemGreen
                : (current.frontmost == .wechat || current.frontmost == .unknown ? .systemOrange : .secondaryLabelColor))
        system.stringValue = "系统当前前台：\(current.frontmost.label)"
        probe.stringValue = "正式探针前置检查：\(current.preflight.label)"
        let clock = DateFormatter.localizedString(from: Date(), dateStyle: .none, timeStyle: .medium)
        timing.stringValue = "更新 \(clock) · 第\(sampleCount)次 · 剩余 \(Int(ceil(remaining)))秒"
    }

    @objc private func recordWechat() { record(expectedWechat: true) }
    @objc private func recordOther() { record(expectedWechat: false) }

    private func record(expectedWechat: Bool) {
        guard !finished, let reading else { return }
        let age = ProcessInfo.processInfo.systemUptime - sampledAt
        evidence.record(expectedWechat: expectedWechat, reading: reading, sampleAge: age)
        checks.stringValue = "人工与系统：一致 \(evidence.matches) · 不一致 \(evidence.mismatches) · 未验证 \(evidence.unverified)"
        feedback.stringValue = "已记录你的观察：\(expectedWechat ? "微信在前台" : "其他应用在前台")。\n当次系统显示：\(reading.frontmost.label)；\(reading.preflight.label)。"
    }

    @objc private func finish() {
        guard !finished else { return }
        finished = true
        timer?.invalidate(); timer = nil
        let result: [String: Any] = ["event": "foreground_preview_closed", "machine_samples": sampleCount,
            "preflight_ready_samples": readyCount, "human_matches": evidence.matches,
            "human_mismatches": evidence.mismatches, "human_unverified": evidence.unverified,
            "captures": 0, "ocr_calls": 0]
        if let data = try? JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]),
           let text = String(data: data, encoding: .utf8) { print(text); fflush(stdout) }
        window.orderOut(nil)
        NSApp.terminate(nil)
    }

    func windowWillClose(_ notification: Notification) { finish() }
}
