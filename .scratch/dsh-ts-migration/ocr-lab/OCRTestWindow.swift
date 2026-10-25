import AppKit
import Darwin
import Foundation

private let wechatBundleIdentifier = "com.tencent.xinWeChat"
private let projectDirectory = ProcessInfo.processInfo.environment["NOTALONE_PROJECT_DIR"]
    ?? FileManager.default.currentDirectoryPath
private let defaultProbePath = "\(projectDirectory)/native/macos/build/cli/notalone-sync-probe"
private let captureTimeout: TimeInterval = 30
private let ocrBudgetMilliseconds = 2_500.0
private let minimumConfidence = 0.90

private final class CaptureLabAppDelegate: NSObject, NSApplicationDelegate {
    private var panel: NSPanel?
    private var statusItem: NSStatusItem?
    private var captureButton: NSButton!
    private var cancelButton: NSButton!
    private var headlineLabel: NSTextField!
    private var elapsedLabel: NSTextField!
    private var timingLabel: NSTextField!
    private var confidenceLabel: NSTextField!
    private var outputView: NSTextView!
    private var spinner: NSProgressIndicator!

    private var activeProcess: Process?
    private var stdoutPipe: Pipe?
    private var stderrPipe: Pipe?
    private var elapsedTimer: Timer?
    private var hardTimeoutWorkItem: DispatchWorkItem?
    private var runGeneration = 0
    private var processStartedAt: TimeInterval = 0
    private var didTimeout = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        installApplicationMenu()
        installStatusItem()
        buildPanel()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    private func installApplicationMenu() {
        let mainMenu = NSMenu()
        let applicationItem = NSMenuItem()
        let applicationMenu = NSMenu()
        let captureItem = NSMenuItem(
            title: "截图并识别微信顶部名称",
            action: #selector(captureAfterActivatingWeChat),
            keyEquivalent: ""
        )
        captureItem.target = self
        applicationMenu.addItem(captureItem)
        applicationMenu.addItem(.separator())
        applicationMenu.addItem(
            withTitle: "退出 OCR 实验台",
            action: #selector(NSApplication.terminate(_:)),
            keyEquivalent: "q"
        )
        applicationItem.submenu = applicationMenu
        mainMenu.addItem(applicationItem)
        NSApp.mainMenu = mainMenu
    }

    private func installStatusItem() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.title = "OCR 抓取"
        let menu = NSMenu(title: "OCR 抓取")

        let captureItem = NSMenuItem(
            title: "立即截图并识别",
            action: #selector(captureAfterActivatingWeChat),
            keyEquivalent: ""
        )
        captureItem.target = self
        menu.addItem(captureItem)

        let showItem = NSMenuItem(
            title: "显示实验台",
            action: #selector(showPanel),
            keyEquivalent: ""
        )
        showItem.target = self
        menu.addItem(showItem)

