import Foundation

// 人工验证的动作目录是 App 与菜单栏共用的稳定接缝；快捷键只触发
// 本地验证 API，不执行切换窗口、点击微信或发送消息。
public enum FollowSmokeControlAction: String, CaseIterable, Hashable, Sendable {
    case start
    case stop
    case interrupt
    case baseline
    case beforeFollow = "before_follow"
    case afterLiveMessage = "after_live_message"
    case afterIdle = "after_idle"
    case afterFollowRestart = "after_follow_restart"
    case wechatBackground = "wechat_background"
    case afterReenable = "after_reenable"
    case finalResult = "final"

    public var title: String {
        switch self {
        case .start:
            return "开始 Follow 验证"
        case .stop:
            return "结束验证并恢复轮询"
        case .interrupt:
            return "中断 Follow 流"
        case .baseline:
            return "记录基线"
        case .beforeFollow:
            return "记录前台准备"
        case .afterLiveMessage:
            return "记录实时到达"
        case .afterIdle:
            return "记录空闲去重"
        case .afterFollowRestart:
            return "记录异常恢复"
        case .wechatBackground:
            return "记录微信后台"
        case .afterReenable:
            return "记录重新开启后"
        case .finalResult:
            return "记录最终结果"
        }
    }

    public var checkpointLabel: String? {
        switch self {
        case .start, .stop, .interrupt:
            return nil
        default:
            return rawValue
        }
    }
}

public struct FollowSmokeShortcut: Hashable, Identifiable, Sendable {
    public let action: FollowSmokeControlAction
    public let displayName: String

    public var id: String { action.rawValue }

    public init(action: FollowSmokeControlAction, displayName: String) {
        self.action = action
        self.displayName = displayName
    }
}

public enum FollowSmokeShortcutCatalog {
    public static let entries: [FollowSmokeShortcut] = [
        FollowSmokeShortcut(action: .start, displayName: "⌃⌥⇧S"),
        FollowSmokeShortcut(action: .stop, displayName: "⌃⌥⇧E"),
        FollowSmokeShortcut(action: .interrupt, displayName: "⌃⌥⇧I"),
        FollowSmokeShortcut(action: .baseline, displayName: "⌃⌥⇧1"),
        FollowSmokeShortcut(action: .beforeFollow, displayName: "⌃⌥⇧2"),
        FollowSmokeShortcut(action: .afterLiveMessage, displayName: "⌃⌥⇧3"),
        FollowSmokeShortcut(action: .afterIdle, displayName: "⌃⌥⇧4"),
        FollowSmokeShortcut(action: .afterFollowRestart, displayName: "⌃⌥⇧5"),
        FollowSmokeShortcut(action: .wechatBackground, displayName: "⌃⌥⇧6"),
        FollowSmokeShortcut(action: .afterReenable, displayName: "⌃⌥⇧7"),
        FollowSmokeShortcut(action: .finalResult, displayName: "⌃⌥⇧8"),
    ]

    public static var checkpointEntries: [FollowSmokeShortcut] {
        entries.filter { $0.action.checkpointLabel != nil }
    }

    public static func shortcut(
        for action: FollowSmokeControlAction
    ) -> String? {
        entries.first(where: { $0.action == action })?.displayName
    }
}
