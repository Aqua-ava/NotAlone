import CoreGraphics
import XCTest
@testable import NotAloneSyncCore

final class ForegroundStatusPreviewTests: XCTestCase {
    @MainActor
    func testShowsSystemForegroundSeparatelyFromProbePreflight() {
        let reading = ForegroundStatusReading.observe(frontmost: { .wechat }, context: { nil })
        XCTAssertEqual(reading.frontmost, .wechat)
        XCTAssertEqual(reading.preflight, .notForeground)
        XCTAssertEqual(reading.headline, "前台判断不一致")
    }

    func testHumanCheckDoesNotAcceptStaleOrUnknownObservations() {
        var evidence = ForegroundPreviewEvidence()
        let visible = ForegroundStatusReading(frontmost: .wechat, preflight: .ready)
        evidence.record(expectedWechat: true, reading: visible, sampleAge: 0.2)
        evidence.record(expectedWechat: false, reading: visible, sampleAge: 0.3)
        evidence.record(expectedWechat: true, reading: visible, sampleAge: 4)
        evidence.record(expectedWechat: false,
            reading: ForegroundStatusReading(frontmost: .unknown, preflight: .notForeground), sampleAge: 0)
        XCTAssertEqual(evidence.matches, 1)
        XCTAssertEqual(evidence.mismatches, 1)
        XCTAssertEqual(evidence.unverified, 2)
    }

    @MainActor
    func testVersionFailureIsVisibleWithoutCallingItNotForeground() {
        let reading = ForegroundStatusReading.observe(frontmost: { .wechat }, context: {
            throw CalibrationContextFailure.version
        })
        XCTAssertEqual(reading.headline, "微信在前台 · 前置检查未通过")
        XCTAssertEqual(reading.preflight.label, "微信版本不在当前支持范围")
    }

    @MainActor
    func testUnknownErrorCannotExposeAnExceptionInTheWindow() {
        let reading = ForegroundStatusReading.observe(frontmost: { .unknown }, context: {
            throw NSError(domain: "PRIVATE_WINDOW_TITLE", code: 1)
        })
        XCTAssertEqual(reading.headline, "前台状态未知")
        XCTAssertEqual(reading.preflight, .blocked("calibration_context_unavailable"))
    }
}
