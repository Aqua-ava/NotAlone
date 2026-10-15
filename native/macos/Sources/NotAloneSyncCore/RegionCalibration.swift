import AppKit
import CoreGraphics
import Foundation

// 首片只记录用户明确框选的几何，不调用屏幕采集、Vision、AX 或微信控制。
// selected-awaiting-verification 不能作为 SessionCaptureSafety 的可信布局。
@MainActor
public enum RegionCalibration {
    // 坐标入口仍只生成待校验几何；允许在本App表单获得焦点时核对窗口元数据。
    public static func selectCoordinates(_ data: Data) -> [String: Any] {
        guard data.count <= 4096,
              let input = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(input.keys) == ["schemaVersion", "windowSize", "regions"],
              number(input["schemaVersion"]) == 1,
              let size = input["windowSize"] as? [String: Any], Set(size.keys) == ["width", "height"],
              let width = number(size["width"]), let height = number(size["height"]),
              let proposed = input["regions"] as? [String: Any], Set(proposed.keys) == Set(calibrationFields) else {
            return ["ok": false, "error": "calibration_coordinates_invalid"]
        }
        let context: CalibrationContext
        do {
            context = try CalibrationContext.resolve(requireForeground: false)
        } catch let error as CalibrationContextFailure {
            return ["ok": false, "error": error.rawValue]
        } catch {
            return ["ok": false, "error": "calibration_context_unavailable"]
        }
        guard width == context.frame.width, height == context.frame.height else {
            return ["ok": false, "error": "calibration_window_size_changed"]
        }
        let bounds = CGRect(origin: .zero, size: context.frame.size)
        var regions: [String: CGRect] = [:]
        for field in calibrationFields {
            guard let values = proposed[field] as? [String: Any], Set(values.keys) == ["x", "y", "width", "height"],
                  let x = number(values["x"]), let y = number(values["y"]),
                  let width = number(values["width"]), let height = number(values["height"]) else {
                return ["ok": false, "error": "calibration_coordinates_invalid"]
            }
            let rectangle = CGRect(x: x, y: y, width: width, height: height)
            guard allowedCalibrationRegion(rectangle, field: field, bounds: bounds, regions: regions) else {
                return ["ok": false, "error": "calibration_coordinates_invalid"]
            }
            regions[field] = rectangle
        }
        guard CalibrationContext.read(requireForeground: false) == context else {
            return ["ok": false, "error": "calibration_window_changed"]
        }
        return ["ok": true, "selection": context.selection(regions)]
    }

    public static func run() -> [String: Any] {
        let application = NSApplication.shared
        application.setActivationPolicy(.accessory)
        let coordinator = CalibrationCoordinator()
        coordinator.begin()
        application.run()
        coordinator.finish()
        return coordinator.result ?? ["ok": false, "error": "calibration_cancelled"]
    }
}

let calibrationFields = ["displayName", "selectedRowName", "verticalDivider", "headerDivider", "selectedHighlight"]

func number(_ value: Any?) -> Double? {
    guard let value = value as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID(), value.doubleValue.isFinite else { return nil }
    return value.doubleValue
}

func allowedCalibrationRegion(_ rectangle: CGRect, field: String, bounds: CGRect, regions: [String: CGRect]) -> Bool {
    guard bounds.contains(rectangle), rectangle.width >= 1, rectangle.height >= 1,
          !regions.values.contains(where: { $0.intersects(rectangle) }) else { return false }
    switch field {
    case "displayName": return rectangle.width <= 400 && rectangle.height <= 44
    case "selectedRowName": return rectangle.width <= 300 && rectangle.height <= 32
    case "verticalDivider":
        return rectangle.width <= 4 && rectangle.height >= 30
            && rectangle.maxX < regions["displayName"]!.minX
            && rectangle.minX > regions["selectedRowName"]!.maxX
    case "headerDivider":
        return rectangle.height <= 4 && rectangle.width >= 30
            && rectangle.minY > regions["displayName"]!.maxY
            && rectangle.minX >= regions["verticalDivider"]!.maxX
    default:
        return rectangle.width <= 4 && rectangle.height <= 32
            && rectangle.maxX < regions["selectedRowName"]!.minX
            && rectangle.minY < regions["selectedRowName"]!.maxY
            && rectangle.maxY > regions["selectedRowName"]!.minY
    }
}

