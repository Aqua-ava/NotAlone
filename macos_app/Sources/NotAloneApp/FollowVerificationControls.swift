import AppKit
import Carbon.HIToolbox
import NotAloneAppCore

// 验证控制面独立于主窗口：用户可以把微信保持在前台，用菜单栏或全局
// 快捷键记录检查点。这里没有窗口、鼠标、键盘输入或消息发送能力。
@MainActor
final class FollowVerificationControls: NSObject, NSMenuDelegate {
    private static let hotKeySignature: OSType = 0x4E415446 // "NATF"
    private static let hotKeyModifiers: UInt32 =
        UInt32(controlKey | optionKey | shiftKey)

    private let model: AppModel
    private let statusItem: NSStatusItem
    private let menu: NSMenu
    private var timer: Timer?
    private var eventHandler: EventHandlerRef?
    private var registeredHotKeys: [RegisteredHotKey] = []
    private(set) var failedHotKeys: [FollowSmokeControlAction] = []

    private struct RegisteredHotKey {
        let action: FollowSmokeControlAction
        let reference: EventHotKeyRef
        let id: UInt32
    }

    init(model: AppModel) {
        self.model = model
        self.statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        self.menu = NSMenu()
        super.init()
        menu.delegate = self
        statusItem.menu = menu
        statusItem.button?.toolTip = "NotAlone 前台同步人工验证"
    }

