import XCTest
import CoreGraphics
@testable import NotAloneSyncCore

final class MinimalRegionLayoutTests: XCTestCase {
    func testNameCaptureContextFailuresKeepExactCheckpointAndSlotWithoutNewObservation() throws {
        for slot in [NameCaptureSlot.header, .row, .repeatedHeader] {
            for afterCapture in [false, true] {
                XCTAssertNoThrow(try NameCaptureGuards.context(matches: true, afterCapture: afterCapture, slot: slot))
                XCTAssertThrowsError(try NameCaptureGuards.context(matches: false, afterCapture: afterCapture, slot: slot)) { error in
                    let failure = error as? NameCaptureFailure
                    XCTAssertEqual(failure?.jsonObject()["failure_branch"] as? String,
                                   afterCapture ? "context_after_capture" : "context_before_capture")
                    XCTAssertEqual(failure?.jsonObject()["name_slot"] as? String, slot.rawValue)
                    XCTAssertEqual(failure?.jsonObject().count, 2)
                }
            }
        }
        XCTAssertThrowsError(try NameCaptureGuards.context(matches: false, afterCapture: false, slot: nil)) { error in
            XCTAssertEqual(error as? MinimalSessionError, .layoutChanged)
        }
    }

    func testNameCaptureOutputMismatchKeepsPixelGateAndSafeSlot() throws {
        XCTAssertNoThrow(try NameCaptureGuards.outputSize(actual: CGSize(width: 180, height: 50),
                                                        expected: CGSize(width: 180, height: 50), slot: .header))
        for actual in [CGSize(width: 179, height: 50), CGSize(width: 180, height: 51)] {
            XCTAssertThrowsError(try NameCaptureGuards.outputSize(actual: actual,
                                                                 expected: CGSize(width: 180, height: 50), slot: .header)) { error in
                XCTAssertEqual((error as? NameCaptureFailure)?.jsonObject()["failure_branch"] as? String, "output_size_mismatch")
                XCTAssertEqual((error as? NameCaptureFailure)?.jsonObject()["name_slot"] as? String, "header")
                XCTAssertEqual((error as? NameCaptureFailure)?.jsonObject().count, 2)
            }
        }
        XCTAssertThrowsError(try NameCaptureGuards.outputSize(actual: CGSize(width: 4, height: 39),
                                                             expected: CGSize(width: 4, height: 40), slot: nil)) { error in
            XCTAssertEqual(error as? MinimalSessionError, .layoutChanged)
        }
    }

    func testRepeatedHeaderMismatchOnlyReportsPresenceAndEquality() throws {
        for equal: String? in [nil, "合成名称"] {
            XCTAssertNoThrow(try NameCaptureGuards.repeatedHeader(equal, equal))
        }
        for (header, repeated, headerPresent, repeatedPresent) in [
            ("合成名称" as String?, "另一个合成名称" as String?, true, true),
            (nil, "合成名称", false, true), ("合成名称", nil, true, false),
        ] {
            XCTAssertThrowsError(try NameCaptureGuards.repeatedHeader(header, repeated)) { error in
                let diagnostics = (error as? NameCaptureFailure)?.jsonObject() ?? [:]
                XCTAssertEqual(diagnostics["failure_branch"] as? String, "repeated_header_mismatch")
                XCTAssertEqual(diagnostics["name_slot"] as? String, "repeated_header")
                XCTAssertEqual(diagnostics["header_present"] as? Bool, headerPresent)
                XCTAssertEqual(diagnostics["repeated_present"] as? Bool, repeatedPresent)
                XCTAssertEqual(diagnostics["header_repeated_equal"] as? Bool, false)
                XCTAssertEqual(diagnostics.count, 5)
                let encoded = try? JSONSerialization.data(withJSONObject: diagnostics)
                XCTAssertFalse(String(decoding: encoded ?? Data(), as: UTF8.self).contains("合成名称"))
            }
        }
    }

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

