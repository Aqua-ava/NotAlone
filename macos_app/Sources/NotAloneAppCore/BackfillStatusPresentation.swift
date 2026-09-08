import Foundation

/// 后台补齐状态的纯展示规则；不包含联系人正文，也不改变后端任务状态。
public enum BackfillStatusPresentation {
    public static func phaseLabel(_ raw: String?) -> String {
        switch raw {
        case "not_required": return "暂无补齐任务"
        case "gap_detected": return "发现缺口"
        case "backfilling": return "后台补齐中"
        case "complete": return "已完成"
        case "failed": return "失败（未完成）"
        case "incomplete": return "无法确认完整性"
        case "paused": return "已暂停（未完成）"
        default: return raw ?? "未知"
        }
    }

    public static func isSuccessful(_ raw: String?) -> Bool {
        raw == "complete"
    }

    public static func shouldOfferPause(_ raw: String?) -> Bool {
        raw == "gap_detected" || raw == "backfilling"
    }

    public static func shouldOfferRetry(_ raw: String?) -> Bool {
        raw == "paused" || raw == "failed" || raw == "incomplete"
    }

    public static func progress(completed: Int?, total: Int?) -> Double? {
        guard let total, total > 0 else { return nil }
        let completed = min(max(completed ?? 0, 0), total)
        return Double(completed) / Double(total)
    }
}