enum CalibrationContextFailure: String, Error {
    case foregroundApplicationUnavailable = "foreground_application_unavailable"
    case instances = "calibration_wechat_instances_ambiguous"
    case version = "calibration_wechat_version_unsupported"
    case notVisible = "calibration_window_not_visible"
    case windows = "calibration_windows_ambiguous"
    case geometry = "calibration_window_geometry_invalid"
    case unavailable = "calibration_context_unavailable"
}

func selectCalibrationWindow(_ windows: [[String: Any]]) throws -> (windowId: CGWindowID, frame: CGRect) {
    guard !windows.isEmpty else { throw CalibrationContextFailure.notVisible }
    var candidates: [(windowId: CGWindowID, frame: CGRect)] = []
    for window in windows {
        guard let bounds = window[kCGWindowBounds as String] as? NSDictionary,
              let frame = CGRect(dictionaryRepresentation: bounds),
              [frame.origin.x, frame.origin.y, frame.width, frame.height].allSatisfy({ $0.isFinite }),
              frame.width > 0, frame.height > 0,
              let identifier = number(window[kCGWindowNumber as String]), identifier >= 1,
              identifier <= Double(UInt32.max), identifier.rounded() == identifier else {
            throw CalibrationContextFailure.geometry
        }
        // 固定支持版本实机有52×20辅助小窗；只排除无法承载聊天的极小窗口。
        // 其他未知尺寸仍拒绝，不能用“取最大窗口”绕过多个聊天窗口的歧义。
        if frame.width <= 100 && frame.height <= 40 { continue }
        guard frame.width >= 600, frame.height >= 400 else { throw CalibrationContextFailure.windows }
        candidates.append((CGWindowID(identifier), frame))
    }
    guard candidates.count == 1, let candidate = candidates.first else { throw CalibrationContextFailure.windows }
    return candidate
}

struct CalibrationContext: Equatable {
    let processId: pid_t
    let windowId: CGWindowID
    let frame: CGRect
    let version: String
    let build: String

    @MainActor
    static func read(requireForeground: Bool) -> CalibrationContext? {
        try? resolve(requireForeground: requireForeground)
    }

    @MainActor
    static func resolve(requireForeground: Bool) throws -> CalibrationContext {
        var rejection: HeaderChangeContextReadFailure?
        return try resolve(requireForeground: requireForeground, rejection: &rejection)
    }

    // 同一次既有查询的失败投影；不因诊断再读一次OS状态。
    @MainActor
    static func readForHeaderChange(
        resolving: ((inout HeaderChangeContextReadFailure?) throws -> CalibrationContext)? = nil
    ) -> Result<CalibrationContext, HeaderChangeContextReadFailure> {
        var rejection: HeaderChangeContextReadFailure?
        do {
            let current = try resolving?(&rejection)
                ?? resolve(requireForeground: true, rejection: &rejection)
            return .success(current)
        } catch let failure as CalibrationContextFailure {
            return .failure(rejection ?? .classify(failure))
        } catch {
            return .failure(rejection ?? .contextUnavailable)
        }
    }

