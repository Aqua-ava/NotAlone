import AppKit
import Foundation

// 独立可视验收，不调用正式探针、正文同步或模型。
@MainActor
enum SessionEventPreview {
    static func run(seconds: TimeInterval) {
        let application = NSApplication.shared
        application.setActivationPolicy(.accessory)
        let diagnostic = SessionEventCapabilities()
        let controller = SessionEventPreviewController(diagnostic: diagnostic)
        diagnostic.onUpdate = { [weak controller] in controller?.refresh() }
        diagnostic.onFinish = { [weak controller] in controller?.finish() }
        withExtendedLifetime(controller) {
            controller.show()
            diagnostic.start(seconds: seconds)
            application.run()
        }
    }
}

@MainActor
private final class SessionEventPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

@MainActor
private final class SessionEventPreviewController: NSObject, NSWindowDelegate {
    private let diagnostic: SessionEventCapabilities
    private let window = SessionEventPanel(contentRect: NSRect(x: 0, y: 0, width: 640, height: 620),
        styleMask: [.titled, .closable, .nonactivatingPanel], backing: .buffered, defer: false)
    private let headline = NSTextField(labelWithString: "微信切换通知 · 可视验收")
    private let readiness = NSTextField(wrappingLabelWithString: "正在检查当前监听权限…")
    private let registered = NSTextField(wrappingLabelWithString: "")
    private let counts = NSTextField(labelWithString: "")
    private let history = NSTextField(wrappingLabelWithString: "尚未收到微信内部通知")
    private let human = NSTextField(labelWithString: "你的反馈：有提示 0 次 · 无提示 0 次")
    private let feedback = NSTextField(wrappingLabelWithString: "请点击微信并切换几个已有聊天，观察通知计数和下方列表是否更新。")
    private let timing = NSTextField(labelWithString: "")
    private var timer: Timer?
    private var finished = false

    init(diagnostic: SessionEventCapabilities) { self.diagnostic = diagnostic }

