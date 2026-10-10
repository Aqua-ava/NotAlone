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
              let proposed = input["regions"] as? [String: Any], Set(proposed.keys) == Set(calibrationFields),
              let context = CalibrationContext.read(requireForeground: false),
              width == context.frame.width, height == context.frame.height else {
            return ["ok": false, "error": "calibration_coordinates_invalid"]
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

struct CalibrationContext: Equatable {
    let processId: pid_t
    let windowId: CGWindowID
    let frame: CGRect
    let version: String
    let build: String

    @MainActor
    static func read(requireForeground: Bool) -> CalibrationContext? {
        let instances = NSRunningApplication.runningApplications(withBundleIdentifier: "com.tencent.xinWeChat")
        guard instances.count == 1, let application = instances.first,
              !requireForeground || NSWorkspace.shared.frontmostApplication?.processIdentifier == application.processIdentifier,
              let bundleURL = application.bundleURL, let bundle = Bundle(url: bundleURL),
              bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String == "4.0.6",
              bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String == "29387",
              let information = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
            return nil
        }
        // 只取微信PID的窗口编号与几何；不访问窗口名称或其他App的属性。
        let windows = information.filter {
            ($0[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == application.processIdentifier
                && ($0[kCGWindowLayer as String] as? NSNumber)?.intValue == 0
        }
        guard windows.count == 1, let window = windows.first,
              let bounds = window[kCGWindowBounds as String] as? NSDictionary,
              let frame = CGRect(dictionaryRepresentation: bounds),
              frame.width >= 600, frame.height >= 400,
              let number = window[kCGWindowNumber as String] as? NSNumber else { return nil }
        return CalibrationContext(processId: application.processIdentifier, windowId: number.uint32Value,
                                  frame: frame, version: "4.0.6", build: "29387")
    }

    func selection(_ regions: [String: CGRect]) -> [String: Any] {
        ["schemaVersion": 1, "state": "selected-awaiting-verification", "wechatVersion": version,
         "wechatBuild": build, "processId": processId, "windowId": windowId,
         "windowFrame": coordinates(frame), "regions": regions.mapValues(coordinates)]
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