    @MainActor
    private static func resolve(requireForeground: Bool,
                                rejection: inout HeaderChangeContextReadFailure?) throws -> CalibrationContext {
        let instances = NSRunningApplication.runningApplications(withBundleIdentifier: "com.tencent.xinWeChat")
        guard instances.count == 1, let application = instances.first else {
            rejection = .instanceCount(instances.count)
            throw CalibrationContextFailure.instances
        }
        if requireForeground {
            guard let foreground = NSWorkspace.shared.frontmostApplication else {
                rejection = .foregroundUnknown
                throw CalibrationContextFailure.unavailable
            }
            guard foreground.processIdentifier == application.processIdentifier else {
                rejection = .notWechatForeground
                throw CalibrationContextFailure.unavailable
            }
        }
        guard let bundleURL = application.bundleURL, let bundle = Bundle(url: bundleURL),
              bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String == "4.0.6",
              bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String == "29387" else {
            throw CalibrationContextFailure.version
        }
        guard let information = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
            rejection = .windowListUnavailable
            throw CalibrationContextFailure.unavailable
        }
        // 只取微信PID的窗口编号与几何；不访问窗口名称或其他App的属性。
        let windows = information.filter {
            ($0[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == application.processIdentifier
                && ($0[kCGWindowLayer as String] as? NSNumber)?.intValue == 0
        }
        let window = try selectCalibrationWindow(windows)
        return CalibrationContext(processId: application.processIdentifier, windowId: window.windowId,
                                  frame: window.frame, version: "4.0.6", build: "29387")
    }

    @MainActor
    static func diagnostics(selectedProcessId: pid_t, windowId: CGWindowID, frame: CGRect) -> [String: Any] {
        let front = NSWorkspace.shared.frontmostApplication
        let instances = NSRunningApplication.runningApplications(withBundleIdentifier: "com.tencent.xinWeChat")
        let code: String
        var identityChecks: [String: Bool]?
        do {
            let current = try resolve(requireForeground: true)
            code = current.processId == selectedProcessId && current.windowId == windowId && current.frame == frame
                ? "matched" : "identity_changed"
            identityChecks = current.identityChecks(selectedProcessId: selectedProcessId, windowId: windowId, frame: frame)
        } catch let error as CalibrationContextFailure {
            code = error.rawValue
        } catch {
            code = CalibrationContextFailure.unavailable.rawValue
        }
        return CalibrationContextDiagnostics(
            frontmostProcessId: front?.processIdentifier, frontmostBundleIdentifier: front?.bundleIdentifier,
            frontmostBundlePath: front?.bundleURL?.path, wechatProcessIds: instances.map(\.processIdentifier),
            soleWechatBundlePath: instances.count == 1 ? instances.first?.bundleURL?.path : nil,
            selectedProcessId: selectedProcessId, contextCode: code, identityChecks: identityChecks
        ).jsonObject()
    }

    // 只比较同一次resolve已有的身份，不新增OS查询或保存窗口几何。
    func identityChecks(selectedProcessId: pid_t, windowId: CGWindowID, frame: CGRect) -> [String: Bool] {
        ["process_id_matches": processId == selectedProcessId, "window_id_matches": self.windowId == windowId,
         "window_origin_matches": self.frame.origin == frame.origin, "window_size_matches": self.frame.size == frame.size]
    }

    func selection(_ regions: [String: CGRect]) -> [String: Any] {
        ["schemaVersion": 1, "state": "selected-awaiting-verification", "wechatVersion": version,
         "wechatBuild": build, "processId": processId, "windowId": windowId,
         "windowFrame": coordinates(frame), "regions": regions.mapValues(coordinates)]
    }
}

// 仅记录末次元数据快照，不选择实例、不保存App路径，也不授予采集资格。
struct CalibrationContextDiagnostics {
    let frontmostProcessId: pid_t?
    let frontmostBundleIdentifier: String?
    let frontmostBundlePath: String?
    let wechatProcessIds: [pid_t]
    let soleWechatBundlePath: String?
    let selectedProcessId: pid_t
    let contextCode: String
    let identityChecks: [String: Bool]?

    func jsonObject() -> [String: Any] {
        let sole = wechatProcessIds.count == 1 ? wechatProcessIds[0] : 0
        var result: [String: Any] = ["front_app_code": applicationCode(frontmostBundleIdentifier, path: frontmostBundlePath, pid: frontmostProcessId),
                "front_process_id": frontmostProcessId ?? 0, "selected_process_id": selectedProcessId,
                "wechat_instance_count": wechatProcessIds.count, "sole_wechat_process_id": sole,
                "sole_wechat_app_code": applicationCode(sole == 0 ? nil : "com.tencent.xinWeChat", path: soleWechatBundlePath, pid: sole),
                "context_code": contextCode]
        if let identityChecks { result["identity_checks"] = identityChecks }
        return result
    }

