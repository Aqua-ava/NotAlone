import Foundation

/// 回复依据卡片的展示策略（纯函数，不依赖 SwiftUI）。
///
/// ADR-035 与 `CONTEXT.md` 的「待确认候选」要求：待确认候选只带明确的未确认
/// 标注才能进入回复，不能被当作确定事实，也不能与已确认资料并列陈述。这里把
/// 判定集中成一个可测的策略，视图不再散落 `kind`／`status` 字符串比较。
///
/// fail-closed 规则：只有 `kind == pending_candidate` 且 `snapshot_status` 恰好为
/// `pending` 时，才允许把候选正文展示成「未确认参考」；缺失或未知状态一律隐藏
/// 正文，只提示原因未知，绝不按已确认材料展示。
public enum ReplyEvidencePresentationPolicy {
    /// 后端为待确认候选固定写入的状态值（`reply/generator.py` 白名单）。
    public static let pendingStatus = "pending"
    /// 依据卡片的兜底标题，保留改动前的文案。
    public static let fallbackKindLabel = "上下文材料"
    /// 未确认候选的固定标注，视觉与已确认依据区分。
    public static let unconfirmedBadge = "未确认 · 仅供参考"

    public static func pendingReference(
        for entry: ReplyEvidence,
        pendingCandidates: [MemoryCandidateEntry],
        candidatesLoaded: Bool
    ) -> ReplyEvidencePresentation {
        if entry.kind == "pending_candidate" {
            return pendingCandidatePresentation(
                for: entry,
                candidate: pendingCandidates.first { $0.candidateId == entry.evidenceId },
                candidatesLoaded: candidatesLoaded
            )
        }
        let timingLines = entry.showsMemoryTiming
            ? MemoryTimePresentation.lines(
                timing: entry.timing, validAt: entry.validAt, invalidAt: entry.invalidAt
            )
            : []
        return ReplyEvidencePresentation(
            availability: .present,
            title: entry.kindLabel + (entry.cited ? " · 候选引用" : " · 上下文材料"),
            body: entry.text,
            detailLines: timingLines + selectionReasonLine(entry.selectionReason),
            isUnconfirmed: false,
            isStruckThrough: false
        )
    }

    private static func pendingCandidatePresentation(
        for entry: ReplyEvidence,
        candidate: MemoryCandidateEntry?,
        candidatesLoaded: Bool
    ) -> ReplyEvidencePresentation {
        let status = entry.snapshotStatus?.trimmingCharacters(in: .whitespaces) ?? ""
        let title = "未确认候选「\(entry.text)」" + (entry.cited ? " · 候选引用" : " · 上下文材料")

        // 待确认列表里已经有这条候选，但它不是 pending：否决、已确认或已失效都
        // 不得继续当作参考展示（无论旧依据是否仍在内存里）。
        if let candidate, candidate.status != "pending" {
            return withheld(
                title: title,
                note: "该候选已不是待确认状态（\(candidateStatusLabel(candidate.status))），不再作为回复依据。"
            )
        }
        // 后端仍返回这条依据、而待确认列表里已经没有它：无法证明它仍待确认，
        // 不展示正文，也不用旧数据补位。
        if candidatesLoaded, candidate == nil {
            return withheld(
                title: title,
                note: "该候选已不在待确认列表中，可能已被确认、否决或失效；正文不再展示。"
            )
        }
        let isUnconfirmed = status == pendingStatus
        let detailLines = candidateDetailLines(candidate) + selectionReasonLine(entry.selectionReason)
        // fail-closed：状态缺失或未知时不能证明候选仍待确认，不展示正文，
        // 也不用未确认之外的任何措辞替代。
        guard isUnconfirmed else {
            return withheld(
                title: title,
                note: "候选状态缺失或未知（\(status.isEmpty ? "未提供" : status)），无法确认仍未确认；正文不再展示。"
            )
        }
        return ReplyEvidencePresentation(
            availability: .present,
            title: title,
            body: entry.text,
            detailLines: [unconfirmedBadge] + detailLines,
            isUnconfirmed: true,
            isStruckThrough: !isUnconfirmed
        )
    }

    private static func candidateStatusLabel(_ status: String) -> String {
        switch status {
        case "rejected": "已否决"
        case "confirmed": "已确认"
        case "invalidated": "已失效"
        default: "状态未知"
        }
    }

    private static func withheld(title: String, note: String) -> ReplyEvidencePresentation {
        ReplyEvidencePresentation(
            availability: .withheld,
            title: title,
            body: "正文已隐藏。",
            detailLines: [note],
            isUnconfirmed: true,
            isStruckThrough: true
        )
    }

    /// 候选的待确认原因：模型置信度与风险标记来自待确认候选列表，只在能证明
    /// 该候选仍待确认时展示；判定不了就不推断。
    private static func candidateDetailLines(_ candidate: MemoryCandidateEntry?) -> [String] {
        guard let candidate else { return [] }
        var lines: [String] = []
        if let confidence = candidate.confidence {
            lines.append(
                "模型置信度：\(String(format: "%.0f", confidence * 100))%（把握程度，不代表实测准确率）"
            )
        }
        if let riskFlags = candidate.riskFlags, !riskFlags.isEmpty {
            lines.append("风险标记：" + riskFlags.joined(separator: "、"))
        }
        return lines
    }

    private static func selectionReasonLine(_ reason: String) -> [String] {
        let trimmed = reason.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? [] : ["选入原因：" + trimmed]
    }
}

/// 一条回复依据在界面上如何呈现。
public struct ReplyEvidencePresentation: Equatable, Sendable {
    public enum Availability: Equatable, Sendable {
        /// 可以展示这条依据（待确认候选同时带未确认标注）。
        case present
        /// 只展示标注和原因，正文不展示。
        case withheld
    }

    public let availability: Availability
    public let title: String
    public let body: String
    public let detailLines: [String]
    /// 这条依据是未确认候选，不是已确认资料；调用方不得把它陈述成事实。
    public let isUnconfirmed: Bool
    /// 不展示的正文用删除线保留候选身份，避免被读成结论。
    public let isStruckThrough: Bool

    public var isWithheld: Bool { availability == .withheld }
}