        menu.addItem(.separator())
        menu.addItem(
            withTitle: "退出",
            action: #selector(NSApplication.terminate(_:)),
            keyEquivalent: "q"
        )
        item.menu = menu
        statusItem = item
    }

    private func buildPanel() {
        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 760, height: 560),
            styleMask: [
                .titled,
                .closable,
                .miniaturizable,
                .utilityWindow,
                .nonactivatingPanel,
            ],
            backing: .buffered,
            defer: false
        )
        panel.title = "微信顶部 OCR 实测"
        panel.minSize = NSSize(width: 680, height: 500)
        panel.level = .floating
        panel.hidesOnDeactivate = false
        panel.becomesKeyOnlyIfNeeded = true
        panel.isFloatingPanel = true
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.isReleasedWhenClosed = false
        panel.setFrameAutosaveName("NotAloneWeChatHeaderOCRLab")
        self.panel = panel

        guard let content = panel.contentView else { return }
        content.wantsLayer = true
        content.layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor

        let title = makeLabel(
            "微信顶部 OCR 实测",
            frame: NSRect(x: 24, y: 514, width: 420, height: 30),
            font: .systemFont(ofSize: 24, weight: .semibold),
            color: .labelColor
        )
        content.addSubview(title)

        let instructions = makeLabel(
            "先把微信当前私聊窗口置前，再点“立即截图并识别”。工具只会激活微信、截取当前唯一窗口，在该窗口内存中定位顶部名称并做局部 OCR；不会切换会话、滚动聊天或读取正文。",
            frame: NSRect(x: 24, y: 472, width: 712, height: 36),
            font: .systemFont(ofSize: 12),
            color: .secondaryLabelColor
        )
        instructions.maximumNumberOfLines = 2
        content.addSubview(instructions)

        captureButton = makeButton(
            "立即截图并识别",
            action: #selector(captureAfterActivatingWeChat),
            frame: NSRect(x: 24, y: 426, width: 150, height: 34)
        )
        captureButton.keyEquivalent = "\r"
        content.addSubview(captureButton)

        cancelButton = makeButton(
            "取消",
            action: #selector(cancelCapture),
            frame: NSRect(x: 184, y: 426, width: 76, height: 34)
        )
        cancelButton.isEnabled = false
        content.addSubview(cancelButton)

        let shortcutHint = makeLabel(
            "也可从菜单栏“OCR 抓取”直接启动。当前真实测试固定：accurate / revision 3 / zh-Hans + en-US / 关闭语言校正。",
            frame: NSRect(x: 276, y: 432, width: 460, height: 20),
            font: .systemFont(ofSize: 11),
            color: .tertiaryLabelColor
        )
        shortcutHint.alignment = .right
        content.addSubview(shortcutHint)

        let statusBox = NSBox(frame: NSRect(x: 24, y: 272, width: 712, height: 138))
        statusBox.boxType = .custom
        statusBox.titlePosition = .noTitle
        statusBox.fillColor = NSColor.controlBackgroundColor
        statusBox.borderColor = NSColor.separatorColor
        statusBox.borderWidth = 1
        statusBox.cornerRadius = 8
        content.addSubview(statusBox)

        headlineLabel = makeLabel(
            "等待实测",
            frame: NSRect(x: 40, y: 360, width: 650, height: 34),
            font: .systemFont(ofSize: 24, weight: .semibold),
            color: .labelColor
        )
        content.addSubview(headlineLabel)

        elapsedLabel = makeLabel(
            "计时 —",
            frame: NSRect(x: 40, y: 328, width: 650, height: 24),
            font: .monospacedSystemFont(ofSize: 15, weight: .medium),
            color: .labelColor
        )
        content.addSubview(elapsedLabel)

        timingLabel = makeLabel(
            "截图 — · OCR — · 总计 —",
            frame: NSRect(x: 40, y: 300, width: 650, height: 22),
            font: .monospacedSystemFont(ofSize: 13, weight: .regular),
            color: .secondaryLabelColor
        )
        content.addSubview(timingLabel)

        confidenceLabel = makeLabel(
            "置信度 —（门槛 0.90） · 名称完整性 —",
            frame: NSRect(x: 40, y: 278, width: 650, height: 20),
            font: .monospacedSystemFont(ofSize: 13, weight: .regular),
            color: .secondaryLabelColor
        )
        content.addSubview(confidenceLabel)

        spinner = NSProgressIndicator(frame: NSRect(x: 700, y: 368, width: 20, height: 20))
        spinner.style = .spinning
        spinner.controlSize = .regular
        spinner.isDisplayedWhenStopped = false
        content.addSubview(spinner)

        let scroll = NSScrollView(frame: NSRect(x: 24, y: 24, width: 712, height: 228))
        scroll.borderType = .bezelBorder
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        outputView = NSTextView(frame: scroll.contentView.bounds)
        outputView.isEditable = false
        outputView.isSelectable = true
        outputView.isRichText = false
        outputView.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
        outputView.textColor = .labelColor
        outputView.backgroundColor = .textBackgroundColor
        outputView.textContainerInset = NSSize(width: 10, height: 10)
        outputView.string = """
        操作：
        1. 在微信中打开要测试的私聊，保持该窗口在前台。
        2. 点击上方“立即截图并识别”。
        3. 工具自动切回微信并抓取当前唯一窗口，然后只 OCR 顶部名称。

        结果会显示本机实际读到的名称、截图/OCR/总耗时、置信度和完整性。
        原始截图只在探针进程内存中处理，不落盘、不上传；聊天正文和其他联系人列表不进入 OCR。
        """
        scroll.documentView = outputView
        content.addSubview(scroll)

        panel.center()
        panel.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func makeLabel(
        _ text: String,
        frame: NSRect,
        font: NSFont,
        color: NSColor
    ) -> NSTextField {
        let label = NSTextField(labelWithString: text)
        label.frame = frame
        label.font = font
        label.textColor = color
        label.lineBreakMode = .byTruncatingTail
        return label
    }

    private func makeButton(
        _ title: String,
        action: Selector,
        frame: NSRect
    ) -> NSButton {
        let button = NSButton(title: title, target: self, action: action)
        button.frame = frame
        button.bezelStyle = .rounded
        return button
    }

    @objc private func showPanel() {
        panel?.makeKeyAndOrderFront(nil)
    }

    @objc private func captureAfterActivatingWeChat() {
        guard activeProcess == nil else { return }
        guard let wechat = NSRunningApplication
            .runningApplications(withBundleIdentifier: wechatBundleIdentifier)
            .first(where: { !$0.isTerminated }) else {
            showError(
                headline: "微信没有运行",
                detail: "请先打开微信并进入一个私聊，再重新点击。"
            )
            return
        }

        headlineLabel.stringValue = "正在切回微信…"
        headlineLabel.textColor = .labelColor
        outputView.string = "工具只把微信应用切到前台，不切换、滚动或选择会话。"
        let activated = wechat.activate(options: [.activateAllWindows])
        guard activated else {
            showError(
                headline: "无法切回微信",
                detail: "系统拒绝激活微信。请手动切回微信后，从菜单栏“OCR 抓取”重试。"
            )
            return
        }

        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self] in
            guard let self else { return }
            guard NSWorkspace.shared.frontmostApplication?.bundleIdentifier
                    == wechatBundleIdentifier else {
                self.showError(
                    headline: "微信没有保持在前台",
                    detail: "请手动把目标微信私聊窗口置前，再从菜单栏“OCR 抓取”启动。"
                )
                return
            }
            self.startCapture()
        }
    }

    private func startCapture() {
        let probePath = ProcessInfo.processInfo.environment["NOTALONE_SYNC_PROBE"]
            ?? defaultProbePath
        guard FileManager.default.isExecutableFile(atPath: probePath) else {
            showError(
                headline: "找不到原生探针",
                detail: "缺少可执行文件：\(probePath)"
            )
            return
        }

        runGeneration += 1
        let generation = runGeneration
        processStartedAt = ProcessInfo.processInfo.systemUptime
        didTimeout = false

        let process = Process()
        process.executableURL = URL(fileURLWithPath: probePath)
        process.arguments = ["--session", "--json", "--single-frame"]
        process.currentDirectoryURL = URL(fileURLWithPath: projectDirectory)
        var environment = ProcessInfo.processInfo.environment
        environment["NOTALONE_OBSERVATION_MEASUREMENTS"] = "1"
        process.environment = environment

        let stdout = Pipe()
        let stderr = Pipe()
        process.standardOutput = stdout
        process.standardError = stderr

        activeProcess = process
        stdoutPipe = stdout
        stderrPipe = stderr
        captureButton.isEnabled = false
        cancelButton.isEnabled = true
        spinner.startAnimation(nil)
        headlineLabel.stringValue = "正在截图并识别…"
        headlineLabel.textColor = .labelColor
        elapsedLabel.stringValue = "总耗时 0.0 ms"
        timingLabel.stringValue = "截图 — · OCR — · 总计 —"
        confidenceLabel.stringValue = "置信度 —（门槛 0.90） · 名称完整性 —"
        outputView.string = "正在抓取当前微信窗口并定位顶部名称区域。\n原始截图不会保存到磁盘。"

        elapsedTimer?.invalidate()
        elapsedTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) {
            [weak self] _ in
            guard let self, self.activeProcess != nil else { return }
            let elapsed = (ProcessInfo.processInfo.systemUptime - self.processStartedAt) * 1_000
            self.elapsedLabel.stringValue = String(format: "总耗时 %.1f ms", elapsed)
            if elapsed > ocrBudgetMilliseconds {
                self.headlineLabel.stringValue = "仍在识别（已超过 2500ms）"
                self.headlineLabel.textColor = .systemOrange
            }
        }

        let hardTimeout = DispatchWorkItem { [weak self, weak process] in
            guard let self, let process, self.runGeneration == generation,
                  process.isRunning else { return }
            self.didTimeout = true
            self.headlineLabel.stringValue = "30 秒仍未完成，正在终止本次调用"
            self.headlineLabel.textColor = .systemRed
            Darwin.kill(process.processIdentifier, SIGKILL)
        }
        hardTimeoutWorkItem = hardTimeout
        DispatchQueue.main.asyncAfter(
            deadline: .now() + captureTimeout,
            execute: hardTimeout
        )

        process.terminationHandler = { [weak self] process in
            let stdoutData = stdout.fileHandleForReading.readDataToEndOfFile()
            let stderrData = stderr.fileHandleForReading.readDataToEndOfFile()
            let status = process.terminationStatus
            let reason = process.terminationReason
            DispatchQueue.main.async {
                guard let self, self.runGeneration == generation else { return }
                self.finishCapture(
                    stdout: stdoutData,
                    stderr: stderrData,
                    terminationStatus: status,
                    terminationReason: reason
                )
            }
        }

        do {
            try process.run()
        } catch {
            activeProcess = nil
            stdoutPipe = nil
            stderrPipe = nil
            captureButton.isEnabled = true
            cancelButton.isEnabled = false
            spinner.stopAnimation(nil)
            elapsedTimer?.invalidate()
            hardTimeoutWorkItem?.cancel()
            showError(headline: "探针启动失败", detail: error.localizedDescription)
        }
    }

    @objc private func cancelCapture() {
        guard let process = activeProcess, process.isRunning else { return }
        headlineLabel.stringValue = "正在取消…"
        headlineLabel.textColor = .systemOrange
        Darwin.kill(process.processIdentifier, SIGTERM)
    }

    private func finishCapture(
        stdout: Data,
        stderr: Data,
        terminationStatus: Int32,
        terminationReason: Process.TerminationReason
    ) {
        elapsedTimer?.invalidate()
        elapsedTimer = nil
        hardTimeoutWorkItem?.cancel()
        hardTimeoutWorkItem = nil
        activeProcess = nil
        stdoutPipe = nil
        stderrPipe = nil
        spinner.stopAnimation(nil)
        captureButton.isEnabled = true
        cancelButton.isEnabled = false

        let processElapsed = (ProcessInfo.processInfo.systemUptime - processStartedAt) * 1_000
        let measurements = parseMeasurements(stderr)
        let captureMilliseconds = duration(
            from: measurements["captureRequested"],
            to: measurements["frameReceived"]
        )
        let ocrMilliseconds = duration(
            from: measurements["headerOcrStarted"],
            to: measurements["headerOcrCompleted"]
        )
        let measuredTotal = duration(
            from: measurements["started"],
            to: measurements["finished"]
        )
        let totalMilliseconds = measuredTotal ?? processElapsed

        elapsedLabel.stringValue = String(
            format: "本次总耗时 %.1f ms",
            processElapsed
        )
        timingLabel.stringValue = String(
            format: "截图 %@ · OCR %@ · 探针总计 %.1f ms",
            milliseconds(captureMilliseconds),
            milliseconds(ocrMilliseconds),
            totalMilliseconds
        )

        guard let result = parseJSONLine(stdout) else {
            let terminal = didTimeout
                ? "本次在 30 秒上限处终止，没有收到最终 JSON。"
                : terminationReason == .uncaughtSignal
                ? "探针被系统以信号 \(terminationStatus)（SIG\(signalName(terminationStatus))) 终止，没有收到最终 JSON。"
                : "探针退出码 \(terminationStatus)，没有收到最终 JSON。"
            showError(
                headline: didTimeout ? "OCR 超过 30 秒未返回" : "探针未返回有效结果",
                detail:
                    "\(terminal)\n\n阶段耗时：\(timingLabel.stringValue)\n\n"
                    + measurementSummary(measurements)
            )
            return
        }

        if result["wechat_in_front"] as? Bool == false {
            showError(
                headline: "微信不在前台",
                detail: "当前没有抓取画面。请先切回微信目标私聊，再从“OCR 抓取”启动。"
            )
            return
        }

        guard result["ok"] as? Bool == true else {
            let stage = result["stage"] as? String ?? "unknown"
            let code = result["error"] as? String ?? "unknown"
            showError(
                headline: "没有完成名称 OCR",
                detail:
                    "阶段：\(stageLabel(stage))\n错误：\(code)\n\n"
                    + "阶段耗时：\(timingLabel.stringValue)\n\n"
                    + measurementSummary(measurements)
            )
            return
        }

        let name = result["display_name"] as? String ?? ""
        let quality = result["quality"] as? [String: Any] ?? [:]
        let confidence = number(quality["display_name_confidence"])
        let complete = quality["name_complete"] as? Bool ?? false
        let confidencePassed = (confidence ?? -1) >= minimumConfidence
        let timePassed = (ocrMilliseconds ?? .infinity) <= ocrBudgetMilliseconds

        confidenceLabel.stringValue = confidence.map {
            String(
                format: "置信度 %.4f（%@ 0.90） · 名称%@",
                $0,
                $0 >= minimumConfidence ? "通过" : "低于",
                complete ? "完整" : "不完整"
            )
        } ?? "置信度 — · 名称\(complete ? "完整" : "不完整")"

        if !timePassed {
            headlineLabel.stringValue = "OCR 超出 2500ms"
            headlineLabel.textColor = .systemOrange
        } else if !confidencePassed {
            headlineLabel.stringValue = "识别完成，但置信度不足"
            headlineLabel.textColor = .systemOrange
        } else if !complete {
            headlineLabel.stringValue = "识别完成，但名称不完整"
            headlineLabel.textColor = .systemOrange
        } else {
            headlineLabel.stringValue = "通过：\(name)"
            headlineLabel.textColor = .systemGreen
        }

        let capturedAt = result["captured_at"] as? String ?? "—"
        let captureVersion = result["capture_version"] as? String ?? "—"
        outputView.string = """
        微信顶部名称：\(name.isEmpty ? "（空）" : name)

        截图耗时：\(milliseconds(captureMilliseconds))
        OCR 耗时：\(milliseconds(ocrMilliseconds))
        探针总计：\(String(format: "%.1f ms", totalMilliseconds))

        置信度门槛：\(confidencePassed ? "通过" : "未通过")（最低 0.90）
        OCR 时限：\(timePassed ? "通过" : "未通过")（最高 2500ms）
        名称完整性：\(complete ? "通过" : "未通过")

        采集时点：\(capturedAt)
        协议版本：\(captureVersion)

        \(measurementSummary(measurements))

        原始截图仅在本轮探针内存中处理，未保存、未上传；没有 OCR 聊天正文或其他联系人列表。
        """
    }

    private func parseMeasurements(_ data: Data) -> [String: Double] {
        guard let text = String(data: data, encoding: .utf8) else { return [:] }
        var values: [String: Double] = [:]
        for line in text.split(whereSeparator: \.isNewline) {
            let parts = line.split(separator: " ", omittingEmptySubsequences: true)
            guard parts.count == 3,
                  parts[0] == "notalone-observation-v1",
                  let timestamp = Double(parts[2]) else { continue }
            values[String(parts[1])] = timestamp
        }
        return values
    }

    private func parseJSONLine(_ data: Data) -> [String: Any]? {
        guard let text = String(data: data, encoding: .utf8) else { return nil }
        for line in text.split(whereSeparator: \.isNewline).reversed() {
            guard let lineData = String(line).data(using: .utf8),
                  let object = try? JSONSerialization.jsonObject(with: lineData),
                  let result = object as? [String: Any] else { continue }
            return result
        }
        return nil
    }

    private func duration(from start: Double?, to end: Double?) -> Double? {
        guard let start, let end, end >= start else { return nil }
        return (end - start) * 1_000
    }

    private func milliseconds(_ value: Double?) -> String {
        value.map { String(format: "%.1f ms", $0) } ?? "—"
    }

    private func number(_ value: Any?) -> Double? {
        if let value = value as? NSNumber {
            return value.doubleValue
        }
        return value as? Double
    }

    private func signalName(_ signal: Int32) -> String {
        switch signal {
        case SIGTERM: return "TERM"
        case SIGKILL: return "KILL"
        case SIGABRT: return "ABRT"
        case SIGSEGV: return "SEGV"
        case SIGBUS: return "BUS"
        default: return String(signal)
        }
    }

    private func stageLabel(_ stage: String) -> String {
        switch stage {
        case "context": return "\(stage)（前台/窗口检查）"
        case "capture": return "\(stage)（窗口截图）"
        case "context_after_capture": return "\(stage)（截图后窗口复验）"
        case "layout": return "\(stage)（顶部名称区域定位）"
        case "header_ocr": return "\(stage)（顶部名称 OCR）"
        case "context_after_names": return "\(stage)（OCR 后窗口复验）"
        default: return stage
        }
    }

    private func measurementSummary(_ values: [String: Double]) -> String {
        let order = [
            "started",
            "foregroundAccepted",
            "captureRequested",
            "captureCompleted",
            "frameReceived",
            "headerOcrStarted",
            "headerOcrCompleted",
            "finished",
        ]
        let completed = order.filter { values[$0] != nil }
        return completed.isEmpty
            ? "阶段：探针没有输出测量事件。"
            : "已完成阶段：\(completed.joined(separator: " → "))"
    }

    private func showError(headline: String, detail: String) {
        elapsedTimer?.invalidate()
        elapsedTimer = nil
        hardTimeoutWorkItem?.cancel()
        hardTimeoutWorkItem = nil
        spinner.stopAnimation(nil)
        headlineLabel.stringValue = headline
        headlineLabel.textColor = .systemRed
        outputView.string = detail
        captureButton.isEnabled = activeProcess == nil
        cancelButton.isEnabled = activeProcess != nil
    }
}

