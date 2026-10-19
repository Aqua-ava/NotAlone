import CoreGraphics
import CoreText
import XCTest
@testable import NotAloneSyncCore

final class HeaderTextFallbackTests: XCTestCase {
    func testProductionOCRRecoversTextBeforeAnIsolatedColoredTailWithoutReplacingRawResult() throws {
        for scale in [1, 2] {
            let image = try title("合成🐯", scale: scale)
            let raw = try LocalOcr.recognize(image)
            let result = try LocalOcr.recognizeHeader(image)
            XCTAssertEqual(result.text, raw.map(\.text).joined(separator: " "))
            XCTAssertEqual(result.confidence, Double(raw.map(\.confidence).min() ?? 0))
            let fallback = try XCTUnwrap(result.textFallback, "比例 \(scale) 应产生独立文字候选")
            XCTAssertEqual(fallback.text, "合成")
            XCTAssertGreaterThanOrEqual(fallback.confidence, 0.9)
            XCTAssertTrue(fallback.textComplete)
            XCTAssertTrue(fallback.maskVerified)
        }
    }

    func testGeometryRejectsInteriorColorPureColorEdgesMultilineAndIncompleteRawNames() throws {
        let cases: [(String, CGFloat, [String])] = [
            ("合🐯成", 10, []), ("🐯", 10, []), ("合成🐯", 0, []),
            ("合成🐯", 10, ["额外文字"]), ("合成…🐯", 10, []),
        ]
        for (name, x, extraLines) in cases {
            let result = try LocalOcr.recognizeHeader(title(name, x: x, extraLines: extraLines))
            XCTAssertNil(result.textFallback, "不支持的标题不应产生候选")
        }
        let incomplete = HeaderOcrResult(fragments: [(RecognizedLine(text: "合成…", speaker: .unknown,
            confidence: 0.3), CGRect(x: 0.02, y: 0.2, width: 0.2, height: 0.6))])
        XCTAssertNil(HeaderTextFallbackGeometry.maskedImage(try title("合成🐯"), raw: incomplete))
    }

    func testColoredLettersAreOnlyGeometryCandidatesAndDoNotClaimEmojiIdentity() throws {
        let image = try title("合成 红", coloredTail: "红")
        let result = try LocalOcr.recognizeHeader(image)
        let fallback = try XCTUnwrap(result.textFallback)
        XCTAssertEqual(fallback.text, "合成")
        XCTAssertEqual(fallback.version, "isolated-color-tail-v1")
        XCTAssertTrue(fallback.maskVerified)
    }

    func testInvalidBackgroundAndOversizedColorAreaHaveNoCandidate() throws {
        let raw = HeaderOcrResult(fragments: [(RecognizedLine(text: "合成X", speaker: .unknown,
            confidence: 0.3), CGRect(x: 0.02, y: 0.2, width: 0.2, height: 0.6))])
        XCTAssertNil(HeaderTextFallbackGeometry.maskedImage(try title("合成🐯", tinted: true), raw: raw))
        XCTAssertNil(HeaderTextFallbackGeometry.maskedImage(try title("合成🐯🐯🐯🐯🐯"), raw: raw))
    }

    func testDarkBackgroundProducesOnlyATextCandidate() throws {
        let result = try LocalOcr.recognizeHeader(title("合成🐯", dark: true))
        let fallback = try XCTUnwrap(result.textFallback)
        XCTAssertEqual(fallback.text, "合成")
        XCTAssertGreaterThanOrEqual(fallback.confidence, 0.9)
    }

    func testLiteralPunctuationNumbersAndSpacesAreNotRemoved() throws {
        let result = try LocalOcr.recognizeHeader(title("Nora 12& 🐯"))
        let fallback = try XCTUnwrap(result.textFallback)
        XCTAssertEqual(fallback.text, "Nora 12&")
    }

    private func title(_ text: String, scale: Int = 2, x: CGFloat = 10,
                       extraLines: [String] = [], coloredTail: String? = nil, tinted: Bool = false,
                       dark: Bool = false) throws -> CGImage {
        let width = 400 * scale, height = 36 * scale
        let context = try XCTUnwrap(CGContext(data: nil, width: width, height: height, bitsPerComponent: 8,
            bytesPerRow: width * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue))
        context.scaleBy(x: CGFloat(scale), y: CGFloat(scale))
        context.setFillColor(red: tinted ? 0.75 : (dark ? 0.12 : 0.96),
                             green: dark ? 0.12 : 0.96, blue: dark ? 0.12 : 0.96, alpha: 1)
        context.fill(CGRect(x: 0, y: 0, width: 400, height: 36))
        let font = CTFontCreateWithName("PingFangSC-Medium" as CFString, 14, nil)
        func draw(_ name: String, y: CGFloat) {
            let value = NSMutableAttributedString(string: name, attributes: [
                NSAttributedString.Key(kCTFontAttributeName as String): font,
                NSAttributedString.Key(kCTForegroundColorAttributeName as String): CGColor(gray: dark ? 0.9 : 0.12, alpha: 1),
            ])
            if let coloredTail, name.hasSuffix(coloredTail) {
                value.addAttribute(NSAttributedString.Key(kCTForegroundColorAttributeName as String),
                    value: CGColor(red: 0.85, green: 0.1, blue: 0.12, alpha: 1),
                    range: (name as NSString).range(of: coloredTail, options: .backwards))
            }
            context.textPosition = CGPoint(x: x, y: y)
            CTLineDraw(CTLineCreateWithAttributedString(value), context)
        }
        draw(text, y: extraLines.isEmpty ? 12 : 3)
        for (index, line) in extraLines.enumerated() { draw(line, y: CGFloat(21 + index * 16)) }
        return try XCTUnwrap(context.makeImage())
    }
}