    func testContextDiagnosticsDoNotSelectAnAppOrPersistItsPath() throws {
        let diagnostics = CalibrationContextDiagnostics(
            frontmostProcessId: 321, frontmostBundleIdentifier: "com.notalone.desktop", frontmostBundlePath: nil,
            wechatProcessIds: [123], soleWechatBundlePath: "/synthetic/private/WeChat-shadow.app",
            selectedProcessId: 123, contextCode: "calibration_context_unavailable", identityChecks: nil
        ).jsonObject()
        XCTAssertEqual(diagnostics["front_app_code"] as? String, "notalone")
        XCTAssertEqual(diagnostics["front_process_id"] as? Int32, 321)
        XCTAssertEqual(diagnostics["selected_process_id"] as? Int32, 123)
        XCTAssertEqual(diagnostics["sole_wechat_app_code"] as? String, "wechat_other")
        XCTAssertEqual(diagnostics.count, 7)
        let data = try JSONSerialization.data(withJSONObject: diagnostics)
        XCTAssertFalse(String(decoding: data, as: UTF8.self).contains("private"))
        XCTAssertFalse(String(decoding: data, as: UTF8.self).contains("shadow"))
        let multiple = CalibrationContextDiagnostics(
            frontmostProcessId: 123, frontmostBundleIdentifier: "com.tencent.xinWeChat", frontmostBundlePath: "/Applications/WeChat.app",
            wechatProcessIds: [123, 456], soleWechatBundlePath: nil,
            selectedProcessId: 123, contextCode: "calibration_wechat_instances_ambiguous", identityChecks: nil
        ).jsonObject()
        XCTAssertEqual(multiple["front_app_code"] as? String, "wechat_primary")
        XCTAssertEqual(multiple["wechat_instance_count"] as? Int, 2)
        XCTAssertEqual(multiple["sole_wechat_process_id"] as? Int32, 0)
        XCTAssertEqual(multiple["sole_wechat_app_code"] as? String, "none")
    }

    func testIdentityDiagnosticsDistinguishExactDifferencesWithoutPersistingGeometry() throws {
        let frame = CGRect(x: 10, y: 20, width: 800, height: 600)
        let cases: [(pid_t, CGWindowID, CGRect, [String: Bool])] = [
            (123, 456, frame, ["process_id_matches": true, "window_id_matches": true,
                               "window_origin_matches": true, "window_size_matches": true]),
            (124, 456, frame, ["process_id_matches": false, "window_id_matches": true,
                               "window_origin_matches": true, "window_size_matches": true]),
            (123, 457, frame, ["process_id_matches": true, "window_id_matches": false,
                               "window_origin_matches": true, "window_size_matches": true]),
            (123, 456, CGRect(x: 10.25, y: 20, width: 800, height: 600),
             ["process_id_matches": true, "window_id_matches": true,
              "window_origin_matches": false, "window_size_matches": true]),
            (123, 456, CGRect(x: 10, y: 20.25, width: 800, height: 600),
             ["process_id_matches": true, "window_id_matches": true,
              "window_origin_matches": false, "window_size_matches": true]),
            (123, 456, CGRect(x: 10, y: 20, width: 800.25, height: 600),
             ["process_id_matches": true, "window_id_matches": true,
              "window_origin_matches": true, "window_size_matches": false]),
            (123, 456, CGRect(x: 10, y: 20, width: 800, height: 600.25),
             ["process_id_matches": true, "window_id_matches": true,
              "window_origin_matches": true, "window_size_matches": false]),
        ]
        for (pid, windowId, currentFrame, expected) in cases {
            let current = CalibrationContext(processId: pid, windowId: windowId, frame: currentFrame,
                                             version: "4.0.6", build: "29387")
            let checks = current.identityChecks(selectedProcessId: 123, windowId: 456, frame: frame)
            XCTAssertEqual(checks, expected)
            let code = expected.values.allSatisfy { $0 } ? "matched" : "identity_changed"
            let diagnostics = CalibrationContextDiagnostics(
                frontmostProcessId: pid, frontmostBundleIdentifier: "com.tencent.xinWeChat", frontmostBundlePath: "/Applications/WeChat.app",
                wechatProcessIds: [pid], soleWechatBundlePath: "/Applications/WeChat.app",
                selectedProcessId: 123, contextCode: code, identityChecks: checks
            ).jsonObject()
            XCTAssertEqual(diagnostics["identity_checks"] as? [String: Bool], expected)
            XCTAssertEqual(diagnostics.count, 8)
            let encoded = try JSONSerialization.data(withJSONObject: diagnostics)
            let roundTrip = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
            XCTAssertEqual(roundTrip["identity_checks"] as? [String: Bool], expected)
        }
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
