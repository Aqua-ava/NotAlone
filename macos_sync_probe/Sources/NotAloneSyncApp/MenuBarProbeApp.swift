// 该入口同时被 Swift Package 和 Xcode 开发工程复用。
import AppKit
import CoreGraphics
import Foundation
#if canImport(NotAloneSyncCore)
import NotAloneSyncCore
#endif

// AppKit 的回调都在主线程运行；菜单栏、定时器等界面对象必须在这里操作。
@MainActor
private final class ProbeAppDelegate: NSObject, NSApplicationDelegate {
    // 菜单栏中的 "NotAlone: ..." 状态文字；前台同步状态优先展示。
    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    // 真正负责截取微信窗口的对象；获得权限后才创建。
    private var probe: WeChatCaptureProbe?
    // 每秒检查一次当前前台窗口，不主动操作或切换微信。
    private var timer: Timer?
    // 截图尚未返回时不发起下一次截图，避免多个截屏任务并发堆积。
    private var isCapturing = false
    // 记录上一帧的哈希。聊天画面没有变化时，直接跳过较慢的 OCR。
    private var previousHash: String?
    // 仅在本次 App 运行期间保存已见文本，用于报告新增内容；不会写入磁盘。
    private var deduplicator = LineDeduplicator()
    // 最近一次 OCR 的全部文本片段。它用于人工核对准确率，不代表正式聊天记录。
    private var latestLines: [RecognizedLine] = []
    // 预览图仅保留最近一次捕获的内存副本，下一次成功捕获时会替换。
    private var latestPreviewImage: CGImage?
    private var ocrWindow: NSWindow?
    private var ocrTextView: NSTextView?
    private var cropPreviewWindow: NSWindow?
    private var cropPreviewImageView: NSImageView?
    // 最近一次 OCR 的计数摘要；只展示数量，不展示文本。
    private var lastOcrSummary = "尚未执行 OCR"

    // ── 前台同步驱动 ──────────────────────────────────────────────────
    // 仓库根目录与 notalone-front-sync 命令路径；任一缺失时同步功能不可用。
    private var repoRoot: URL?
    private var frontSyncPath: String?
    // 上一次 status 循环的报告；标题与菜单从这里构建，不含消息正文。
    private var syncReport: FrontSyncStatusReport?
    private var contacts: [FrontSyncContactEntry] = []
    private var isRunningSync = false
    private var syncTimer: Timer?
    // 最近一次用户操作（开关/确认）的结果摘要；命令输出不含正文。
    private var lastOperationMessage: String?

    func applicationDidFinishLaunching(_ notification: Notification) {
        resolveFrontSyncPaths()
        rebuildMenu()
        updateSyncTitle()
        startMonitoringIfAuthorized()
        startSyncTimer()
    }

    func applicationWillTerminate(_ notification: Notification) {
        // 退出菜单栏 App 后立刻停止后续检查。
        timer?.invalidate()
        syncTimer?.invalidate()
    }

    // ── 前台同步：路径解析与命令执行 ────────────────────────────────────

    private func resolveFrontSyncPaths() {
        // App 包位于 <仓库>/macos_sync_probe/build/；向上三级得到仓库根。
        let candidateRoot = Bundle.main.bundleURL
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        if FileManager.default.fileExists(
            atPath: candidateRoot.appendingPathComponent("pyproject.toml").path
        ) {
            repoRoot = candidateRoot
        }
        if let override = ProcessInfo.processInfo.environment["NOTALONE_FRONT_SYNC"],
           !override.isEmpty {
            frontSyncPath = override
            return
        }
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let bases = [
            "\(home)/miniconda3",
            "\(home)/anaconda3",
            "/opt/miniconda3",
            "/opt/anaconda3",
        ]
        for base in bases {
            let path = "\(base)/envs/NotAlone/bin/notalone-front-sync"
            if FileManager.default.isExecutableFile(atPath: path) {
                frontSyncPath = path
                return
            }
        }
    }

