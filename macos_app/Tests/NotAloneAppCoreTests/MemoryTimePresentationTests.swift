import Foundation
import XCTest
import NotAloneAppCore

final class MemoryTimePresentationTests: XCTestCase {
    func testUnknownMemoryTimesStayExplicit() {
        XCTAssertEqual(
            MemoryTimePresentation.lines(
                timing: nil, adoptionMethod: "auto", validAt: nil, invalidAt: nil,
                timeZone: TimeZone(secondsFromGMT: 0)!
            ),
            ["来源聊天时间：未知", "保存时间：未知"]
        )
    }

    func testHistoricalChatAndSaveTimesKeepYearAndSeparateValidity() {
        let timing = MemoryTimingEntry(
            recordedAt: "2026-10-02T01:02:03.123456+00:00",
            sourceStartedAt: "2025-12-31T23:59:58.500000+00:00",
            sourceEndedAt: "2025-12-31T23:59:58.500000+00:00",
            sourceTimeComplete: true
        )
        XCTAssertEqual(
            MemoryTimePresentation.lines(
                timing: timing, adoptionMethod: "auto",
                validAt: "2026-01-02T04:05:06+08:00",
                invalidAt: "2026-02-03T12:34:56+08:00",
                timeZone: TimeZone(identifier: "Asia/Shanghai")!
            ),
            [
                "来源聊天时间：2026-01-01 07:59:58 +08:00",
                "保存时间：2026-10-02 09:02:03 +08:00",
                "生效时间：2026-01-02 04:05:06 +08:00",
                "失效时间：2026-02-03 12:34:56 +08:00",
            ]
        )
    }

    func testIncompleteRangeAndManualSaveAreLabelledIndependently() {
        XCTAssertEqual(
            MemoryTimePresentation.lines(
                timing: MemoryTimingEntry(
                    recordedAt: "2026-10-02T09:08:07+08:00",
                    sourceStartedAt: "2026-09-01T10:00:00+08:00",
                    sourceEndedAt: "2026-09-02T11:12:13+08:00"
                ),
                adoptionMethod: "manual", timeZone: TimeZone(identifier: "Asia/Shanghai")!
            ),
            [
                "来源聊天时间：2026-09-01 10:00:00 +08:00 至 2026-09-02 11:12:13 +08:00（部分来源时间未知）",
                "录入时间：2026-10-02 09:08:07 +08:00",
            ]
        )
    }

    func testInvalidAndTimezoneMissingTimesAreExplicitlyUnknown() {
        for raw in ["bad-date", "2026-10-02T12:00:00", "2026-02-30T12:00:00Z"] {
            XCTAssertEqual(
                MemoryTimePresentation.lines(
                    timing: MemoryTimingEntry(
                        recordedAt: raw, sourceStartedAt: raw, sourceEndedAt: raw,
                        sourceTimeComplete: true
                    ),
                    validAt: raw, invalidAt: raw, timeZone: TimeZone(secondsFromGMT: 0)!
                ),
                ["来源聊天时间：未知", "保存时间：未知", "生效时间：未知", "失效时间：未知"]
            )
        }
    }

    func testOldMemoryCandidateAndEvidencePayloadsRemainDecodable() throws {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let memory = try decoder.decode(MemoryEntry.self, from: Data(#"{"memory_id":"memory","level":"contact","text":"合成历史事实","category":"common_fact","topic":"other","adoption_method":"auto","status":"active"}"#.utf8))
        let candidate = try decoder.decode(MemoryCandidateEntry.self, from: Data(#"{"candidate_id":"candidate","text":"合成待确认事实","category":"common_fact","topic":"other","status":"pending"}"#.utf8))
        let evidence = try decoder.decode(ReplyEvidence.self, from: Data(#"{"evidence_id":"evidence","kind":"confirmed_memory","text":"合成历史依据","selection_reason":"合成相关依据","snapshot_status":"active","cited":true}"#.utf8))
        XCTAssertNil(memory.timing)
        XCTAssertNil(candidate.timing)
        XCTAssertNil(evidence.timing)
        XCTAssertNil(evidence.validAt)
        XCTAssertNil(evidence.invalidAt)
    }

    func testNewPayloadTimesDecodeAcrossMemoryCandidateAndEvidence() throws {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let timingPayload: [String: Any] = [
            "recorded_at": "2026-10-02T02:03:04+00:00",
            "source_started_at": "2026-09-01T05:06:07+05:45",
            "source_ended_at": "2026-09-01T05:06:07+05:45",
            "source_time_complete": false,
        ]
        let memory = try decoder.decode(MemoryEntry.self, from: JSONSerialization.data(withJSONObject: [
            "memory_id": "memory", "level": "owner", "text": "合成事实",
            "category": "common_fact", "topic": "other", "adoption_method": "auto",
            "status": "active", "timing": timingPayload,
        ]))
        let candidate = try decoder.decode(MemoryCandidateEntry.self, from: JSONSerialization.data(withJSONObject: [
            "candidate_id": "candidate", "text": "合成候选", "category": "common_fact",
            "topic": "other", "status": "pending", "timing": timingPayload,
        ]))
        let evidence = try decoder.decode(ReplyEvidence.self, from: JSONSerialization.data(withJSONObject: [
            "evidence_id": "evidence", "kind": "owner_memory", "text": "合成依据",
            "selection_reason": "相关", "snapshot_status": "active", "cited": false,
            "timing": timingPayload,
        ]))
        for timing in [memory.timing, candidate.timing, evidence.timing] {
            XCTAssertEqual(
                MemoryTimePresentation.lines(timing: timing, timeZone: TimeZone(secondsFromGMT: 0)!),
                [
                    "来源聊天时间：2026-08-31 23:21:07 Z（部分来源时间未知）",
                    "保存时间：2026-10-02 02:03:04 Z",
                ]
            )
        }
    }
}
