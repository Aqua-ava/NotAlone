import Foundation
import XCTest
@testable import NotAloneSyncCore

final class SessionNamePreviewTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_000)

    private func result(_ name: String) -> [String: Any] {
        ["ok": true, "wechat_in_front": true, "capture_version": "automatic-window-v2",
         "captured_at": "1970-01-01T00:16:39.000Z", "display_name": name, "selected_row_name": name,
         "quality": ["layout_verified": true, "display_name_confidence": 0.99,
                     "selected_row_name_confidence": 0.98]]
    }

    func testDisplaysActualRecognizedNameAndChangesWithoutAnExpectedName() {
        let first = SessionNamePreviewReading(result: result("合成甲"), now: now)
        let second = SessionNamePreviewReading(result: result("合成乙"), now: now)
        XCTAssertEqual(first.name, "合成甲")
        XCTAssertEqual(second.name, "合成乙")
        XCTAssertEqual(first.kind, .recognized)
        XCTAssertEqual(second.headline, "识别到：合成乙")
    }

    func testPauseFailureStaleAndUnreliableResultsNeverDisplayAName() {
        var low = result("合成甲")
        low["quality"] = ["layout_verified": true, "display_name_confidence": 0.89,
                          "selected_row_name_confidence": 0.99]
        var mismatch = result("合成甲")
        mismatch["selected_row_name"] = "合成乙"
        var old = result("合成甲")
        old["captured_at"] = "1970-01-01T00:16:00.000Z"
        var legacy = result("合成甲")
        legacy["capture_version"] = "automatic-window-v1"
        for value in [low, mismatch, old, legacy,
                      ["ok": true, "wechat_in_front": false, "display_name": "PRIVATE_NAME"],
                      ["ok": false, "error": "PRIVATE_ERROR", "display_name": "PRIVATE_NAME"]] {
            let reading = SessionNamePreviewReading(result: value, now: now)
            XCTAssertNil(reading.name)
            XCTAssertFalse(reading.headline.contains("PRIVATE"))
            XCTAssertFalse(reading.detail.contains("PRIVATE"))
        }
    }

    func testReliableRecognitionAfterFailureDoesNotRequireManualConfirmationForPreview() {
        let failed = SessionNamePreviewReading(result: ["ok": false, "error": "session_name_confidence_low"], now: now)
        XCTAssertEqual(failed.kind, .failed)
        XCTAssertTrue(failed.detail.contains("置信度不足"))
        let recovered = SessionNamePreviewReading(result: result("合成甲"), now: now)
        XCTAssertEqual(recovered.kind, .recognized)
        XCTAssertEqual(recovered.name, "合成甲")
    }

    func testUnknownForegroundIsAFailureAndCannotReclassifyANameAsNormalPause() {
        let unknown = SessionNamePreviewReading(result: result("合成甲"), frontmost: .unknown, now: now)
        XCTAssertNil(unknown.name)
        XCTAssertEqual(unknown.kind, .failed)
        XCTAssertTrue(unknown.detail.contains("前台状态"))
        let other = SessionNamePreviewReading(result: result("合成甲"), frontmost: .other, now: now)
        XCTAssertNil(other.name)
        XCTAssertEqual(other.kind, .paused)
    }

    func testDisplayedNameIsClearedAtItsCaptureExpiryBeforeTheNextObservation() {
        var delayed = result("合成甲")
        delayed["captured_at"] = "1970-01-01T00:16:35.100Z"
        let reading = SessionNamePreviewReading(result: delayed, now: now)
        XCTAssertEqual(reading.name, "合成甲")
        let expired = reading.current(at: now.addingTimeInterval(0.2))
        XCTAssertNil(expired.name)
        XCTAssertTrue(expired.detail.contains("过期"))
    }
}
