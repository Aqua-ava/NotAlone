import XCTest
import CoreGraphics
@testable import NotAloneSyncCore

final class MinimalRegionLayoutTests: XCTestCase {
    func testNameValidationReportsSafeFailureCategoryWithoutLoweringQuality() throws {
        let cases: [(String?, Double, String?, Double, String)] = [
            (nil, 0, "测试", 1, "header_name_unreadable"),
            ("测试", 1, nil, 0, "row_name_unreadable"),
            ("测试", 1, "其他", 1, "session_names_mismatch"),
            ("测试", 0.89, "测试", 1, "session_name_confidence_low"),
        ]
        for (header, headerConfidence, row, rowConfidence, code) in cases {
            let names = Names(header: Name(text: header, confidence: headerConfidence),
                              row: Name(text: row, confidence: rowConfidence))
            XCTAssertThrowsError(try names.validate()) { error in
                XCTAssertEqual((error as? MinimalSessionError)?.rawValue, code)
            }
        }
        XCTAssertNoThrow(try Names(header: Name(text: "测试", confidence: 0.90),
                                  row: Name(text: "测试", confidence: 1)).validate())
    }

    func testRepeatedNameConfidenceRemainsRequiredAndDiagnosticsContainOnlyNumbers() throws {
        let names = Names(
            header: Name(text: "合成名称", confidence: 0.98, pixelSize: CGSize(width: 160, height: 48)),
            row: Name(text: "合成名称", confidence: 0.97, pixelSize: CGSize(width: 160, height: 40)),
            repeatedHeader: Name(text: "合成名称", confidence: 0.89, pixelSize: CGSize(width: 160, height: 48))
        )
        XCTAssertThrowsError(try names.validate()) { error in
            XCTAssertEqual(error as? MinimalSessionError, .nameConfidenceLow)
        }
        XCTAssertEqual(names.displayNameConfidence, 0.89)
        XCTAssertEqual(names.confidence, 0.89)
        let data = try JSONSerialization.data(withJSONObject: names.qualityDiagnostics(scale: 2, durationMs: 487))
        let quality = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Double])
        XCTAssertEqual(quality, [
            "display_name_confidence": 0.98, "selected_row_name_confidence": 0.97,
            "repeated_display_name_confidence": 0.89,
            "display_name_width": 160, "display_name_height": 48,
            "selected_row_name_width": 160, "selected_row_name_height": 40,
            "pixel_scale": 2, "names_duration_ms": 487,
        ])
        XCTAssertFalse(String(decoding: data, as: UTF8.self).contains("合成名称"))
    }

    private func window(_ id: Int, _ width: Double, _ height: Double) -> [String: Any] {
        [kCGWindowNumber as String: id,
         kCGWindowBounds as String: CGRect(x: 0, y: 0, width: width, height: height).dictionaryRepresentation]
    }

    func testTinyAuxiliaryWindowDoesNotMaskUniqueChatWindow() throws {
        let selected = try selectCalibrationWindow([window(1, 52, 20), window(2, 1072, 846)])
        XCTAssertEqual(selected.windowId, 2)
        XCTAssertEqual(selected.frame.size, CGSize(width: 1072, height: 846))
    }

    func testMultipleChatOrUnknownWindowsStillRejectSelection() {
        for windows in [
            [window(1, 1072, 846), window(2, 800, 600)],
            [window(1, 1072, 846), window(2, 200, 200)],
            [window(1, 1072, 846), window(2, 0, 20)],
            [window(1, 52, 20)],
            [window(1, 1072, 846), [kCGWindowNumber as String: 2]],
        ] {
            XCTAssertThrowsError(try selectCalibrationWindow(windows))
        }
    }

    private func selection() -> [String: Any] {
        ["schemaVersion": 1, "state": "selected-awaiting-verification",
         "wechatVersion": "4.0.6", "wechatBuild": "29387", "processId": 123, "windowId": 456,
         "windowFrame": ["x": 10, "y": 20, "width": 800, "height": 600],
         "regions": ["displayName": ["x": 280, "y": 20, "width": 80, "height": 24],
                     "selectedRowName": ["x": 114, "y": 80, "width": 80, "height": 20],
                     "verticalDivider": ["x": 270, "y": 70, "width": 1, "height": 40],
                     "headerDivider": ["x": 280, "y": 62, "width": 70, "height": 1],
                     "selectedHighlight": ["x": 111, "y": 82, "width": 2, "height": 12]]]
    }

    func testSelectionDoesNotAuthorizeCaptureUntilSentinelsAreVerified() throws {
        let data = try JSONSerialization.data(withJSONObject: selection())
        XCTAssertThrowsError(try MinimalRegionLayout.decode(data, requireVerified: true))
        let pending = try MinimalRegionLayout.decode(data, requireVerified: false)
        XCTAssertEqual(pending.regions.count, 5)
        XCTAssertEqual(pending.regions["displayName"]?.width, 80)
    }

    func testVerifiedLayoutRequiresAllThreeDigestsAndRejectsExtraData() throws {
        var profile = selection()
        profile["state"] = "verified-minimal-layout"
        profile["pixelScale"] = 2
        profile["sentinelDigests"] = ["verticalDivider": String(repeating: "a", count: 64),
                                      "headerDivider": String(repeating: "b", count: 64),
                                      "selectedHighlight": String(repeating: "c", count: 64)]
        let layout = try MinimalRegionLayout.decode(JSONSerialization.data(withJSONObject: profile), requireVerified: true)
        XCTAssertEqual(layout.pixelScale, 2)
        XCTAssertEqual(layout.sentinelDigests.count, 3)
        profile["privateText"] = "合成禁止附带文字"
        XCTAssertThrowsError(try MinimalRegionLayout.decode(JSONSerialization.data(withJSONObject: profile), requireVerified: true))
        profile.removeValue(forKey: "privateText")
        profile["sentinelDigests"] = ["headerDivider": String(repeating: "b", count: 64)]
        XCTAssertThrowsError(try MinimalRegionLayout.decode(JSONSerialization.data(withJSONObject: profile), requireVerified: true))
    }

    func testBodyRegionAndBooleanWindowIdentityCannotBecomeLayout() throws {
        var invalid = selection()
        invalid["processId"] = true
        XCTAssertThrowsError(try MinimalRegionLayout.decode(JSONSerialization.data(withJSONObject: invalid), requireVerified: false))
        invalid = selection()
        var regions = invalid["regions"] as! [String: [String: Int]]
        regions["displayName"] = ["x": 280, "y": 300, "width": 80, "height": 24]
        regions["headerDivider"] = ["x": 280, "y": 350, "width": 70, "height": 1]
        invalid["regions"] = regions
        XCTAssertThrowsError(try MinimalRegionLayout.decode(JSONSerialization.data(withJSONObject: invalid), requireVerified: false))
    }
}