    private func applicationCode(_ identifier: String?, path: String?, pid: pid_t?) -> String {
        guard let pid, pid > 0 else { return "none" }
        switch identifier {
        case "com.tencent.xinWeChat":
            guard let path else { return "wechat_unknown" }
            return path == "/Applications/WeChat.app" ? "wechat_primary" : "wechat_other"
        case "com.notalone.desktop": return "notalone"
        case "com.javahello.notalone.NotAloneSyncProbe": return "probe"
        default: return "other"
        }
    }
}

private func coordinates(_ rectangle: CGRect) -> [String: Double] {
    ["x": rectangle.minX, "y": rectangle.minY, "width": rectangle.width, "height": rectangle.height]
}

@MainActor
private final class CalibrationPanel: NSPanel {
    override var canBecomeKey: Bool { true }
}

@MainActor
private final class CalibrationCoordinator {
    private var timer: Timer?
    private var panel: NSPanel?
    private var context: CalibrationContext?
    private let deadline = Date().addingTimeInterval(360)
    private(set) var result: [String: Any]?

    func begin() {
        timer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.tick() }
        }
    }

    private func tick() {
        guard Date() < deadline else { complete(["ok": false, "error": "calibration_timeout"]); return }
        if let context {
            guard NSWorkspace.shared.frontmostApplication?.processIdentifier == ProcessInfo.processInfo.processIdentifier,
                  CalibrationContext.read(requireForeground: false) == context else {
                complete(["ok": false, "error": "calibration_window_changed"]); return
            }
            return
        }
        guard let context = CalibrationContext.read(requireForeground: true),
              let primaryScreen = NSScreen.screens.first else { return }
        self.context = context
        let screenFrame = CGRect(x: context.frame.minX, y: primaryScreen.frame.maxY - context.frame.maxY,
                                 width: context.frame.width, height: context.frame.height)
        guard NSScreen.screens.filter({ $0.frame.contains(screenFrame) }).count == 1 else {
            complete(["ok": false, "error": "calibration_window_spans_displays"]); return
        }
        let panel = CalibrationPanel(contentRect: screenFrame, styleMask: [.borderless], backing: .buffered, defer: false)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.level = .floating
        panel.hidesOnDeactivate = true
        panel.isReleasedWhenClosed = false
        let view = CalibrationView(frame: CGRect(origin: .zero, size: screenFrame.size)) { [weak self] rectangles in
            guard let self else { return }
            guard Date() < self.deadline else {
                self.complete(["ok": false, "error": "calibration_timeout"]); return
            }
            guard let rectangles, CalibrationContext.read(requireForeground: false) == context else {
                self.complete(["ok": false, "error": "calibration_cancelled"]); return
            }
            self.complete(["ok": true, "selection": context.selection(rectangles)])
        }
        panel.contentView = view
        self.panel = panel
        NSApplication.shared.activate(ignoringOtherApps: true)
        panel.makeKeyAndOrderFront(nil)
        panel.makeFirstResponder(view)
    }

    private func complete(_ result: [String: Any]) {
        guard self.result == nil else { return }
        self.result = result
        finish()
        NSApplication.shared.stop(nil)
        // stop不会自行唤醒当前事件循环；只向本App投递空事件。
        if let event = NSEvent.otherEvent(with: .applicationDefined, location: .zero, modifierFlags: [],
                                         timestamp: 0, windowNumber: 0, context: nil, subtype: 0, data1: 0, data2: 0) {
            NSApplication.shared.postEvent(event, atStart: true)
        }
    }

    func finish() {
        timer?.invalidate(); timer = nil
        if let sheet = panel?.attachedSheet {
            panel?.endSheet(sheet, returnCode: .abort)
            sheet.orderOut(nil)
        }
        panel?.orderOut(nil); panel?.close(); panel = nil
    }
}