    func start() {
        guard timer == nil else { return }
        installGlobalHotKeys()
        refreshStatusItem()
        timer = Timer.scheduledTimer(
            withTimeInterval: 1.0,
            repeats: true
        ) { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.refreshStatusItem()
            }
        }
    }

    func stop() {
        timer?.invalidate()
        timer = nil
        for item in registeredHotKeys {
            UnregisterEventHotKey(item.reference)
        }
        registeredHotKeys.removeAll()
        if let eventHandler {
            RemoveEventHandler(eventHandler)
            self.eventHandler = nil
        }
        statusItem.menu = nil
        NSStatusBar.system.removeStatusItem(statusItem)
    }

    // MARK: - NSMenuDelegate

    func menuWillOpen(_ menu: NSMenu) {
        rebuildMenu()
    }

    // MARK: - 菜单栏

    private func refreshStatusItem() {
        guard let button = statusItem.button else { return }
        button.title = statusTitle
        button.image = NSImage(
            systemSymbolName: "bubble.left.and.bubble.right",
            accessibilityDescription: "NotAlone"
        )
    }

    private var statusTitle: String {
        if case .failed = model.backendState {
            return "NotAlone·错误"
        }
        guard let smoke = model.followSmoke else {
            return "NotAlone"
        }
        if smoke.active {
            return smoke.followStreamActive ? "NotAlone·Follow" : "NotAlone·等待微信"
        }
        return "NotAlone·就绪"
    }

    private func rebuildMenu() {
        menu.removeAllItems()
        menu.autoenablesItems = false

        let statusItem = NSMenuItem(
            title: "状态：\(statusTitle.replacingOccurrences(of: "NotAlone·", with: ""))",
            action: nil,
            keyEquivalent: ""
        )
        statusItem.isEnabled = false
        menu.addItem(statusItem)

        let frontItem = NSMenuItem(
            title: "当前微信前台：\(boolLabel(model.followSmoke?.wechatInFront))",
            action: nil,
            keyEquivalent: ""
        )
        frontItem.isEnabled = false
        menu.addItem(frontItem)

        let latestItem = NSMenuItem(
            title: latestObservationTitle,
            action: nil,
            keyEquivalent: ""
        )
        latestItem.isEnabled = false
        menu.addItem(latestItem)
        menu.addItem(.separator())

        for action in [FollowSmokeControlAction.start, .stop, .interrupt] {
            menu.addItem(menuItem(for: action, enabled: isEnabled(action)))
        }
        menu.addItem(.separator())

        let checkpointMenu = NSMenu(title: "记录检查点")
        for entry in FollowSmokeShortcutCatalog.checkpointEntries {
            checkpointMenu.addItem(
                menuItem(for: entry.action, enabled: isEnabled(entry.action))
            )
        }
        let checkpointItem = NSMenuItem(
            title: "记录检查点",
            action: nil,
            keyEquivalent: ""
        )
        checkpointItem.submenu = checkpointMenu
        menu.addItem(checkpointItem)

        menu.addItem(.separator())
        let hint = NSMenuItem(
            title: "快捷键：⌃⌥⇧ + S/E/I 或 1–8（微信保持前台）",
            action: nil,
            keyEquivalent: ""
        )
        hint.isEnabled = false
        menu.addItem(hint)
        if !failedHotKeys.isEmpty {
            let warning = NSMenuItem(
                title: "部分快捷键注册失败，请改用菜单栏或主窗口",
                action: nil,
                keyEquivalent: ""
            )
            warning.isEnabled = false
            menu.addItem(warning)
        }

        menu.addItem(.separator())
        let openItem = NSMenuItem(
            title: "打开 NotAlone 主窗口",
            action: #selector(openMainWindow),
            keyEquivalent: ""
        )
        openItem.target = self
        menu.addItem(openItem)
    }

    private func menuItem(
        for action: FollowSmokeControlAction,
        enabled: Bool
    ) -> NSMenuItem {
        let shortcut = FollowSmokeShortcutCatalog.shortcut(for: action)
        let title = shortcut.map { "\(action.title)    \($0)" } ?? action.title
        let item = NSMenuItem(
            title: title,
            action: #selector(handleMenuAction(_:)),
            keyEquivalent: ""
        )
        item.target = self
        item.representedObject = action.rawValue
        item.isEnabled = enabled
        return item
    }

    private func isEnabled(_ action: FollowSmokeControlAction) -> Bool {
        guard model.backendState == .running,
              let smoke = model.followSmoke,
              !model.followSmokeInFlight else { return false }
        switch action {
        case .start:
            return !smoke.active && smoke.syncEnabled == true
        case .stop:
            return smoke.active
        case .interrupt:
            return smoke.active && smoke.followStreamActive
        case .baseline, .beforeFollow, .afterLiveMessage, .afterIdle,
             .afterFollowRestart, .wechatBackground, .afterReenable,
             .finalResult:
            return smoke.active
        }
    }

    @objc private func handleMenuAction(_ sender: NSMenuItem) {
        guard let rawValue = sender.representedObject as? String,
              let action = FollowSmokeControlAction(rawValue: rawValue) else {
            return
        }
        model.performFollowSmokeAction(action)
    }

    @objc private func openMainWindow() {
        NSApp.activate(ignoringOtherApps: true)
        NSApp.windows.first(where: { $0.canBecomeKey })?.makeKeyAndOrderFront(nil)
    }

    private var latestObservationTitle: String {
        guard let observation = model.followSmoke?.lastValidObservation else {
            return "最近有效观察：暂无（等待微信前台）"
        }
        let watermark = observation.watermark.map(String.init) ?? "无"
        return "最近有效观察：\(observation.observedAt) · 水位 \(watermark)"
    }

    private func boolLabel(_ value: Bool?) -> String {
        guard let value else { return "未知" }
        return value ? "是" : "否"
    }

    // MARK: - 全局快捷键

    private func installGlobalHotKeys() {
        var eventSpec = EventTypeSpec(
            eventClass: OSType(kEventClassKeyboard),
            eventKind: UInt32(kEventHotKeyPressed)
        )
        let installStatus = InstallEventHandler(
            GetApplicationEventTarget(),
            Self.hotKeyEventHandler,
            1,
            &eventSpec,
            Unmanaged.passUnretained(self).toOpaque(),
            &eventHandler
        )
        guard installStatus == noErr else {
            failedHotKeys = FollowSmokeShortcutCatalog.entries.map(\.action)
            return
        }

        for (offset, entry) in FollowSmokeShortcutCatalog.entries.enumerated() {
            guard let keyCode = keyCode(for: entry.action) else {
                failedHotKeys.append(entry.action)
                continue
            }
            var hotKeyID = EventHotKeyID()
            hotKeyID.signature = Self.hotKeySignature
            hotKeyID.id = UInt32(offset + 1)
            var reference: EventHotKeyRef?
            let status = RegisterEventHotKey(
                keyCode,
                Self.hotKeyModifiers,
                hotKeyID,
                GetApplicationEventTarget(),
                0,
                &reference
            )
            guard status == noErr, let reference else {
                failedHotKeys.append(entry.action)
                continue
            }
            registeredHotKeys.append(
                RegisteredHotKey(
                    action: entry.action,
                    reference: reference,
                    id: hotKeyID.id
                )
            )
        }
    }

    private func keyCode(for action: FollowSmokeControlAction) -> UInt32? {
        switch action {
        case .start:
            return UInt32(kVK_ANSI_S)
        case .stop:
            return UInt32(kVK_ANSI_E)
        case .interrupt:
            return UInt32(kVK_ANSI_I)
        case .baseline:
            return UInt32(kVK_ANSI_1)
        case .beforeFollow:
            return UInt32(kVK_ANSI_2)
        case .afterLiveMessage:
            return UInt32(kVK_ANSI_3)
        case .afterIdle:
            return UInt32(kVK_ANSI_4)
        case .afterFollowRestart:
            return UInt32(kVK_ANSI_5)
        case .wechatBackground:
            return UInt32(kVK_ANSI_6)
        case .afterReenable:
            return UInt32(kVK_ANSI_7)
        case .finalResult:
            return UInt32(kVK_ANSI_8)
        }
    }

    private func performHotKey(id: UInt32) {
        guard let item = registeredHotKeys.first(where: { $0.id == id }) else {
            return
        }
        model.performFollowSmokeAction(item.action)
    }

    private static let hotKeyEventHandler: EventHandlerProcPtr = {
        _, event, userData in
        guard let event, let userData else { return noErr }
        var hotKeyID = EventHotKeyID()
        let status = GetEventParameter(
            event,
            EventParamName(kEventParamDirectObject),
            EventParamType(typeEventHotKeyID),
            nil,
            MemoryLayout<EventHotKeyID>.size,
            nil,
            &hotKeyID
        )
        guard status == noErr else { return status }
        let controls = Unmanaged<FollowVerificationControls>
            .fromOpaque(userData)
            .takeUnretainedValue()
        Task { @MainActor in
            controls.performHotKey(id: hotKeyID.id)
        }
        return noErr
    }
}
