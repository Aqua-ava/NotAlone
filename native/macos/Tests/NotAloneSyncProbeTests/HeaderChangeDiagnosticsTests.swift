import XCTest
@testable import NotAloneSyncCore

final class HeaderChangeDiagnosticsTests: XCTestCase {
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
