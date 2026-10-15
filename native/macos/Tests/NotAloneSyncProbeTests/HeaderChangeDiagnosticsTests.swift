import XCTest
@testable import NotAloneSyncCore

final class HeaderChangeDiagnosticsTests: XCTestCase {
    func testContextDifferencesOnlySerializeFixedMatchingBits() {
        let expected = CalibrationContext(processId: 770001, windowId: 880002,
            frame: CGRect(x: 123456, y: 234567, width: 1000, height: 800),
            version: "private-version", build: "private-build")
        let cases: [(CalibrationContext, String)] = [
            (.init(processId: 9, windowId: expected.windowId, frame: expected.frame,
                version: expected.version, build: expected.build), "011111"),
            (.init(processId: expected.processId, windowId: 9, frame: expected.frame,
                version: expected.version, build: expected.build), "101111"),
            (.init(processId: expected.processId, windowId: expected.windowId,
                frame: CGRect(x: 1, y: 2, width: 1000, height: 800),
                version: expected.version, build: expected.build), "110111"),
            (.init(processId: expected.processId, windowId: expected.windowId,
                frame: CGRect(x: 123456, y: 234567, width: 900, height: 700),
                version: expected.version, build: expected.build), "111011"),
            (.init(processId: expected.processId, windowId: expected.windowId, frame: expected.frame,
                version: "changed", build: expected.build), "111101"),
            (.init(processId: expected.processId, windowId: expected.windowId, frame: expected.frame,
                version: expected.version, build: "changed"), "111110"),
        ]
        XCTAssertNil(HeaderChangeContextDiagnosis.comparing(expected, to: expected))
        for (current, bits) in cases {
            var diagnostics = HeaderChangeDiagnostics(
                environment: ["NOTALONE_HEADER_CHANGE_DIAGNOSTICS": "1"], beganAt: 10)
            let diagnosis = HeaderChangeContextDiagnosis.comparing(expected, to: current)!
            let line = diagnostics.contextLine(diagnosis, at: 10.125)!
            XCTAssertEqual(line, "notalone-header-context-v1 identity_mismatch \(bits) 125.0\n")
            for sensitive in ["770001", "880002", "123456", "234567", "private-version", "private-build"] {
                XCTAssertFalse(line.contains(sensitive))
            }
        }
    }

    func testUnreadableContextHasFixedReasonsNoValuesAndSharesOptInAndBounds() {
        let failures: [(CalibrationContextFailure, String)] = [
            (.instances, "instances_ambiguous"), (.version, "version_unsupported"),
            (.notVisible, "window_not_visible"), (.windows, "windows_ambiguous"),
            (.geometry, "window_geometry_invalid"), (.unavailable, "context_unavailable"),
            (.foregroundApplicationUnavailable, "foreground_unknown"),
        ]
        var enabled = HeaderChangeDiagnostics(
            environment: ["NOTALONE_HEADER_CHANGE_DIAGNOSTICS": "1"], beganAt: 0)
        for (failure, reason) in failures {
            let diagnosis = HeaderChangeContextDiagnosis.unreadable(.classify(failure))
            XCTAssertEqual(enabled.contextLine(diagnosis, at: 1),
                "notalone-header-context-v1 \(reason) ------ 1000.0\n")
        }
        for (failure, reason) in [(HeaderChangeContextReadFailure.notWechatForeground, "not_wechat_foreground"),
            (.windowListUnavailable, "window_list_unavailable")] {
            XCTAssertEqual(enabled.contextLine(.unreadable(failure), at: 1),
                "notalone-header-context-v1 \(reason) ------ 1000.0\n")
        }
        let diagnosis = HeaderChangeContextDiagnosis.unreadable(.windowsAmbiguous)
        for value in [nil, "", "0", "true", "01"] as [String?] {
            var disabled = HeaderChangeDiagnostics(
                environment: value.map { ["NOTALONE_HEADER_CHANGE_DIAGNOSTICS": $0] } ?? [:], beganAt: 0)
            XCTAssertNil(disabled.contextLine(diagnosis, at: 1))
        }
        var bounded = HeaderChangeDiagnostics(
            environment: ["NOTALONE_HEADER_CHANGE_DIAGNOSTICS": "1"], beganAt: 0)
        XCTAssertNil(bounded.contextLine(diagnosis, at: .nan))
        var bytes = 0
        for _ in 0..<16 {
            bytes += bounded.line(stage: .run, reason: .begin, at: 1)!.utf8.count
            let line = bounded.contextLine(diagnosis, at: 1)!
            XCTAssertLessThanOrEqual(line.utf8.count, 120)
            bytes += line.utf8.count
        }
        XCTAssertLessThanOrEqual(bytes, 3840)
        XCTAssertNil(bounded.contextLine(diagnosis, at: 1))
        XCTAssertNil(bounded.line(stage: .finished, reason: .contextChanged, at: 1))
    }