    // 调用 notalone-front-sync；探针作为子进程运行，屏幕权限归于本 App。
    private func runFrontSync(arguments: [String]) async -> (
        exitCode: Int32, output: String, errorText: String
    ) {
        guard let frontSyncPath, let repoRoot else {
            return (exitCode: -1, output: "", errorText: "同步接线不可用")
        }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: frontSyncPath)
        process.arguments = arguments
        process.currentDirectoryURL = repoRoot
        var environment = ProcessInfo.processInfo.environment
        environment["NOTALONE_SYNC_PROBE"] = repoRoot
            .appendingPathComponent("macos_sync_probe/build/cli/notalone-sync-probe")
            .path
        process.environment = environment
        let stdout = Pipe()
        let stderr = Pipe()
        process.standardOutput = stdout
        process.standardError = stderr
        do {
            try process.run()
        } catch {
            return (exitCode: -1, output: "", errorText: "命令启动失败")
        }
        return await withCheckedContinuation { continuation in
            process.terminationHandler = { finished in
                let outData = stdout.fileHandleForReading.readDataToEndOfFile()
                let errData = stderr.fileHandleForReading.readDataToEndOfFile()
                let outText = String(data: outData, encoding: .utf8) ?? ""
                let errText = String(data: errData, encoding: .utf8) ?? ""
                Task { @MainActor in
                    continuation.resume(
                        returning: (finished.terminationStatus, outText, errText)
                    )
                }
            }
        }
    }

    // ── 前台同步：循环与状态展示 ────────────────────────────────────────

    private func startSyncTimer() {
        guard syncTimer == nil else {
            return
        }
        syncTimer = Timer.scheduledTimer(
            timeInterval: 3,
            target: self,
            selector: #selector(syncTimerFired),
            userInfo: nil,
            repeats: true
        )
        syncTimer?.tolerance = 0.5
        Task { await performSyncCycle() }
    }

    @objc private func syncTimerFired() {
        Task { await performSyncCycle() }
    }

    private func performSyncCycle() async {
        guard !isRunningSync else {
            return
        }
        isRunningSync = true
        defer { isRunningSync = false }
        let result = await runFrontSync(arguments: ["status"])
        let report = result.exitCode == 0
            ? FrontSyncStatusReport.parse(statusOutput: result.output)
            : nil
        syncReport = report
        // 有待选候选时才读取联系人列表，供一次性绑定确认菜单使用。
        if let report, !report.candidates.isEmpty, contacts.isEmpty {
            let contactResult = await runFrontSync(arguments: ["contacts"])
            contacts = FrontSyncContactEntry.parseList(contactResult.output)
        }
        updateSyncTitle()
        rebuildMenu()
    }

    private func updateSyncTitle() {
        statusItem.button?.title = syncMenuTitle()
    }

    private func syncMenuTitle() -> String {
        guard CGPreflightScreenCaptureAccess() else {
            return "NotAlone: 需要屏幕录制权限"
        }
        guard let report = syncReport else {
            if frontSyncPath == nil || repoRoot == nil {
                return "NotAlone: 同步接线不可用"
            }
            return "NotAlone: 同步状态读取中"
        }
        if !report.syncEnabled {
            return "NotAlone: 同步已关闭"
        }
        switch report.phase {
        case "active":
            let name = report.bindingDisplay ?? "未知联系人"
            return report.batchMessages > 0
                ? "NotAlone: 同步·\(name)·本轮+\(report.batchMessages)"
                : "NotAlone: 同步·\(name)"
        case "waiting_foreground":
            return "NotAlone: 等待微信前台"
        case "failed":
            return "NotAlone: 同步失败·\(report.failureCode ?? "unknown")"
        case "unavailable":
            if !report.candidates.isEmpty {
                return "NotAlone: 待确认绑定(\(report.candidates.count) 候选)"
            }
            return "NotAlone: 会话不可定位·\(unavailableReasonLabel(report.decision))"
        default:
            return "NotAlone: 同步·\(report.phase)"
        }
    }

    private func unavailableReasonLabel(_ decision: String?) -> String {
        switch decision {
        case "observation_unreadable":
            return "标题不可读"
        case "no_candidate":
            return "无候选"
        case "metadata_mismatch":
            return "证据矛盾"
        case .some(let reason):
            return reason
        case nil:
            return "unknown"
        }
    }

    // ── 菜单 ───────────────────────────────────────────────────────────

    // 每轮同步后重建菜单；内容只有状态、计数、展示名称与候选标识。
    private func rebuildMenu() {
        let menu = NSMenu()
        let descriptionItem = NSMenuItem(
            title: "仅验证前台微信会话；不保存文本或截图，不上传任何内容。",
            action: nil,
            keyEquivalent: ""
        )
        descriptionItem.isEnabled = false
        menu.addItem(descriptionItem)
        let ocrItem = NSMenuItem(title: "最近 OCR：\(lastOcrSummary)", action: nil, keyEquivalent: "")
        ocrItem.isEnabled = false
        menu.addItem(ocrItem)
        if let lastOperationMessage {
            let operationItem = NSMenuItem(
                title: "最近操作：\(lastOperationMessage)", action: nil, keyEquivalent: ""
            )
            operationItem.isEnabled = false
            menu.addItem(operationItem)
        }
        menu.addItem(.separator())

        let syncEnabled = syncReport?.syncEnabled ?? false
        let toggleItem = menu.addItem(
            withTitle: syncEnabled ? "关闭前台同步" : "开启前台同步",
            action: #selector(toggleSync),
            keyEquivalent: ""
        )
        toggleItem.target = self
        toggleItem.isEnabled = frontSyncPath != nil && repoRoot != nil
        let checkItem = menu.addItem(
            withTitle: "立即检查一次",
            action: #selector(syncTimerFired),
            keyEquivalent: ""
        )
        checkItem.target = self
        checkItem.isEnabled = frontSyncPath != nil && repoRoot != nil

        // 待确认绑定：候选 -> 联系人两级选择；点击即完成一次性确认。
        if let report = syncReport, !report.candidates.isEmpty {
            menu.addItem(.separator())
            for candidate in report.candidates {
                let candidateMenu = NSMenu()
                if contacts.isEmpty {
                    let emptyItem = NSMenuItem(title: "联系人列表读取中…", action: nil, keyEquivalent: "")
                    emptyItem.isEnabled = false
                    candidateMenu.addItem(emptyItem)
                }
                for contact in contacts {
                    let item = NSMenuItem(
                        title: "绑定到「\(contact.displayName)」",
                        action: #selector(confirmBinding(_:)),
                        keyEquivalent: ""
                    )
                    item.target = self
                    item.representedObject = [
                        "username": candidate.username,
                        "contact_id": contact.contactId,
                    ]
                    candidateMenu.addItem(item)
                }
                let candidateItem = NSMenuItem(
                    title: "确认绑定：\(candidate.displayName)",
                    action: nil,
                    keyEquivalent: ""
                )
                candidateItem.submenu = candidateMenu
                menu.addItem(candidateItem)
            }
        }

        menu.addItem(.separator())
        if !CGPreflightScreenCaptureAccess() {
            let requestItem = menu.addItem(
                withTitle: "请求屏幕录制权限",
                action: #selector(requestScreenCapturePermission),
                keyEquivalent: ""
            )
            requestItem.target = self
            let recheckItem = menu.addItem(
                withTitle: "重新检测权限",
                action: #selector(recheckScreenCapturePermission),
                keyEquivalent: ""
            )
            recheckItem.target = self
            menu.addItem(.separator())
        }
        let showItem = menu.addItem(
            withTitle: "查看本次 OCR 文本",
            action: #selector(showLatestOcr),
            keyEquivalent: ""
        )
        showItem.target = self
        showItem.isEnabled = !latestLines.isEmpty
        let showCropPreviewItem = menu.addItem(
            withTitle: "查看本次裁剪范围",
            action: #selector(showLatestCropPreview),
            keyEquivalent: ""
        )
        showCropPreviewItem.target = self
        showCropPreviewItem.isEnabled = latestPreviewImage != nil
        menu.addItem(.separator())
        menu.addItem(withTitle: "退出验证", action: #selector(quit), keyEquivalent: "q")
        statusItem.menu = menu
    }

    // ── 前台同步：用户动作 ──────────────────────────────────────────────

    @objc private func toggleSync() {
        let enable = !(syncReport?.syncEnabled ?? false)
        Task {
            // 用户操作期间暂停后台循环，避免两个探针互相抢占。
            isRunningSync = true
            let result = await runFrontSync(arguments: [enable ? "enable" : "disable"])
            isRunningSync = false
            lastOperationMessage = result.exitCode == 0
                ? (enable ? "已开启前台同步" : "已关闭前台同步")
                : "开关失败：\(result.errorText.trimmingCharacters(in: .whitespacesAndNewlines))"
            await performSyncCycle()
        }
    }

    @objc private func confirmBinding(_ sender: NSMenuItem) {
        guard let selection = sender.representedObject as? [String: String],
              let username = selection["username"],
              let contactId = selection["contact_id"] else {
            return
        }
        Task {
            // 确认期间暂停后台循环，避免两个探针互相抢占。
            isRunningSync = true
            let result = await runFrontSync(
                arguments: [
                    "confirm-binding",
                    "--contact-id", contactId,
                    "--locator", username,
                ]
            )
            isRunningSync = false
            if result.exitCode == 0 {
                lastOperationMessage = "绑定确认成功"
            } else {
                let reason = result.errorText.trimmingCharacters(in: .whitespacesAndNewlines)
                lastOperationMessage = reason.isEmpty ? "绑定确认失败" : reason
            }
            await performSyncCycle()
        }
    }

    // ── 屏幕录制权限 ────────────────────────────────────────────────────

    @discardableResult
    private func startMonitoringIfAuthorized() -> Bool {
        // 只检查权限。未获授权时等待用户点击菜单中的请求或重新检测命令。
        guard CGPreflightScreenCaptureAccess() else {
            updateSyncTitle()
            rebuildMenu()
            return false
        }

        // 已经在观察时不重复创建定时器。
        guard timer == nil else {
            return true
        }
        // 菜单栏 App 通过当前微信窗口动态定位分隔线，不使用固定横向比例。
        probe = WeChatCaptureProbe()
        // Timer 只负责触发检查；具体截屏和 OCR 在 checkFrontSession 中执行。
        timer = Timer.scheduledTimer(
            timeInterval: 1,
            target: self,
            selector: #selector(checkFrontSession),
            userInfo: nil,
            repeats: true
        )
        timer?.tolerance = 0.2
        return true
    }

    @objc private func requestScreenCapturePermission() {
        // 这是用户明确点击后的系统授权请求；App 启动时不会自动调用它。
        if CGRequestScreenCaptureAccess() {
            _ = startMonitoringIfAuthorized()
            return
        }
        statusItem.button?.title = "NotAlone: 请允许权限后重新检测"
    }

    @objc private func recheckScreenCapturePermission() {
        // 用户在系统设置中切换授权后，用此按钮重新读取系统状态，无需重启 App。
        _ = startMonitoringIfAuthorized()
    }

    // ── OCR 观察循环（探针原有行为）─────────────────────────────────────

    @objc private func checkFrontSession() {
        // 没有权限对应的 probe，或上一次截图还未完成时，本轮不做任何事。
        guard !isCapturing, let probe else {
            return
        }

        isCapturing = true
        Task { @MainActor in
            // 无论成功、跳过还是失败，任务结束后都允许下一轮检查。
            defer { isCapturing = false }
            do {
                // 这里内部会先确认微信确实是前台 App。
                // 聊天区与选中会话元数据必须来自同一帧窗口图像。
                let snapshot = try await probe.captureWindowSnapshot()
                let capture = try probe.chatRegionCapture(from: snapshot)
                let imageHash = try ImageHasher.hash(capture.chatImage)
                guard imageHash != previousHash else {
                    return
                }

                // 裁剪预览是边界定位的调试材料；即使 OCR 暂时失败，也允许用户检查红框。
                latestPreviewImage = capture.previewImage

                // 目前是技术验证：统计 OCR 文本片段，不等同于最终的聊天消息数量。
                let lines = try LocalOcr.recognize(capture.chatImage)
                // 保存全部识别结果，供用户主动打开窗口逐项检查是否有错字或漏字。
                latestLines = lines
                // 只有 OCR 成功才记住画面哈希；失败时下一个周期会重试，而不会永久跳过静止画面。
                previousHash = imageHash
                let newLines = deduplicator.newLines(from: lines)
                lastOcrSummary = "识别 \(lines.count) 行，新增 \(newLines.count) 行"
                rebuildMenu()
            } catch {
                // OCR 观察失败不影响前台同步状态；下一轮自动重试。
                lastOcrSummary = "本轮观察失败（自动重试）"
            }
        }
    }

    @objc private func showLatestOcr() {
        let window = makeOcrWindowIfNeeded()
        ocrTextView?.string = formattedOcrText()
        // 用户主动查看文字时才把 App 带到前台。之后微信不再前台，下一轮同步会自动暂停。
        NSApplication.shared.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    private func makeOcrWindowIfNeeded() -> NSWindow {
        if let ocrWindow {
            return ocrWindow
        }

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 640, height: 460),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "本次 OCR 文本（仅本地内存）"
        window.isReleasedWhenClosed = false

        let scrollView = NSScrollView(frame: window.contentView?.bounds ?? .zero)
        scrollView.hasVerticalScroller = true
        scrollView.autoresizingMask = [.width, .height]

        let textView = NSTextView(frame: scrollView.bounds)
        textView.isEditable = false
        textView.isSelectable = true
        textView.font = .monospacedSystemFont(ofSize: 14, weight: .regular)
        textView.textContainerInset = NSSize(width: 16, height: 16)
        textView.autoresizingMask = [.width]
        scrollView.documentView = textView
        window.contentView = scrollView

        ocrWindow = window
        ocrTextView = textView
        return window
    }

    @objc private func showLatestCropPreview() {
        guard let latestPreviewImage else {
            return
        }
        let window = makeCropPreviewWindowIfNeeded()
        cropPreviewImageView?.image = NSImage(
            cgImage: latestPreviewImage,
            size: NSSize(
                width: latestPreviewImage.width,
                height: latestPreviewImage.height
            )
        )
        // 用户主动查看预览时才使 App 前台；这会让下一轮前台微信检查暂停。
        NSApplication.shared.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    private func makeCropPreviewWindowIfNeeded() -> NSWindow {
        if let cropPreviewWindow {
            return cropPreviewWindow
        }

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 900, height: 620),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "本次裁剪范围（仅本地内存）"
        window.isReleasedWhenClosed = false

        let imageView = NSImageView(frame: window.contentView?.bounds ?? .zero)
        imageView.imageAlignment = .alignCenter
        imageView.imageScaling = .scaleProportionallyUpOrDown
        imageView.autoresizingMask = [.width, .height]
        window.contentView = imageView

        cropPreviewWindow = window
        cropPreviewImageView = imageView
        return window
    }

    private func formattedOcrText() -> String {
        guard !latestLines.isEmpty else {
            return "本次画面中没有识别到文字。"
        }

        let fragments = latestLines.enumerated().map { index, line in
            let confidence = String(format: "%.0f%%", line.confidence * 100)
            return "[\(index + 1)] \(speakerLabel(for: line.speaker)) | 置信度 \(confidence)\n\(line.text)"
        }
        return fragments.joined(separator: "\n\n")
    }

    private func speakerLabel(for speaker: Speaker) -> String {
        switch speaker {
        case .user:
            return "暂判：我方"
        case .contact:
            return "暂判：对方"
        case .unknown:
            return "暂判：未知"
        }
    }

    @objc private func quit() {
        NSApplication.shared.terminate(nil)
    }
}

@main
struct NotAloneSyncProbeApp {
    @MainActor
    static func main() {
        // 先创建 macOS App 对象，才能安全创建菜单栏项目并连接窗口服务器。
        let application = NSApplication.shared
        // accessory 表示这是菜单栏工具，不会在 Dock 中显示普通应用窗口。
        application.setActivationPolicy(.accessory)
        let delegate = ProbeAppDelegate()
        application.delegate = delegate
        // delegate 是弱引用；这里显式延长其生命周期，避免菜单栏逻辑被释放。
        withExtendedLifetime(delegate) {
            application.run()
        }
    }
}
