// 开发诊断：仅统计微信的界面通知；不读取 AX 文本、不采图、不申请权限。
import AppKit
import ApplicationServices
import Foundation

@MainActor
final class SessionEventCapabilities {
    private var observer: AXObserver?
    private var registrations: [(AXUIElement, CFString)] = []
    private var workspaceTokens: [NSObjectProtocol] = []
    private var counts: [String: Int] = [:]
    private var supported: [String: Int] = [:]
    private var rejected = 0
    private var foregroundTransitions = 0
    private var timer: Timer?
    private var started = Date()
    private var processId: pid_t?

    private static let notifications: [(String, String)] = [
        (kAXFocusedUIElementChangedNotification, "focus"),
        (kAXFocusedWindowChangedNotification, "window"),
        (kAXSelectedChildrenChangedNotification, "selection"),
        (kAXSelectedRowsChangedNotification, "rows"),
        (kAXTitleChangedNotification, "title"),
        (kAXWindowMovedNotification, "moved"),
        (kAXWindowResizedNotification, "resized"),
    ]

    func start(seconds: TimeInterval) {
        started = Date()
        let trusted = AXIsProcessTrusted()
        let applications = NSRunningApplication.runningApplications(withBundleIdentifier: "com.tencent.xinWeChat")
        let unique = applications.count == 1
        if trusted, unique, let application = applications.first {
            processId = application.processIdentifier
            register(processId: application.processIdentifier)
        }
        let center = NSWorkspace.shared.notificationCenter
        for name in [NSWorkspace.didActivateApplicationNotification, NSWorkspace.didDeactivateApplicationNotification] {
            workspaceTokens.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] notification in
                guard let application = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication,
                      application.bundleIdentifier == "com.tencent.xinWeChat" else { return }
                MainActor.assumeIsolated { self?.foregroundTransitions += 1 }
            })
        }
        emit(["event": "session_event_capabilities_ready", "accessibility_trusted": trusted,
              "unique_wechat": unique, "registered": supported, "rejected": rejected,
              "duration_seconds": Int(seconds), "images": 0, "text_reads": 0])
        timer = Timer.scheduledTimer(withTimeInterval: max(0.01, seconds - Date().timeIntervalSince(started)), repeats: false) { [weak self] _ in
            MainActor.assumeIsolated { self?.finish() }
        }
    }

    private func register(processId: pid_t) {
        var result: AXObserver?
        let callback: AXObserverCallback = { _, _, notification, context in
            guard let context else { return }
            MainActor.assumeIsolated {
                Unmanaged<SessionEventCapabilities>.fromOpaque(context).takeUnretainedValue()
                    .received(notification as String)
            }
        }
        guard AXObserverCreate(processId, callback, &result) == .success, let result else { return }
        observer = result
        let application = AXUIElementCreateApplication(processId)
        AXUIElementSetMessagingTimeout(application, 0.05)
        var elements = [application]
        // 只取得窗口对象引用；不读取标题、正文、联系人列表或其子元素。
        var windows: CFTypeRef?
        if AXUIElementCopyAttributeValue(application, kAXWindowsAttribute as CFString, &windows) == .success,
           let windows = windows as? [AXUIElement] {
            elements += windows.prefix(8)
        }
        let deadline = Date().addingTimeInterval(2)
        registration: for element in elements {
            // AX 超时只作用于当前对象，不会由应用对象传播到窗口。
            guard AXUIElementSetMessagingTimeout(element, 0.05) == .success else { continue }
            for (notification, category) in Self.notifications {
                if Date() >= deadline { break registration }
                let name = notification as CFString
                if AXObserverAddNotification(result, element, name,
                    Unmanaged.passUnretained(self).toOpaque()) == .success {
                    registrations.append((element, name))
                    supported[category, default: 0] += 1
                } else { rejected += 1 }
            }
        }
        CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(result), .commonModes)
    }

    private func received(_ notification: String) {
        guard let processId,
              NSWorkspace.shared.frontmostApplication?.processIdentifier == processId,
              let category = Self.notifications.first(where: { $0.0 == notification })?.1 else { return }
        counts[category, default: 0] += 1
        // 每类只报告计数和相对时间；不输出事件对象、窗口身份或 AX 属性。
        emit(["event": "session_event_capability", "category": category,
              "count": counts[category]!, "elapsed_ms": Int(Date().timeIntervalSince(started) * 1000)])
    }

    private func finish() {
        timer?.invalidate()
        for token in workspaceTokens { NSWorkspace.shared.notificationCenter.removeObserver(token) }
        workspaceTokens.removeAll()
        if let observer {
            CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .commonModes)
            let deadline = Date().addingTimeInterval(2)
            for (element, name) in registrations {
                if Date() >= deadline { break }
                AXObserverRemoveNotification(observer, element, name)
            }
        }
        registrations.removeAll()
        observer = nil
        emit(["event": "session_event_capabilities_closed", "counts": counts,
              "foreground_transitions": foregroundTransitions, "images": 0, "text_reads": 0])
        exit(EXIT_SUCCESS)
    }

    private func emit(_ object: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else { return }
        FileHandle.standardOutput.write(data + Data([10]))
    }
}

@main
struct SessionEventDiagnostic {
    @MainActor
    static func main() {
        let arguments = Array(CommandLine.arguments.dropFirst())
        guard arguments.count == 2, arguments[0] == "--seconds",
              let seconds = Double(arguments[1]), seconds.isFinite, (5...120).contains(seconds) else {
            fputs("只接受 --seconds 5..120；诊断未开始。\n", stderr)
            exit(EXIT_FAILURE)
        }
        NSApplication.shared.setActivationPolicy(.prohibited)
        let diagnostic = SessionEventCapabilities()
        diagnostic.start(seconds: seconds)
        withExtendedLifetime(diagnostic) { RunLoop.main.run() }
    }
}