    func show() {
        window.title = "NotAlone · 微信切换通知验收"
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.level = .floating
        window.hidesOnDeactivate = false
        window.isFloatingPanel = true
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        headline.frame = NSRect(x: 24, y: 558, width: 592, height: 38)
        headline.font = .systemFont(ofSize: 25, weight: .semibold)
        readiness.frame = NSRect(x: 24, y: 504, width: 592, height: 48)
        registered.frame = NSRect(x: 24, y: 458, width: 592, height: 42)
        registered.textColor = .secondaryLabelColor
        counts.frame = NSRect(x: 24, y: 425, width: 592, height: 26)
        counts.font = .monospacedDigitSystemFont(ofSize: 16, weight: .medium)
        history.frame = NSRect(x: 24, y: 295, width: 592, height: 120)
        history.font = .monospacedDigitSystemFont(ofSize: 14, weight: .regular)
        human.frame = NSRect(x: 24, y: 257, width: 592, height: 26)
        feedback.frame = NSRect(x: 24, y: 197, width: 592, height: 52)
        let instructions = NSTextField(wrappingLabelWithString:
            "操作：切换微信聊天，再切到其他应用、切回微信。不用发消息。\n内部通知与进出微信分别计数；焦点或窗口通知不一定代表换了聊天。这里只查通知，不读取名称或正文，也不截图。")
        instructions.frame = NSRect(x: 24, y: 110, width: 592, height: 80)
        instructions.textColor = .secondaryLabelColor
        timing.frame = NSRect(x: 24, y: 18, width: 592, height: 22)
        timing.font = .monospacedDigitSystemFont(ofSize: 12, weight: .regular)
        for label in [headline, readiness, registered, counts, history, human, feedback, instructions, timing] {
            window.contentView?.addSubview(label)
        }
        addButton("这次切换有提示", action: #selector(recordWithPrompt), x: 24, width: 190)
        addButton("这次切换无提示", action: #selector(recordWithoutPrompt), x: 224, width: 190)
        addButton("结束并退出", action: #selector(end), x: 448, width: 168)
        if let screen = NSScreen.main {
            let frame = screen.visibleFrame
            window.setFrameTopLeftPoint(NSPoint(x: max(frame.minX, frame.maxX - 664), y: frame.maxY - 28))
        } else { window.center() }
        // 不activate或makeKey；点击反馈也不改变微信的被测焦点。
        window.orderFrontRegardless()
        let timer = Timer(timeInterval: 0.25, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.refresh() }
        }
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }

    private func addButton(_ title: String, action: Selector, x: CGFloat, width: CGFloat) {
        let button = NSButton(title: title, target: self, action: action)
        button.frame = NSRect(x: x, y: 53, width: width, height: 38)
        button.bezelStyle = .rounded
        window.contentView?.addSubview(button)
    }

    func refresh() {
        guard !finished else { return }
        let evidence = diagnostic.evidence
        if !diagnostic.uniqueWechat {
            readiness.stringValue = "未能监听：请保持一个微信实例运行。本轮未验证内部通知。"
        } else if !diagnostic.accessibilityTrusted {
            readiness.stringValue = "当前诊断进程未获辅助功能权限，无法监听聊天切换通知。\n本轮仅能观察进出微信；未自动申请或修改权限。"
        } else if diagnostic.registeredCategories.isEmpty {
            readiness.stringValue = "当前微信未接受通知注册，本轮未验证内部通知。"
        } else {
            readiness.stringValue = diagnostic.wechatIsForeground
                ? "正在监听微信界面变化。请切换聊天，核对通知是否更新。"
                : "等待微信在前台。此窗口不会主动切换或控制微信。"
        }
        readiness.textColor = diagnostic.accessibilityTrusted && !diagnostic.registeredCategories.isEmpty
            ? .labelColor : .systemOrange
        let labels = diagnostic.registeredCategories.map {
            SessionEventNotification(category: $0, elapsedMilliseconds: 0).label
        }
        registered.stringValue = labels.isEmpty ? "已注册的内部通知：无"
            : "已注册：\(labels.joined(separator: "、"))（注册成功不代表切换时必有通知）"
        counts.stringValue = "内部通知 \(evidence.notificationCount) 次    进出微信 \(evidence.foregroundTransitions) 次"
        history.stringValue = evidence.recentNotifications.isEmpty ? "尚未收到微信内部通知"
            : evidence.recentNotifications.map {
                String(format: "启动后 %6.2f 秒   %@", Double($0.elapsedMilliseconds) / 1000, $0.label)
            }.joined(separator: "\n")
        human.stringValue = "你的反馈：有提示 \(evidence.humanWithPrompt) 次 · 无提示 \(evidence.humanWithoutPrompt) 次"
        timing.stringValue = "剩余 \(Int(ceil(diagnostic.remainingSeconds))) 秒 · 到期自动退出 · 列表时间不是切换响应延迟"
    }

    @objc private func recordWithPrompt() { record(hadPrompt: true) }
    @objc private func recordWithoutPrompt() { record(hadPrompt: false) }

    private func record(hadPrompt: Bool) {
        guard !finished else { return }
        diagnostic.recordHumanObservation(hadPrompt: hadPrompt)
        feedback.stringValue = "已记录：你观察到这次切换\(hadPrompt ? "有" : "无")提示。\n人工反馈和通知分别保留；本窗口不自动判定会话切换已可靠支持。"
    }

    @objc private func end() { diagnostic.finish() }

    func finish() {
        guard !finished else { return }
        finished = true
        timer?.invalidate(); timer = nil
        if let data = try? JSONSerialization.data(withJSONObject: diagnostic.evidence.summary(), options: [.sortedKeys]) {
            FileHandle.standardOutput.write(data + Data([10]))
        }
        window.orderOut(nil)
        NSApp.terminate(nil)
    }

    func windowWillClose(_ notification: Notification) { end() }
}
