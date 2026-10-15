import AppKit
import XCTest
@testable import NotAloneSyncCore

final class SessionNamePreviewTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_000)

    private func result(_ name: String) -> [String: Any] {
        ["ok": true, "wechat_in_front": true, "capture_version": "preview-header-v1",
         "captured_at": "1970-01-01T00:16:39.000Z", "header_text": name, "header_confidence": 0.99]
    }

    func testDisplaysActualRecognizedNameAndChangesWithoutAnExpectedName() {
        let first = SessionNamePreviewReading(result: result("合成甲"), now: now)
        let second = SessionNamePreviewReading(result: result("合成乙"), now: now)
        XCTAssertEqual(first.name, "合成甲")
        XCTAssertEqual(second.name, "合成乙")
        XCTAssertEqual(first.kind, .recognized)
        XCTAssertEqual(second.headline, "识别到：合成乙")
    }

    func testRawHeaderTextAndConfidenceAreVisibleWithoutRowOrIdentityConfirmation() {
        var raw = result("合成甲")
        raw["header_confidence"] = 0.65
        let reading = SessionNamePreviewReading(result: raw, now: now)
        XCTAssertEqual(reading.name, "合成甲")
        XCTAssertEqual(reading.kind, .recognized)
        XCTAssertTrue(reading.detail.contains("65%"))
        XCTAssertFalse(reading.detail.contains("确认"))
    }

    func testPauseFailureStaleAndInvalidResultsNeverDisplayAName() {
        var invalid = result("合成甲")
        invalid["header_confidence"] = Double.nan
        var old = result("合成甲")
        old["captured_at"] = "1970-01-01T00:16:00.000Z"
        var legacy = result("合成甲")
        legacy["capture_version"] = "automatic-window-v2"
        for value in [invalid, old, legacy,
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

    @MainActor
    func testResultTextActuallyDrawsIntoTheNameAreaWithoutAWindow() throws {
        let view = SessionNamePreviewTextView(frame: NSRect(x: 0, y: 0, width: 492, height: 150))
        view.update(headline: "识别到：合成甲", detail: "OCR 置信度：65%")
        let bitmap = try XCTUnwrap(NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 492,
            pixelsHigh: 150, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
            isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0))
        let context = try XCTUnwrap(NSGraphicsContext(bitmapImageRep: bitmap))
        NSGraphicsContext.saveGraphicsState()
        context.cgContext.translateBy(x: 0, y: 150)
        context.cgContext.scaleBy(x: 1, y: -1)
        NSGraphicsContext.current = NSGraphicsContext(cgContext: context.cgContext, flipped: true)
        view.draw(view.bounds)
        NSGraphicsContext.restoreGraphicsState()
        // 比较标题区与空白背景，避免只测 stringValue 却漏掉实际未绘制的名称。
        let background = try XCTUnwrap(bitmap.colorAt(x: 490, y: 1)?.usingColorSpace(.deviceRGB))
        var titlePixels = 0
        for y in 5..<70 {
            for x in 0..<400 {
                let color = try XCTUnwrap(bitmap.colorAt(x: x, y: y)?.usingColorSpace(.deviceRGB))
                if abs(color.redComponent - background.redComponent) > 0.1 { titlePixels += 1 }
            }
        }
        XCTAssertGreaterThan(titlePixels, 100)
        if let path = ProcessInfo.processInfo.environment["NOTALONE_SESSION_NAME_PREVIEW_SYNTHETIC_PNG"] {
            try XCTUnwrap(bitmap.representation(using: .png, properties: [:])).write(to: URL(fileURLWithPath: path))
        }
    }
}