private let application = NSApplication.shared
application.setActivationPolicy(.accessory)
if CommandLine.arguments.contains("--capture-once") {
    runCaptureOnce()
}
private let delegate = CaptureLabAppDelegate()
application.delegate = delegate
application.run()

private func runCaptureOnce() -> Never {
    guard let wechat = NSRunningApplication
        .runningApplications(withBundleIdentifier: wechatBundleIdentifier)
        .first(where: { !$0.isTerminated }) else {
        emitDiagnostic(["ok": false, "error": "wechat_not_running"])
        exit(0)
    }

    _ = wechat.activate(options: [.activateAllWindows])
    let activationDeadline = Date().addingTimeInterval(0.5)
    while NSWorkspace.shared.frontmostApplication?.bundleIdentifier != wechatBundleIdentifier,
          Date() < activationDeadline {
        RunLoop.current.run(until: Date().addingTimeInterval(0.02))
    }
    guard NSWorkspace.shared.frontmostApplication?.bundleIdentifier
            == wechatBundleIdentifier else {
        emitDiagnostic(["ok": false, "error": "wechat_not_front"])
        exit(0)
    }

    let probePath = ProcessInfo.processInfo.environment["NOTALONE_SYNC_PROBE"]
        ?? defaultProbePath
    guard FileManager.default.isExecutableFile(atPath: probePath) else {
        emitDiagnostic(["ok": false, "error": "probe_missing"])
        exit(0)
    }

    let process = Process()
    process.executableURL = URL(fileURLWithPath: probePath)
    process.arguments = ["--session", "--json", "--single-frame"]
    process.currentDirectoryURL = URL(fileURLWithPath: projectDirectory)
    var environment = ProcessInfo.processInfo.environment
    environment["NOTALONE_OBSERVATION_MEASUREMENTS"] = "1"
    process.environment = environment

    let stdout = Pipe()
    let stderr = Pipe()
    process.standardOutput = stdout
    process.standardError = stderr
    let started = ProcessInfo.processInfo.systemUptime
    let timeout = DispatchWorkItem {
        if process.isRunning {
            Darwin.kill(process.processIdentifier, SIGKILL)
        }
    }
    DispatchQueue.global(qos: .userInitiated).asyncAfter(
        deadline: .now() + captureTimeout,
        execute: timeout
    )

    do {
        try process.run()
        process.waitUntilExit()
    } catch {
        timeout.cancel()
        emitDiagnostic(["ok": false, "error": "probe_launch_failed"])
        exit(0)
    }
    timeout.cancel()

    let stdoutData = stdout.fileHandleForReading.readDataToEndOfFile()
    let stderrData = stderr.fileHandleForReading.readDataToEndOfFile()
    let elapsed = (ProcessInfo.processInfo.systemUptime - started) * 1_000
    let events = diagnosticEvents(stderrData)
    let times = Dictionary(uniqueKeysWithValues: events.map {
        ($0.event, $0.timestamp)
    })

    var diagnostic: [String: Any] = [
        "ok": true,
        "process_elapsed_ms": elapsed,
        "termination_reason": process.terminationReason == .uncaughtSignal
            ? "uncaught_signal"
            : "exit",
        "termination_status": process.terminationStatus,
        "completed_stages": events.map(\.event),
    ]
    if let capture = diagnosticDuration(
        times["captureRequested"],
        times["frameReceived"]
    ) {
        diagnostic["capture_ms"] = capture
    }
    if let ocr = diagnosticDuration(
        times["headerOcrStarted"],
        times["headerOcrCompleted"]
    ) {
        diagnostic["ocr_ms"] = ocr
    }
    if let total = diagnosticDuration(times["started"], times["finished"]) {
        diagnostic["probe_total_ms"] = total
    }
    if let result = diagnosticResult(stdoutData) {
        diagnostic["result"] = result
    } else {
        diagnostic["result"] = NSNull()
    }
    emitDiagnostic(diagnostic)
    exit(0)
}

