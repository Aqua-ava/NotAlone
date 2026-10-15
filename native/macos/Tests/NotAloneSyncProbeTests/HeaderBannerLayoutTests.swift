import CoreGraphics
import XCTest
@testable import NotAloneSyncCore

final class HeaderBannerLayoutTests: XCTestCase {
    @MainActor
    func testSingleBannerBelowTitleStillObservesOnlyTheHeaderName() async {
        let context = CalibrationContext(processId: 7, windowId: 9,
            frame: CGRect(x: 0, y: 0, width: 900, height: 700), version: "4.0.6", build: "29387")
        var ocrCalls = 0
        let result = await AutomaticSessionCapture.observeHeader(context: { context },
            capture: { _ in self.window(boundaries: [96]) }, recognize: { header in
                ocrCalls += 1
                self.assertOnlyTitle(header, scale: 1)
                return HeaderOcrResult(fragments: [(RecognizedLine(text: "合成标题（28）", speaker: .unknown, confidence: 0.99),
                    CGRect(x: 0.1, y: 0.2, width: 0.6, height: 0.6))])
            })
        XCTAssertEqual(result["ok"] as? Bool, true, "\(result["error"] ?? "unknown")")
        XCTAssertEqual(ocrCalls, 1)
        XCTAssertEqual(result["display_name"] as? String, "合成标题（28）")
    }

    @MainActor
    func testOrdinaryAndBannerHeadersKeepNameCropAcrossThemesSizesAndScales() async {
        for scale in [1, 2, 3] { for dark in [false, true] { for boundary in [62, 96] {
            let size = scale == 3 ? CGSize(width: 600, height: 400) : CGSize(width: 900, height: 700)
            let context = CalibrationContext(processId: 7, windowId: 9,
                frame: CGRect(origin: CGPoint(x: 83, y: 107), size: size), version: "4.0.6", build: "29387")
            let result = await AutomaticSessionCapture.observeHeader(context: { context },
                capture: { _ in self.window(boundaries: [boundary], size: size, scale: scale, dark: dark) },
                recognize: { header in
                    self.assertOnlyTitle(header, scale: scale)
                    return HeaderOcrResult(fragments: [(RecognizedLine(text: "合成私聊", speaker: .unknown, confidence: 0.99),
                        CGRect(x: 0.1, y: 0.2, width: 0.6, height: 0.6))])
                })
            XCTAssertEqual(result["ok"] as? Bool, true, "scale=\(scale), dark=\(dark), boundary=\(boundary)")
        } } }
    }

    @MainActor
    func testNarrowWindowBodyBubbleEdgeCannotReplaceTheFullWidthHeaderEdge() async {
        for scale in [1, 2] { for dark in [false, true] {
            let size = CGSize(width: 726, height: 841)
            let context = CalibrationContext(processId: 7, windowId: 9,
                frame: CGRect(origin: .zero, size: size), version: "4.0.6", build: "29387")
            var calls = 0
            let result = await AutomaticSessionCapture.observeHeader(context: { context },
                capture: { _ in self.window(boundaries: [62], size: size, scale: scale,
                                           dark: dark, bodyBubble: true) }, recognize: { header in
                    calls += 1
                    self.assertOnlyTitle(header, scale: scale)
                    return HeaderOcrResult(fragments: [(RecognizedLine(text: "合成私聊", speaker: .unknown, confidence: 0.99),
                        CGRect(x: 0.1, y: 0.2, width: 0.6, height: 0.6))])
                })
            XCTAssertEqual(result["ok"] as? Bool, true, "\(result["error"] ?? "unknown")")
            XCTAssertEqual(calls, 1)
        } }
    }

    @MainActor
    func testMissingAmbiguousOrOutOfRangeHeaderEdgesNeverReachOCR() async {
        for (boundaries, bubble) in [([], false), ([], true), ([62, 96], false), ([125], false)] {
            let size = bubble ? CGSize(width: 726, height: 841) : CGSize(width: 900, height: 700)
            let context = CalibrationContext(processId: 7, windowId: 9,
                frame: CGRect(origin: .zero, size: size), version: "4.0.6", build: "29387")
            let result = await AutomaticSessionCapture.observeHeader(context: { context },
                capture: { _ in self.window(boundaries: boundaries, size: size, bodyBubble: bubble) }, recognize: { _ in
                    XCTFail("缺失、歧义或范围外边界不能进入OCR")
                    return HeaderOcrResult(fragments: [])
                })
            XCTAssertEqual(result["ok"] as? Bool, false)
            XCTAssertEqual(result["stage"] as? String, "layout")
            XCTAssertEqual(result["error"] as? String, "automatic_layout_header_boundary")
            XCTAssertNil(result["display_name"])
        }
    }

    private func assertOnlyTitle(_ image: CGImage, scale: Int) {
        XCTAssertEqual(image.height, 36 * scale)
        XCTAssertLessThanOrEqual(image.width, 400 * scale)
        let data = image.dataProvider!.data! as Data
        var title = false, outside = false
        for y in 0..<image.height { for x in 0..<image.width {
            let i = y * image.bytesPerRow + x * 4
            title = title || (data[i] == 255 && data[i + 1] == 0 && data[i + 2] == 0)
            outside = outside || (data[i] == 0 && data[i + 1] == 255 && data[i + 2] == 0)
        } }
        XCTAssertTrue(title, "标题哨兵必须进入OCR区域")
        XCTAssertFalse(outside, "提示条或正文不得送入OCR")
    }

    // 仅合成亮度边界及颜色哨兵，不包含真实界面或调用Vision。
    private func window(boundaries: [Int], size: CGSize = CGSize(width: 900, height: 700),
                        scale: Int = 1, dark: Bool = false, bodyBubble: Bool = false) -> CGImage {
        let w = Int(size.width) * scale, h = Int(size.height) * scale
        var bytes = [UInt8](repeating: 255, count: w * h * 4)
        for y in 0..<h { for x in 0..<w {
            let px = x / scale, py = y / scale
            let value: UInt8 = px < 270 ? (dark ? 42 : 245) : (dark ? 35 : 237)
            let i = (y * w + x) * 4
            let edge = px == 270 || (px >= 270 && boundaries.contains(py))
            bytes[i] = edge ? (dark ? 95 : 180) : value
            bytes[i + 1] = bytes[i]; bytes[i + 2] = bytes[i]
            // 窄窗气泡覆盖聊天区过半，但不能作为贯穿聊天区的顶部边界。
            if bodyBubble && (Int(size.width)-310..<Int(size.width)-40).contains(px)
                && (75..<98).contains(py) {
                bytes[i] = dark ? 180 : 100; bytes[i + 1] = bytes[i]; bytes[i + 2] = bytes[i]
            }
            if (290..<295).contains(px) && (24..<29).contains(py) {
                bytes[i] = 255; bytes[i + 1] = 0; bytes[i + 2] = 0
            }
            if (290..<295).contains(px) && ((55..<85).contains(py) || (150..<200).contains(py)) {
                bytes[i] = 0; bytes[i + 1] = 255; bytes[i + 2] = 0
            }
        } }
        return CGImage(width: w, height: h, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: w * 4,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
            provider: CGDataProvider(data: Data(bytes) as CFData)!, decode: nil, shouldInterpolate: false, intent: .defaultIntent)!
    }
}