    @MainActor
    func testContextReadKeepsOneResolutionAndProjectsOnlyItsRejection() {
        var calls = 0
        let expected = CalibrationContext(processId: 7, windowId: 9,
            frame: CGRect(x: 0, y: 0, width: 1000, height: 800), version: "4.0.6", build: "29387")
        let accepted = CalibrationContext.readForHeaderChange { rejection in
            calls += 1
            return expected
        }
        XCTAssertEqual(try? accepted.get(), expected)
        XCTAssertEqual(calls, 1)
        for reason in [HeaderChangeContextReadFailure.foregroundUnknown, .notWechatForeground, .windowListUnavailable] {
            calls = 0
            let denied = CalibrationContext.readForHeaderChange { rejection in
                calls += 1; rejection = reason
                throw CalibrationContextFailure.unavailable
            }
            if case .failure(let actual) = denied { XCTAssertEqual(actual, reason) }
            else { XCTFail("拒绝不得变成可用上下文") }
            XCTAssertEqual(calls, 1)
        }
        let denied = CalibrationContext.readForHeaderChange { _ in throw CalibrationContextFailure.windows }
        if case .failure(let actual) = denied { XCTAssertEqual(actual, .windowsAmbiguous) }
        else { XCTFail("窗口失败必须保留不可读") }
    }

    func testStreamErrorsUseOnlyKnownDomainAndFixedPublicCategories() {
        XCTAssertEqual(HeaderChangeDiagnostics.streamFailure(isScreenCaptureKit: true, code: -3805),
            .streamConnectionInterrupted)
        XCTAssertEqual(HeaderChangeDiagnostics.streamFailure(isScreenCaptureKit: true, code: -3821),
            .streamSystemStopped)
        XCTAssertEqual(HeaderChangeDiagnostics.streamFailure(isScreenCaptureKit: false, code: -3805),
            .streamError)
        XCTAssertEqual(HeaderChangeDiagnostics.streamFailure(isScreenCaptureKit: true, code: 999_999),
            .streamError)
    }

    func testOnlyExactOptInEmitsTheFixedNumericProtocol() {
        for value in [nil, "", "0", "true", "01"] as [String?] {
            let environment = value.map { ["NOTALONE_HEADER_CHANGE_DIAGNOSTICS": $0] } ?? [:]
            var diagnostics = HeaderChangeDiagnostics(environment: environment, beganAt: 10)
            XCTAssertNil(diagnostics.line(stage: .initialLayout, reason: .begin, at: 10.125))
        }
        var diagnostics = HeaderChangeDiagnostics(
            environment: ["NOTALONE_HEADER_CHANGE_DIAGNOSTICS": "1"], beganAt: 10)
        XCTAssertEqual(diagnostics.line(stage: .initialLayout, reason: .begin, at: 10.125),
            "notalone-header-change-v1 initial_layout begin 125.0\n")
        XCTAssertEqual(diagnostics.line(stage: .streaming, reason: .outputDimensions, at: 12.5),
            "notalone-header-change-v1 streaming output_dimensions 2500.0\n")
    }

    func testInvalidTimesAreSilentAndDoNotConsumeTheBoundedOutput() {
        var diagnostics = HeaderChangeDiagnostics(
            environment: ["NOTALONE_HEADER_CHANGE_DIAGNOSTICS": "1"], beganAt: 10)
        for invalid in [Double.nan, .infinity, -.infinity, 9, .greatestFiniteMagnitude] {
            XCTAssertNil(diagnostics.line(stage: .finished, reason: .operationFailed, at: invalid))
        }
        for invalid in [Double.nan, .infinity, -.infinity, -1] {
            var invalidStart = HeaderChangeDiagnostics(
                environment: ["NOTALONE_HEADER_CHANGE_DIAGNOSTICS": "1"], beganAt: invalid)
            XCTAssertNil(invalidStart.line(stage: .finished, reason: .operationFailed, at: 10))
        }
        var emittedBytes = 0
        for _ in 0..<32 {
            let line = diagnostics.line(stage: .streaming, reason: .firstFrame, at: 10.5)
            XCTAssertNotNil(line)
            emittedBytes += line?.utf8.count ?? 0
        }
        XCTAssertNil(diagnostics.line(stage: .finished, reason: .operationFailed, at: 11))
        XCTAssertLessThanOrEqual(emittedBytes, 32 * 120)
    }

    func testFirstFrameRejectionsHaveDistinctFixedReasons() {
        let reasons: [HeaderChangeDiagnosticReason] = [
            .outputDimensions, .pixelFormat, .bufferLock, .missingBuffer, .frameLimit,
        ]
        var diagnostics = HeaderChangeDiagnostics(
            environment: ["NOTALONE_HEADER_CHANGE_DIAGNOSTICS": "1"], beganAt: 0)
        let lines = reasons.compactMap { diagnostics.line(stage: .streaming, reason: $0, at: 1) }
        XCTAssertEqual(lines, ["output_dimensions", "pixel_format", "buffer_lock", "missing_buffer", "frame_limit"].map {
            "notalone-header-change-v1 streaming \($0) 1000.0\n"
        })
    }
}
