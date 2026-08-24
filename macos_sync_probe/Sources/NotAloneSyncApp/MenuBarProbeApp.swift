// 该入口同时被 Swift Package 和 Xcode 开发工程复用。
import AppKit
import CoreGraphics
import Foundation
#if canImport(NotAloneSyncCore)
import NotAloneSyncCore
#endif

// 菜单栏应用降级为轻量状态入口：不再每 3 秒拉起 notalone-front-sync
// 子进程，改为查询常驻后端的 /api/sync/* HTTP 端点。屏幕录制权限
// 已移交给主窗口应用（探针作为其后端子进程运行）；本应用保留的
// OCR 调试窗口继续使用自己的权限。

// AppKit 的回调都在主线程运行；菜单栏、定时器等界面对象必须在这里操作。
@MainActor
private final class ProbeAppDelegate: NSObject, NSApplicationDelegate {
    // 菜单栏中的 "NotAlone: ..." 状态文字；前台同步状态优先展示。
    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    // 真正负责截取微信窗口的对象；获得权限后才创建（仅调试窗口使用）。
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

    // ── 后端状态查询 ──────────────────────────────────────────────────
    // 后端由主窗口应用拉起并写入握手文件；每次轮询重新读取，
    // 以便后端重启后（新 token）能自动恢复连接。
    private var backendClient: BackendStatusClient?
    // 上一次查询到的同步报告；标题与菜单从这里构建，不含消息正文。
    private var syncReport: SyncStatusJSON?
    // 后端是否可连接；不可用时菜单栏只显示提示。
    private var backendUnavailable = false
    // 后端在运行但同步未就绪（503）；与"后端不可用"区分提示。
    private var syncUnavailable = false
    // 每 3 秒查询一次后端状态。
    private var syncTimer: Timer?
    // 最近一次用户操作（开关/检查）的结果摘要；响应不含正文。
    private var lastOperationMessage: String?

    func applicationDidFinishLaunching(_ notification: Notification) {
        refreshBackendClient()
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

    // ── 后端连接：握手文件读取与客户端构建 ──────────────────────────────

    private func refreshBackendClient() {
        guard let connection = BackendStatusClient.readConnection() else {
            backendClient = nil
            return
        }
        backendClient = BackendStatusClient(connection: connection)
    }

    // 每 3 秒查询后端；失败时后端不可用标记在标题中给出清晰提示。
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
        refreshBackendClient()
        guard let backendClient else {
            backendUnavailable = true
            syncUnavailable = false
            syncReport = nil
            updateSyncTitle()
            rebuildMenu()
            return
        }
        do {
            syncReport = try await backendClient.status()
            backendUnavailable = false
            syncUnavailable = false
        } catch let error as BackendStatusError where error == .syncUnavailable {
            // 后端在运行，但同步尚未就绪（例如尚未初始化微信渠道身份）。
            backendUnavailable = false
            syncUnavailable = true
            syncReport = nil
        } catch {
            // 连接或响应失败视为后端不可用；下一轮自动重试。
            backendUnavailable = true
            syncUnavailable = false
            syncReport = nil
        }
        updateSyncTitle()
        rebuildMenu()
    }

    private func updateSyncTitle() {
        statusItem.button?.title = syncMenuTitle()
    }