@MainActor
private final class CalibrationView: NSView {
    private let fields = calibrationFields
    private let instructions = [
        "1/5 框出顶部当前会话名；仅名字，不含聊天正文。",
        "2/5 框出左侧当前选中会话的名字；不含头像、预览或其他联系人。",
        "3/5 框出聊天区左侧无文字分隔细条（宽度不超过4点）。",
        "4/5 框出标题下方无文字分隔细条（高度不超过4点）。",
        "5/5 框出当前选中行左侧无文字高亮细条（宽度不超过4点）。",
    ]
    private var regions: [String: CGRect] = [:]
    private var start: CGPoint?
    private var dragging: CGRect?
    private var error: String?
    private let completed: ([String: CGRect]?) -> Void
    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { true }

    init(frame: CGRect, completed: @escaping ([String: CGRect]?) -> Void) {
        self.completed = completed
        super.init(frame: frame)
    }
    required init?(coder: NSCoder) { nil }

    override func draw(_ dirtyRect: NSRect) {
        NSColor.black.withAlphaComponent(0.07).setFill()
        bounds.fill()
        NSColor.systemGreen.setStroke()
        for rectangle in regions.values { NSBezierPath(rect: rectangle).stroke() }
        NSColor.systemRed.setStroke()
        if let dragging { NSBezierPath(rect: dragging).stroke() }
        let message = regions.count < fields.count ? instructions[regions.count] : "五个区域已选。回车确认仅保存待校验几何；退格重选，Esc取消。"
        let text = message + "\n" + (error ?? "拖动框选；退格撤销上一步，Esc取消。全程不截图。")
        let box = CGRect(x: 10, y: max(0, bounds.height - 72), width: max(0, bounds.width - 20), height: 62)
        NSColor.windowBackgroundColor.withAlphaComponent(0.96).setFill()
        box.fill()
        (text as NSString).draw(in: box.insetBy(dx: 8, dy: 6), withAttributes: [.font: NSFont.systemFont(ofSize: 13), .foregroundColor: NSColor.labelColor])
    }

    override func mouseDown(with event: NSEvent) {
        guard regions.count < fields.count else { return }
        start = convert(event.locationInWindow, from: nil)
        dragging = nil; error = nil
    }
    override func mouseDragged(with event: NSEvent) {
        guard let start else { return }
        let end = convert(event.locationInWindow, from: nil)
        dragging = CGRect(x: min(start.x, end.x), y: min(start.y, end.y),
                          width: abs(end.x - start.x), height: abs(end.y - start.y)).integral
        needsDisplay = true
    }
    override func mouseUp(with event: NSEvent) {
        guard let rectangle = dragging, regions.count < fields.count else { start = nil; return }
        let field = fields[regions.count]
        if allowed(rectangle, field: field) { regions[field] = rectangle }
        else { error = "区域尺寸或位置不符合最小范围，请重新框选。" }
        start = nil; dragging = nil; needsDisplay = true
    }
    private func allowed(_ rectangle: CGRect, field: String) -> Bool {
        allowedCalibrationRegion(rectangle, field: field, bounds: bounds, regions: regions)
    }
    override func keyDown(with event: NSEvent) {
        if event.keyCode == 53 { completed(nil); return }
        if event.keyCode == 51, !regions.isEmpty {
            regions.removeValue(forKey: fields[regions.count - 1]); error = nil; needsDisplay = true; return
        }
        if event.keyCode == 36, regions.count == fields.count {
            guard let window, window.attachedSheet == nil else { return }
            let alert = NSAlert()
            alert.messageText = "确认最小区域选择"
            alert.informativeText = "请确认名字框只含当前会话名，三个细条不含文字或其他联系人。仅保存窗口标识、版本和几何；尚未采集或验证，自动定位仍暂停。"
            alert.addButton(withTitle: "确认选择")
            alert.addButton(withTitle: "继续调整")
            alert.beginSheetModal(for: window) { [weak self] response in
                guard response == .alertFirstButtonReturn, let self else { return }
                self.completed(self.regions)
            }
            return
        }
        super.keyDown(with: event)
    }
}
