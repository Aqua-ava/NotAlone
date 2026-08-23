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
    // macOS 顶部菜单栏中的 "NotAlone: ..." 状态文字。
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
    // 只有成功 OCR 后才允许用户打开这个菜单项。
    private var showOcrMenuItem: NSMenuItem?
    // 只有动态定位成功后才允许用户查看本次裁剪的红框预览。
    private var showCropPreviewMenuItem: NSMenuItem?
    // 权限未获得时提供明确的用户触发入口，而不是在启动时自动弹窗。
    private var requestPermissionMenuItem: NSMenuItem?
    private var recheckPermissionMenuItem: NSMenuItem?
    // 查看窗口和其中的文本控件都复用，避免每次点击都新建一个窗口。
    private var ocrWindow: NSWindow?
    private var ocrTextView: NSTextView?
    // 预览图仅保留最近一次捕获的内存副本，下一次成功捕获时会替换。
    private var latestPreviewImage: CGImage?
    private var cropPreviewWindow: NSWindow?
    private var cropPreviewImageView: NSImageView?

    func applicationDidFinishLaunching(_ notification: Notification) {
        setupStatusItem()
        startMonitoringIfAuthorized()
    }

    @discardableResult
    private func startMonitoringIfAuthorized() -> Bool {
        // 只检查权限。未获授权时等待用户点击菜单中的请求或重新检测命令。
        guard CGPreflightScreenCaptureAccess() else {
            updatePermissionMenu(isAuthorized: false)
            statusItem.button?.title = "NotAlone: 需要屏幕录制权限"
            return false
        }

        updatePermissionMenu(isAuthorized: true)
        // 已经在观察时不重复创建定时器。
        guard timer == nil else {
            return true
        }
        // 菜单栏 App 通过当前微信窗口动态定位分隔线，不使用固定横向比例。
        probe = WeChatCaptureProbe()
        statusItem.button?.title = "NotAlone: 等待微信前台"
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

    func applicationWillTerminate(_ notification: Notification) {
        // 退出菜单栏 App 后立刻停止后续检查。
        timer?.invalidate()
    }

    private func setupStatusItem() {
        // 菜单只提供权限操作、人工查看 OCR 和退出，不提供任何微信控制操作。
        let menu = NSMenu()
        let descriptionItem = NSMenuItem(
            title: "仅验证前台微信窗口的本地 OCR，不保存文本或截图。",
            action: nil,
            keyEquivalent: ""
        )
        descriptionItem.isEnabled = false
        menu.addItem(descriptionItem)
        let requestPermissionItem = menu.addItem(
            withTitle: "请求屏幕录制权限",
            action: #selector(requestScreenCapturePermission),
            keyEquivalent: ""
        )
        requestPermissionItem.target = self
        requestPermissionMenuItem = requestPermissionItem
        let recheckPermissionItem = menu.addItem(
            withTitle: "重新检测权限",
            action: #selector(recheckScreenCapturePermission),
            keyEquivalent: ""
        )
        recheckPermissionItem.target = self
        recheckPermissionMenuItem = recheckPermissionItem
        menu.addItem(.separator())
        let showItem = menu.addItem(
            withTitle: "查看本次 OCR 文本",
            action: #selector(showLatestOcr),
            keyEquivalent: ""
        )
        showItem.target = self
        showItem.isEnabled = false
        showOcrMenuItem = showItem
        let showCropPreviewItem = menu.addItem(
            withTitle: "查看本次裁剪范围",
            action: #selector(showLatestCropPreview),
            keyEquivalent: ""
        )
        showCropPreviewItem.target = self
        showCropPreviewItem.isEnabled = false
        showCropPreviewMenuItem = showCropPreviewItem
        menu.addItem(.separator())
        menu.addItem(withTitle: "退出验证", action: #selector(quit), keyEquivalent: "q")
        statusItem.menu = menu
    }

    private func updatePermissionMenu(isAuthorized: Bool) {
        requestPermissionMenuItem?.isEnabled = !isAuthorized
        recheckPermissionMenuItem?.isEnabled = !isAuthorized
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
                    statusItem.button?.title = "NotAlone: 微信画面未变化"
                    return
                }

                // 裁剪预览是边界定位的调试材料；即使 OCR 暂时失败，也允许用户检查红框。
                latestPreviewImage = capture.previewImage
                showCropPreviewMenuItem?.isEnabled = capture.previewImage != nil

                // 目前是技术验证：统计 OCR 文本片段，不等同于最终的聊天消息数量。
                let lines = try LocalOcr.recognize(capture.chatImage)
                // 保存全部识别结果，供用户主动打开窗口逐项检查是否有错字或漏字。
                latestLines = lines
                showOcrMenuItem?.isEnabled = true
                // 只有 OCR 成功才记住画面哈希；失败时下一个周期会重试，而不会永久跳过静止画面。
                previousHash = imageHash
                let newLines = deduplicator.newLines(from: lines)

                // 状态栏持续显示当前 display name 与同步状态；无法确定选中行时明确提示。
                var statusPrefix = "NotAlone: 未定位到当前会话"
                do {
                    let metadata = try probe.selectedSessionMetadata(from: snapshot)
                    let label = metadata.displayName ?? metadata.selectedRowName ?? "未命名会话"
                    statusPrefix = "NotAlone: \(label)"
                } catch ProbeError.selectedRowNotFound {
                    statusPrefix = "NotAlone: 无法确定选中会话行"
                }
                statusItem.button?.title = "\(statusPrefix) · 识别 \(lines.count) 行，新增 \(newLines.count) 行"
            } catch ProbeError.weChatNotFrontmost {
                // 用户切到其他 App 时不采集，也不保留那里的画面。
                statusItem.button?.title = "NotAlone: 等待微信前台"
            } catch ProbeError.chatRegionNotFound {
                // 分隔线不明确时不猜测，防止左侧会话列表被读取进来。
                statusItem.button?.title = "NotAlone: 无法确定聊天区域"
            } catch {
                // 不显示底层错误文本，防止意外把敏感上下文带到菜单栏。
                statusItem.button?.title = "NotAlone: 采集失败"
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
            size: NSSize(width: latestPreviewImage.width, height: latestPreviewImage.height)
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
        // 先创建 macOS App 对象，才能安全创建菜单栏项目和连接窗口服务器。
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
