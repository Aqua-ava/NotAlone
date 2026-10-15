import CoreGraphics
import XCTest
@testable import NotAloneSyncCore

final class AutomaticSessionCaptureTests: XCTestCase {
    @MainActor
    func testHeaderPreviewReadsOnlyTitleWithoutRequiringASelectedRowOrQualityConfirmation() async {
        let context = CalibrationContext(processId: 7, windowId: 9,
            frame: CGRect(x: 0, y: 0, width: 900, height: 700), version: "4.0.6", build: "29387")
        var captures = 0
        var ocrSizes: [CGSize] = []
        let result = await AutomaticSessionCapture.observeHeaderPreview(context: { context }, capture: { _ in
            captures += 1
            return self.window(rows: [])
        }, recognize: { image in
            ocrSizes.append(CGSize(width: image.width, height: image.height))
            return [RecognizedLine(text: "合成甲", speaker: .unknown, confidence: 0.65)]
        })
        XCTAssertEqual(captures, 1)
        XCTAssertEqual(ocrSizes.count, 1)
        XCTAssertLessThanOrEqual(ocrSizes[0].height, 36)
        XCTAssertEqual(result["header_text"] as? String, "合成甲")
        XCTAssertEqual(result["header_confidence"] as? Double, Double(Float(0.65)))
        XCTAssertEqual(result["capture_version"] as? String, "preview-header-v1")
        XCTAssertNil(result["display_name"])
        XCTAssertNil(result["selected_row_name"])
    }

    @MainActor
    func testHeaderPreviewNeverCapturesOtherAppsOrRecognizesAfterContextChanges() async {
        let context = CalibrationContext(processId: 7, windowId: 9,
            frame: CGRect(x: 0, y: 0, width: 900, height: 700), version: "4.0.6", build: "29387")
        for failUnknown in [false, true] {
            let result = await AutomaticSessionCapture.observeHeaderPreview(context: {
                if failUnknown { throw CalibrationContextFailure.foregroundApplicationUnavailable }
                return nil
            }, capture: { _ in
                XCTFail("非微信或未知前台不得采图")
                return self.window()
            }, recognize: { _ in XCTFail("非微信或未知前台不得OCR"); return [] })
            XCTAssertEqual(result["ok"] as? Bool, !failUnknown)
            XCTAssertNil(result["header_text"])
        }
        var contextCalls = 0
        let changed = await AutomaticSessionCapture.observeHeaderPreview(context: {
            contextCalls += 1
            return contextCalls == 1 ? context : nil
        }, capture: { _ in self.window() }, recognize: { _ in
            XCTFail("采图后前台改变不得继续OCR"); return []
        })
        XCTAssertEqual(changed["ok"] as? Bool, false)
        XCTAssertEqual(changed["error"] as? String, "minimal_region_layout_changed")
        XCTAssertNil(changed["header_text"])
    }

    @MainActor
    func testMissingSystemForegroundCannotClaimWeChatIsNotInFront() async {
        let result = await AutomaticSessionCapture.observe(context: {
            try AutomaticSessionCapture.foregroundContext(frontmost: { .unknown }, resolve: {
                XCTFail("前台未知时不得读取微信窗口")
                throw CalibrationContextFailure.unavailable
            })
        }, capture: { _ in
            XCTFail("前台未知时不得截图")
            return self.window()
        }, recognize: { _ in
            XCTFail("前台未知时不得OCR")
            return Name(text: "合成", confidence: 1)
        })
        XCTAssertEqual(result["ok"] as? Bool, false)
        XCTAssertNil(result["wechat_in_front"])
        XCTAssertEqual(result["error"] as? String, "foreground_application_unavailable")
    }

    @MainActor
    func testObservesWithoutProfileAfterMoveResizeAndScaleChange() async throws {
        for (width, height, scale, origin, divider, row) in [
            (900, 700, 1, 0, 270, 62), (1200, 900, 2, 230, 330, 198),
            (800, 600, 1, -800, 240, 130)] {
            let context = CalibrationContext(processId: 7, windowId: 9,
                frame: CGRect(x: origin, y: 30, width: width, height: height), version: "4.0.6", build: "29387")
            var ocrSizes: [CGSize] = []
            let result = await AutomaticSessionCapture.observe(context: { context }, capture: { _ in
                self.window(width: width, height: height, scale: scale, divider: divider, rows: [row])
            }, recognize: { image in
                ocrSizes.append(CGSize(width: image.width, height: image.height))
                return Name(text: "合成测试", confidence: 0.99)
            })
            XCTAssertEqual(result["ok"] as? Bool, true)
            XCTAssertEqual(result["capture_version"] as? String, "automatic-window-v2")
            XCTAssertEqual(ocrSizes.count, 2)
            XCTAssertTrue(ocrSizes.allSatisfy { $0.width <= 400 * CGFloat(scale) && $0.height <= 44 * CGFloat(scale) })
        }
    }