private func diagnosticEvents(_ data: Data) -> [(event: String, timestamp: Double)] {
    guard let text = String(data: data, encoding: .utf8) else { return [] }
    return text.split(whereSeparator: \.isNewline).compactMap { line in
        let parts = line.split(separator: " ", omittingEmptySubsequences: true)
        guard parts.count == 3,
              parts[0] == "notalone-observation-v1",
              let timestamp = Double(parts[2]) else { return nil }
        return (String(parts[1]), timestamp)
    }
}

private func diagnosticDuration(_ start: Double?, _ end: Double?) -> Double? {
    guard let start, let end, end >= start else { return nil }
    return (end - start) * 1_000
}

private func diagnosticResult(_ data: Data) -> [String: Any]? {
    guard let text = String(data: data, encoding: .utf8) else { return nil }
    for line in text.split(whereSeparator: \.isNewline).reversed() {
        guard let lineData = String(line).data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: lineData),
              let result = object as? [String: Any] else { continue }
        let quality = result["quality"] as? [String: Any] ?? [:]
        return [
            "ok": result["ok"] ?? NSNull(),
            "wechat_in_front": result["wechat_in_front"] ?? NSNull(),
            "stage": result["stage"] ?? NSNull(),
            "error": result["error"] ?? NSNull(),
            "capture_version": result["capture_version"] ?? NSNull(),
            "display_name_confidence": quality["display_name_confidence"] ?? NSNull(),
            "name_complete": quality["name_complete"] ?? NSNull(),
        ]
    }
    return nil
}

private func emitDiagnostic(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(
        withJSONObject: object,
        options: [.sortedKeys]
    ), let line = String(data: data, encoding: .utf8) else { return }
    print(line)
}
