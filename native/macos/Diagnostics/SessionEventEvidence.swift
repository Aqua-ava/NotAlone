import Foundation

struct SessionEventNotification {
    static let categories: Set<String> = ["focus", "window", "selection", "rows", "title", "moved", "resized"]
    let category: String
    let elapsedMilliseconds: Int

    var label: String {
        switch category {
        case "focus": return "界面焦点变化"
        case "window": return "活动窗口变化"
        case "selection": return "选中对象变化"
        case "rows": return "选中行变化"
        case "title": return "标题变化"
        case "moved": return "窗口移动"
        case "resized": return "窗口缩放"
        default: return "未知通知"
        }
    }
}

// 界面通知不是会话身份；人工反馈与机器通知分开计数。
struct SessionEventEvidence {
    private(set) var notificationCount = 0
    private(set) var foregroundTransitions = 0
    private(set) var recentNotifications: [SessionEventNotification] = []
    private(set) var humanWithPrompt = 0
    private(set) var humanWithoutPrompt = 0
    private(set) var closed = false

    mutating func recordNotification(category: String, elapsedMilliseconds: Int) {
        guard !closed, SessionEventNotification.categories.contains(category), elapsedMilliseconds >= 0 else { return }
        notificationCount += 1
        recentNotifications.insert(SessionEventNotification(category: category,
            elapsedMilliseconds: elapsedMilliseconds), at: 0)
        recentNotifications = Array(recentNotifications.prefix(5))
    }

    mutating func recordForegroundTransition() {
        guard !closed else { return }
        foregroundTransitions += 1
    }

    mutating func recordHumanObservation(hadPrompt: Bool) {
        guard !closed else { return }
        if hadPrompt { humanWithPrompt += 1 } else { humanWithoutPrompt += 1 }
    }

    mutating func close() { closed = true }

    func summary() -> [String: Any] {
        ["event": "session_events_preview_closed", "received_events": notificationCount,
         "foreground_transitions": foregroundTransitions, "human_with_prompt": humanWithPrompt,
         "human_without_prompt": humanWithoutPrompt, "contact_switch_coverage_verified": false,
         "captures": 0, "ocr_calls": 0, "text_reads": 0]
    }
}