    @MainActor
    func testCaptureTimeStaysAtFrameAcquisitionWhileOCRRuns() async {
        let context = CalibrationContext(processId: 7, windowId: 9,
            frame: CGRect(x: 0, y: 0, width: 900, height: 700), version: "4.0.6", build: "29387")
        var instant = Date(timeIntervalSince1970: 0)
        let result = await AutomaticSessionCapture.observe(context: { context }, capture: { _ in
            instant = Date(timeIntervalSince1970: 100)
            return self.window()
        }, recognize: { _ in
            instant.addTimeInterval(20)
            return Name(text: "合成", confidence: 1)
        }, clock: { instant })
        XCTAssertEqual(result["ok"] as? Bool, true)
        XCTAssertEqual(result["capture_version"] as? String, "automatic-window-v2")
        XCTAssertEqual(result["captured_at"] as? String, "1970-01-01T00:01:40.000Z")
    }

    @MainActor
    func testFailsClosedBeforeCaptureAndAfterFocusOrGeometryChange() async {
        let initial = CalibrationContext(processId: 7, windowId: 9,
            frame: CGRect(x: 0, y: 0, width: 900, height: 700), version: "4.0.6", build: "29387")
        var captured = 0, recognized = 0
        let inactive = await AutomaticSessionCapture.observe(context: { nil }, capture: { _ in
            captured += 1; return self.window()
        }, recognize: { _ in recognized += 1; return Name(text: "合成", confidence: 1) })
        XCTAssertEqual(inactive["wechat_in_front"] as? Bool, false)
        XCTAssertEqual(captured, 0)
        for next in [nil, CalibrationContext(processId: 7, windowId: 9,
            frame: CGRect(x: 50, y: 0, width: 1000, height: 700), version: "4.0.6", build: "29387")] {
            var reads = 0
            let result = await AutomaticSessionCapture.observe(context: { reads += 1; return reads == 1 ? initial : next },
                capture: { _ in self.window() }, recognize: { _ in recognized += 1; return Name(text: "合成", confidence: 1) })
            XCTAssertEqual(result["error"] as? String, "minimal_region_layout_changed")
            XCTAssertEqual(result["stage"] as? String, "context_after_capture")
        }
        XCTAssertEqual(recognized, 0)
    }

    @MainActor
    func testRejectsAbsentOrAmbiguousSelectionAndOnlyOCRsNameCrops() async {
        let context = CalibrationContext(processId: 7, windowId: 9,
            frame: CGRect(x: 0, y: 0, width: 900, height: 700), version: "4.0.6", build: "29387")
        for rows in [[], [62, 266]] {
            var calls = 0
            let result = await AutomaticSessionCapture.observe(context: { context }, capture: { _ in self.window(rows: rows) },
                recognize: { _ in calls += 1; return Name(text: "合成", confidence: 1) })
            XCTAssertEqual(result["ok"] as? Bool, false)
            XCTAssertEqual(result["stage"] as? String, "layout")
            XCTAssertEqual(result["error"] as? String, "automatic_layout_selection_ambiguous")
            XCTAssertEqual(calls, 0)
        }
        for confidence in [0.3, Double.nan, 1.1] {
            let result = await AutomaticSessionCapture.observe(context: { context }, capture: { _ in self.window(dark: true) },
                recognize: { _ in Name(text: "合成", confidence: confidence) })
            XCTAssertEqual(result["ok"] as? Bool, false)
            XCTAssertEqual(result["stage"] as? String, "names")
        }
        var calls = 0
        let mismatch = await AutomaticSessionCapture.observe(context: { context }, capture: { _ in self.window() },
            recognize: { _ in calls += 1; return Name(text: calls == 1 ? "甲" : "乙", confidence: 1) })
        XCTAssertEqual(mismatch["error"] as? String, "session_names_mismatch")
    }