    private func syncMenuTitle() -> String {
        if backendUnavailable {
            return "NotAlone: 后端不可用（请打开主窗口应用）"
        }
        if syncUnavailable {
            return "NotAlone: 同步未就绪（请先完成一次正式导入）"
        }
        guard let report = syncReport else {
            return "NotAlone: 同步状态读取中"
        }
        if !report.syncEnabled {
            return "NotAlone: 同步已关闭"
        }
        switch report.phase {
        case "active":
            let name = report.activeBindingDisplayName ?? "未知联系人"
            return report.batchMessageCount > 0
                ? "NotAlone: 同步·\(name)·本轮+\(report.batchMessageCount)"
                : "NotAlone: 同步·\(name)"
        case "waiting_foreground":
            return "NotAlone: 等待微信前台"
        case "failed":
            return "NotAlone: 同步失败·\(report.failureCode ?? "unknown")"
        case "unavailable":
            if !report.candidates.isEmpty {
                return "NotAlone: 待确认绑定(\(report.candidates.count) 候选)"
            }
            return "NotAlone: 会话不可定位·\(unavailableReasonLabel(report.decisionReason))"
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
        let syncActionAvailable = !backendUnavailable && !syncUnavailable
        let toggleItem = menu.addItem(
            withTitle: syncEnabled ? "关闭前台同步" : "开启前台同步",
            action: #selector(toggleSync),
            keyEquivalent: ""
        )
        toggleItem.target = self
        toggleItem.isEnabled = syncActionAvailable
        let checkItem = menu.addItem(
            withTitle: "立即检查一次",
            action: #selector(performCheck),
            keyEquivalent: ""
        )
        checkItem.target = self
        checkItem.isEnabled = syncActionAvailable

        // 待确认绑定：候选只会被展示；确认入口由主窗口应用提供。
        if let report = syncReport, !report.candidates.isEmpty {
            menu.addItem(.separator())
            let pendingItem = NSMenuItem(
                title: "待确认绑定：\(report.candidates.count) 个候选（请在主窗口确认）",
                action: nil,
                keyEquivalent: ""
            )
            pendingItem.isEnabled = false
            menu.addItem(pendingItem)
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

    // ── 同步开关与立即检查：全部经后端 API ──────────────────────────────

    @objc private func toggleSync() {
        guard let backendClient else {
            lastOperationMessage = "后端不可用"
            rebuildMenu()
            return
        }
        let enable = !(syncReport?.syncEnabled ?? false)
        Task {
            do {
                let updated: SyncStatusJSON = enable
                    ? try await backendClient.enable()
                    : try await backendClient.disable()
                syncReport = updated
                backendUnavailable = false
                syncUnavailable = false
                lastOperationMessage = enable ? "已开启前台同步" : "已关闭前台同步"
            } catch {
                backendUnavailable = true
                syncUnavailable = false
                syncReport = nil
                lastOperationMessage = "开关失败：后端不可用"
            }
            updateSyncTitle()
            rebuildMenu()
        }
    }

    @objc private func performCheck() {
        guard let backendClient else {
            lastOperationMessage = "后端不可用"
            rebuildMenu()
            return
        }
        Task {
            do {
                syncReport = try await backendClient.check()
                backendUnavailable = false
                syncUnavailable = false
                lastOperationMessage = "已检查一次"
            } catch {
                backendUnavailable = true
                syncUnavailable = false
                syncReport = nil
                lastOperationMessage = "检查失败：后端不可用"
            }
            updateSyncTitle()
            rebuildMenu()
        }
    }

    // ── 屏幕录制权限（调试窗口仍需要）───────────────────────────────────

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

// ── 后端状态客户端（内联实现；JSON 契约由服务端契约测试钉住）──────────

// /api/sync/status 的稳定 JSON 投影；字段与后端契约一一对应。
@MainActor
private struct SyncStatusJSON: Decodable {
    let syncEnabled: Bool
    let phase: String
    let probeAvailable: Bool
    let wechatInFront: Bool
    let cliAvailable: Bool
    let failureCode: String?
    let activeContactId: String?
    let activeBindingDisplayName: String?
    let decisionReason: String?
    let batchMessageCount: Int
    let candidates: [CandidateJSON]

    struct CandidateJSON: Decodable {
        let username: String
        let displayName: String
        let lastTimestamp: Int?
    }
}

// 只访问 127.0.0.1 后端的小型客户端；错误统一按"后端不可用"处理。
@MainActor
private struct BackendStatusClient {
    private let baseURL: URL
    private let token: String

    init?(connection: BackendConnection) {
        guard let baseURL = URL(string: "http://\(connection.address)") else {
            return nil
        }
        self.baseURL = baseURL
        self.token = connection.token
    }

    // 读取后端握手文件；文件缺失或格式无效时返回 nil（失败关闭）。
    static func readConnection() -> BackendConnection? {
        let path: String
        if let override = ProcessInfo.processInfo.environment["NOTALONE_BACKEND_INFO"],
           !override.isEmpty {
            path = (override as NSString).expandingTildeInPath
        } else {
            path = (("~/.notalone/backend.info" as NSString)).expandingTildeInPath
        }
        guard let text = try? String(contentsOfFile: path, encoding: .utf8) else {
            return nil
        }
        var address: String?
        var token: String?
        for line in text.split(separator: "\n") {
            let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.hasPrefix("address=") {
                address = String(trimmed.dropFirst("address=".count))
            } else if trimmed.hasPrefix("token=") {
                token = String(trimmed.dropFirst("token=".count))
            }
        }
        guard let address, let token, !address.isEmpty, !token.isEmpty else {
            return nil
        }
        return BackendConnection(address: address, token: token)
    }

    func status() async throws -> SyncStatusJSON {
        try await request(path: "/api/sync/status", method: "GET")
    }

    func enable() async throws -> SyncStatusJSON {
        try await request(path: "/api/sync/enable", method: "POST")
    }

    func disable() async throws -> SyncStatusJSON {
        try await request(path: "/api/sync/disable", method: "POST")
    }

    func check() async throws -> SyncStatusJSON {
        try await request(path: "/api/sync/check", method: "POST")
    }

    private func request(path: String, method: String) async throws -> SyncStatusJSON {
        guard let url = URL(string: path, relativeTo: baseURL) else {
            throw BackendStatusError.invalidURL
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw BackendStatusError.badStatus
        }
        switch http.statusCode {
        case 200:
            break
        case 503:
            // 后端在运行但同步未就绪（例如尚无微信渠道身份）。
            throw BackendStatusError.syncUnavailable
        default:
            throw BackendStatusError.badStatus
        }
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        do {
            return try decoder.decode(SyncStatusJSON.self, from: data)
        } catch {
            throw BackendStatusError.malformedResponse
        }
    }
}

private enum BackendStatusError: Error {
    case invalidURL
    case syncUnavailable
    case badStatus
    case malformedResponse
}

private struct BackendConnection {
    let address: String
    let token: String
}