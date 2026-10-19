import CoreGraphics
import XCTest
@testable import NotAloneSyncCore

final class HeaderOcrResultTests: XCTestCase {
    func testSingleLineFragmentsUseHorizontalOrderDespiteDifferentGlyphHeights() {
        let left = fragment("ABCQ", confidence: 0.5,
            box: CGRect(x: 0.02, y: 0.25, width: 0.1075, height: 0.41666667))
        let right = fragment("xyz", confidence: 0.95,
            box: CGRect(x: 0.1275, y: 0.30555556, width: 0.075, height: 0.36111111))
        for fragments in [[right, left], [left, right]] {
            let result = HeaderOcrResult(fragments: fragments)
            XCTAssertEqual(result.text, "ABCQ xyz")
            XCTAssertTrue(result.isComplete)
            XCTAssertEqual(result.confidence, 0.5, "排序不应提高原始识别分数")
        }
    }

    func testSeparateRowsAndChainedVerticalOverlapDoNotClaimCompleteNames() {
        let cases = [
            [fragment("上行", box: CGRect(x: 0.1, y: 0.6, width: 0.2, height: 0.2)),
             fragment("下行", box: CGRect(x: 0.4, y: 0.2, width: 0.2, height: 0.2))],
            [fragment("甲", box: CGRect(x: 0.1, y: 0.2, width: 0.1, height: 0.4)),
             fragment("乙", box: CGRect(x: 0.3, y: 0.35, width: 0.1, height: 0.4)),
             fragment("丙", box: CGRect(x: 0.5, y: 0.5, width: 0.1, height: 0.4))],
        ]
        for fragments in cases {
            let result = HeaderOcrResult(fragments: fragments)
            XCTAssertFalse(result.isComplete)
            XCTAssertEqual(result.text, fragments.map { $0.0.text }.joined(separator: " "),
                "不可靠几何仍保留原始文字供确认")
        }
    }

    func testOverlappingOrInvalidBoxesDoNotClaimCompleteNames() {
        let valid = fragment("甲", box: CGRect(x: 0.1, y: 0.2, width: 0.3, height: 0.4))
        for box in [CGRect(x: 0.2, y: 0.2, width: 0.3, height: 0.4),
                    CGRect(x: .nan, y: 0.2, width: 0.1, height: 0.4),
                    CGRect(x: 0.5, y: .infinity, width: 0.1, height: 0.4),
                    CGRect(x: 0.5, y: 0.2, width: 0, height: 0.4),
                    CGRect(x: 0.5, y: 0.2, width: 0.1, height: -0.4)] {
            let result = HeaderOcrResult(fragments: [valid, fragment("乙", box: box)])
            XCTAssertFalse(result.isComplete)
            XCTAssertEqual(result.text, "甲 乙")
        }
    }

    func testOriginalTextAndCropBoundariesStillControlCompleteness() {
        let validBox = CGRect(x: 0.1, y: 0.2, width: 0.3, height: 0.4)
        for text in ["", "甲\n乙", "甲\r乙", "甲…", "甲...", String(repeating: "甲", count: 257)] {
            XCTAssertFalse(HeaderOcrResult(fragments: [fragment(text, box: validBox)]).isComplete)
        }
        XCTAssertTrue(HeaderOcrResult(fragments: [fragment(String(repeating: "甲", count: 256), box: validBox)]).isComplete)
        XCTAssertFalse(HeaderOcrResult(fragments: []).isComplete)
        for box in [CGRect(x: 0.01, y: 0.2, width: 0.3, height: 0.4),
                    CGRect(x: 0.69, y: 0.2, width: 0.3, height: 0.4),
                    CGRect(x: 0.1, y: 0.01, width: 0.3, height: 0.4),
                    CGRect(x: 0.1, y: 0.59, width: 0.3, height: 0.4)] {
            XCTAssertFalse(HeaderOcrResult(fragments: [fragment("甲", box: box)]).isComplete)
        }
    }

    private func fragment(_ text: String, confidence: Float = 0.99,
                          box: CGRect) -> (RecognizedLine, CGRect) {
        (RecognizedLine(text: text, speaker: .unknown, confidence: confidence), box)
    }
}