    @MainActor
    func testSidebarWithoutVisibleRailDividerStillUsesUniqueHighlight() async {
        let context = CalibrationContext(processId: 7, windowId: 9,
            frame: CGRect(x: 0, y: 0, width: 900, height: 700), version: "4.0.6", build: "29387")
        for dark in [false, true] {
            let result = await AutomaticSessionCapture.observe(context: { context },
                capture: { _ in self.window(rows: [266], dark: dark, railLine: false) },
                recognize: { _ in Name(text: "合成", confidence: 1) })
            XCTAssertEqual(result["ok"] as? Bool, true)
        }
    }

    @MainActor
    func testOCRReceivesOnlyCurrentNamesAndLateFocusChangeDiscardsOutput() async {
        let context = CalibrationContext(processId: 7, windowId: 9,
            frame: CGRect(x: 0, y: 0, width: 900, height: 700), version: "4.0.6", build: "29387")
        var checks = 0, calls = 0
        let result = await AutomaticSessionCapture.observe(context: { checks += 1; return checks <= 2 ? context : nil },
            capture: { _ in self.window(rows: [130], markers: true) }, recognize: { image in
                calls += 1
                let data = image.dataProvider!.data! as Data
                var red = false, blue = false, green = false
                for y in 0..<image.height { for x in 0..<image.width {
                    let i = y * image.bytesPerRow + x * 4
                    red = red || (data[i] == 255 && data[i+1] == 0 && data[i+2] == 0)
                    blue = blue || (data[i] == 0 && data[i+1] == 0 && data[i+2] == 255)
                    green = green || (data[i] == 0 && data[i+1] == 255 && data[i+2] == 0)
                } }
                XCTAssertFalse(green, "正文标记不得进入OCR")
                XCTAssertEqual(red, calls == 1)
                XCTAssertEqual(blue, calls == 2)
                return Name(text: "合成", confidence: 1)
            })
        XCTAssertEqual(calls, 2)
        XCTAssertEqual(result["error"] as? String, "minimal_region_layout_changed")
        XCTAssertNil(result["display_name"])
    }

    @MainActor
    func testSingleFrameRepresentsCapturedSessionWithoutSecondCapture() async {
        let context = CalibrationContext(processId: 7, windowId: 9,
            frame: CGRect(x: 0, y: 0, width: 900, height: 700), version: "4.0.6", build: "29387")
        for movesRow in [false, true] {
            var captures = 0
            let result = await AutomaticSessionCapture.observe(context: { context }, capture: { _ in
                captures += 1
                return self.window(rows: [movesRow && captures > 1 ? 266 : 130], markers: captures == 1)
            }, recognize: { _ in Name(text: "旧会话", confidence: 1) })
            XCTAssertEqual(captures, 1, "一次观察只能采集一帧")
            XCTAssertEqual(result["ok"] as? Bool, true)
            XCTAssertEqual(result["display_name"] as? String, "旧会话")
        }
    }

    // 直接按截图行序绘制合成窗口；不读取真实屏幕或调用 Vision。
    func window(width: Int = 900, height: Int = 700, scale: Int = 1,
                divider: Int = 270, rows: [Int] = [62], dark: Bool = false, railLine: Bool = true, markers: Bool = false) -> CGImage {
        let w = width * scale, h = height * scale
        var bytes = [UInt8](repeating: 255, count: w * h * 4)
        for y in 0..<h { for x in 0..<w {
            let px = x / scale, py = y / scale
            var value: UInt8 = dark ? 35 : 237
            if px >= 60 && px < divider { value = dark ? 42 : 245 }
            if px >= 60 && px < divider && rows.contains(where: { py >= $0 && py < $0 + 68 }) { value = dark ? 65 : 215 }
            if (railLine && px == 60) || px == divider || (px >= divider && py == 62) { value = dark ? 95 : 180 }
            let i = (y*w+x)*4
            bytes[i] = value; bytes[i+1] = value; bytes[i+2] = value
            if markers {
                if (divider+20..<divider+25).contains(px) && (24..<29).contains(py) { bytes[i] = 255; bytes[i+1] = 0; bytes[i+2] = 0 }
                if (118..<123).contains(px) && (rows[0]+12..<rows[0]+17).contains(py) { bytes[i] = 0; bytes[i+1] = 0; bytes[i+2] = 255 }
                if px > divider+50 && (300..<350).contains(py) { bytes[i] = 0; bytes[i+1] = 255; bytes[i+2] = 0 }
            }
        } }
        let data = Data(bytes) as CFData
        return CGImage(width: w, height: h, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: w*4,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
            provider: CGDataProvider(data: data)!, decode: nil, shouldInterpolate: false, intent: .defaultIntent)!
    }
}
