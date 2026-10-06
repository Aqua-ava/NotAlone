import XCTest
import NotAloneAppCore

/// 回复依据展示策略：未确认候选必须与已确认资料区分，缺失或未知状态 fail-closed。
final class ReplyEvidencePresentationPolicyTests: XCTestCase {
    private let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return decoder
    }()

    private func evidence(
        kind: String,
        text: String = "合成依据正文",
        status: String? = "active",
        selectionReason: String = "合成选入原因",
        cited: Bool = false,
        extra: [String: Any] = [:]
    ) throws -> ReplyEvidence {
        var jsonObject: [String: Any] = [
            "evidence_id": "evidence-1",
            "kind": kind,
            "text": text,
            "selection_reason": selectionReason,
            "cited": cited,
        ]
        if let status { jsonObject["snapshot_status"] = status }
        for (key, value) in extra { jsonObject[key] = value }
        return try decoder.decode(
            ReplyEvidence.self,
            from: JSONSerialization.data(withJSONObject: jsonObject)
        )
    }

    private func candidate(
        candidateId: String = "evidence-1",
        status: String = "pending",
        confidence: Double? = nil,
        riskFlags: [String]? = nil,
        alternatives: [String]? = nil,
        interpretationReason: String? = nil
    ) throws -> MemoryCandidateEntry {
        var jsonObject: [String: Any] = [
            "candidate_id": candidateId,
            "text": "合成候选正文",
            "category": "common_fact",
            "topic": "other",
            "status": status,
        ]
        if let confidence { jsonObject["confidence"] = confidence }
        if let riskFlags { jsonObject["risk_flags"] = riskFlags }
        if let alternatives { jsonObject["alternatives"] = alternatives }
        if let interpretationReason { jsonObject["interpretation_reason"] = interpretationReason }
        return try decoder.decode(
            MemoryCandidateEntry.self,
            from: JSONSerialization.data(withJSONObject: jsonObject)
        )
    }

    private func presentation(
        _ entry: ReplyEvidence,
        candidates: [MemoryCandidateEntry] = [],
        loaded: Bool = true
    ) -> ReplyEvidencePresentation {
        ReplyEvidencePresentationPolicy.pendingReference(
            for: entry,
            pendingCandidates: candidates,
            candidatesLoaded: loaded
        )
    }

    private func fullTimingJSON() -> [String: Any] {
        [
            "recorded_at": "2026-10-02T02:03:04+00:00",
            "source_started_at": "2026-10-01T02:03:04+00:00",
            "source_ended_at": "2026-10-01T02:03:04+00:00",
            "source_time_complete": true,
        ]
    }

    // MARK: - 未确认候选

    func testPendingCandidateCarriesUnconfirmedMarkAndNeverReadsAsConfirmed() throws {
        let entry = try evidence(
            kind: "pending_candidate",
            text: "下周三一起去看展",
            status: "pending",
            selectionReason: "未确认候选、仅供参考、不得当作事实。",
            extra: ["timing": fullTimingJSON()]
        )
        let result = presentation(entry, candidates: [try candidate()])

        XCTAssertTrue(result.isUnconfirmed)
        XCTAssertFalse(result.isWithheld)
        XCTAssertEqual(result.body, "下周三一起去看展")
        XCTAssertTrue(result.title.contains("未确认"), result.title)
        XCTAssertEqual(result.detailLines.first, ReplyEvidencePresentationPolicy.unconfirmedBadge)
        XCTAssertTrue(
            result.detailLines.contains { $0.contains("未确认候选、仅供参考、不得当作事实。") },
            result.detailLines.description
        )
        // 未确认候选不得套用任何已确认标签，也不推断成普通上下文材料。
        for confirmedLabel in ["关系资料", "本人资料", "聊天消息"] {
            XCTAssertFalse(result.title.contains(confirmedLabel), result.title)
        }
        XCTAssertTrue(result.title.hasPrefix("未确认候选"), result.title)
        XCTAssertNotEqual(entry.kindLabel, ReplyEvidencePresentationPolicy.fallbackKindLabel)
        // 时间行只属于已确认资料，未确认候选不展示。
        XCTAssertFalse(result.detailLines.contains { $0.hasPrefix("来源聊天时间：") })
    }

    func testPendingCandidateShowsConfidenceAndRiskFlagsFromPendingList() throws {
        let entry = try evidence(kind: "pending_candidate", status: "pending")
        let result = presentation(
            entry,
            candidates: [try candidate(confidence: 0.42, riskFlags: ["敏感", "证据不足"])]
        )

        XCTAssertTrue(result.detailLines.contains { $0.contains("42%") }, result.detailLines.description)
        XCTAssertTrue(result.detailLines.contains { $0 == "风险标记：敏感、证据不足" }, result.detailLines.description)
    }

    func testPendingCandidateShowsInterpretationReasonAndAlternatives() throws {
        let entry = try evidence(kind: "pending_candidate", status: "pending")
        let result = presentation(
            entry,
            candidates: [try candidate(
                alternatives: ["也可能只是近期安排", "也可能是转述"],
                interpretationReason: "消息使用了将来时，且没有明确完成事实。"
            )]
        )

        XCTAssertTrue(
            result.detailLines.contains("判断依据：消息使用了将来时，且没有明确完成事实。"),
            result.detailLines.description
        )
        XCTAssertTrue(
            result.detailLines.contains("备选解释：也可能只是近期安排；也可能是转述"),
            result.detailLines.description
        )
    }

    func testMissingOrEmptyInterpretationDetailsAreNotShown() throws {
        let entry = try evidence(kind: "pending_candidate", status: "pending")
        let result = presentation(
            entry,
            candidates: [try candidate(alternatives: [], interpretationReason: "")]
        )

        XCTAssertFalse(result.detailLines.contains { $0.hasPrefix("判断依据：") })
        XCTAssertFalse(result.detailLines.contains { $0.hasPrefix("备选解释：") })
    }

    func testInterpretationDetailsAreBoundedBeforePresentation() throws {
        let entry = try evidence(kind: "pending_candidate", status: "pending")
        let result = presentation(
            entry,
            candidates: [try candidate(
                alternatives: [String(repeating: "甲", count: 400)],
                interpretationReason: String(repeating: "乙", count: 600)
            )]
        )

        XCTAssertTrue(result.detailLines.contains { $0.hasPrefix("判断依据：") })
        XCTAssertTrue(result.detailLines.contains { $0.hasSuffix("…") })
        XCTAssertLessThanOrEqual(result.detailLines.joined().count, 700)
    }

    func testPendingCandidateWithoutCandidateDetailsStillFailsClosedToUnknownText() throws {
        let entry = try evidence(kind: "pending_candidate", status: "pending")
        // 待确认列表尚未读取过时不能拿空列表当否证：正文仍展示，但标注保持不变。
        let result = presentation(entry, candidates: [], loaded: false)

        XCTAssertTrue(result.isUnconfirmed)
        XCTAssertFalse(result.isWithheld)
        XCTAssertEqual(result.detailLines.first, ReplyEvidencePresentationPolicy.unconfirmedBadge)
        XCTAssertFalse(result.detailLines.contains { $0.contains("模型置信度") })
    }

    func testRejectedCandidateIsNotShownAsReplyEvidence() throws {
        let entry = try evidence(kind: "pending_candidate", status: "pending")
        let result = presentation(entry, candidates: [try candidate(status: "rejected")])

        XCTAssertTrue(result.isWithheld)
        XCTAssertEqual(result.body, "正文已隐藏。")
        XCTAssertTrue(result.isUnconfirmed)
        XCTAssertTrue(result.detailLines.contains { $0.contains("已否决") }, result.detailLines.description)
    }

    func testCandidateMissingFromLoadedPendingListIsWithheld() throws {
        let entry = try evidence(kind: "pending_candidate", status: "pending")
        let result = presentation(entry, candidates: [], loaded: true)

        XCTAssertTrue(result.isWithheld)
        XCTAssertEqual(result.body, "正文已隐藏。")
        XCTAssertTrue(result.isUnconfirmed)
        XCTAssertFalse(result.detailLines.contains { $0.contains("未确认候选、仅供参考") })
    }

    func testCandidateConfirmedInCurrentListIsNotShownAsUnconfirmedReference() throws {
        let entry = try evidence(kind: "pending_candidate", status: "pending")
        let result = presentation(
            entry,
            candidates: [try candidate(status: "confirmed")],
            loaded: true
        )

        XCTAssertTrue(result.isWithheld)
        XCTAssertEqual(result.body, "正文已隐藏。")
        XCTAssertTrue(result.detailLines.contains { $0.contains("已确认") }, result.detailLines.description)
    }

    // MARK: - fail-closed：缺失或未知 status

    func testPendingCandidateWithUnknownStatusWithholdsBody() throws {
        let entry = try evidence(kind: "pending_candidate", status: "active")
        let result = presentation(entry, candidates: [try candidate()])

        XCTAssertTrue(result.isWithheld)
        XCTAssertEqual(result.body, "正文已隐藏。")
        XCTAssertTrue(result.isStruckThrough)
        XCTAssertTrue(result.title.contains("未确认"), result.title)
        XCTAssertTrue(result.detailLines.contains { $0.contains("状态") }, result.detailLines.description)
    }

    func testPendingCandidateWithMissingStatusDecodesAndWithholdsBody() throws {
        let entry = try evidence(kind: "pending_candidate", status: nil)
        XCTAssertNil(entry.snapshotStatus)

        let result = presentation(entry, candidates: [try candidate()])
        XCTAssertTrue(entry.text.isEmpty == false)
        XCTAssertEqual(result.availability, .withheld)
        XCTAssertEqual(result.body, "正文已隐藏。")
        XCTAssertFalse(result.detailLines.contains(entry.text))
    }

    // MARK: - 既有依据的标签保持不变（回归）

    func testExistingEvidenceKindsKeepTheirLabels() throws {
        let expected: [(String, String)] = [
            ("message", "聊天消息"),
            ("confirmed_memory", "关系资料"),
            ("owner_memory", "本人资料"),
            ("continued_candidate", "继续修改的候选"),
            ("user_draft", "本次原句"),
        ]
        for (kind, label) in expected {
            let entry = try evidence(kind: kind)
            let result = presentation(entry, candidates: [], loaded: true)
            XCTAssertEqual(entry.kindLabel, label, kind)
            XCTAssertTrue(result.title.hasPrefix(label), "\(kind) -> \(result.title)")
            XCTAssertFalse(result.isUnconfirmed, kind)
            XCTAssertFalse(result.isWithheld, kind)
            XCTAssertEqual(result.body, "合成依据正文")
            XCTAssertFalse(result.title.contains("未确认"), kind)
        }
    }

    func testConfirmedEvidenceKeepsTimingLinesAndCitationSuffix() throws {
        let entry = try evidence(
            kind: "confirmed_memory",
            status: "active",
            cited: true,
            extra: ["timing": fullTimingJSON()]
        )
        let result = presentation(entry)

        XCTAssertTrue(result.title.hasSuffix(" · 候选引用"), result.title)
        XCTAssertTrue(
            result.detailLines.contains { $0.hasPrefix("来源聊天时间：") },
            result.detailLines.description
        )
    }

    func testUnknownEvidenceKindFallsBackWithoutConfirmedWording() throws {
        let entry = try evidence(kind: "unknown_kind_future", status: "active")
        let result = presentation(entry)

        XCTAssertEqual(entry.kindLabel, ReplyEvidencePresentationPolicy.fallbackKindLabel)
        XCTAssertFalse(result.isUnconfirmed)
        XCTAssertEqual(result.body, "合成依据正文")
        XCTAssertFalse(result.title.contains("关系资料"))
    }

    // MARK: - 草稿模式边界：没有未确认候选时不留位置

    func testEvidenceWithoutPendingCandidateProducesNoUnconfirmedMark() throws {
        let message = try evidence(kind: "message")
        let draft = try evidence(kind: "user_draft", status: "user_input")
        for entry in [message, draft] {
            let result = presentation(entry, candidates: [], loaded: true)
            XCTAssertFalse(result.isUnconfirmed, entry.kind)
            XCTAssertFalse(result.isWithheld, entry.kind)
            XCTAssertFalse(result.detailLines.contains(ReplyEvidencePresentationPolicy.unconfirmedBadge), entry.kind)
        }
    }

    func testOnlySelectedMemoryKindsShowMemoryTimingLines() throws {
        let timed = ["message", "confirmed_memory", "owner_memory"]
        let untimed = ["user_draft", "continued_candidate", "pending_candidate"]
        for kind in timed {
            XCTAssertTrue(try evidence(kind: kind).showsMemoryTiming, kind)
        }
        for kind in untimed {
            XCTAssertFalse(try evidence(kind: kind).showsMemoryTiming, kind)
        }
    }
}
