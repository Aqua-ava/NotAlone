import CoreGraphics
import XCTest
@testable import NotAloneSyncCore

final class ProbeCoreTests: XCTestCase {
    func testNormalizerCollapsesWhitespace() {
        XCTAssertEqual(TextNormalizer.normalize("  今天   下雨\n"), "今天 下雨")
    }

    func testCropRejectsOutOfBoundsValues() {
        XCTAssertThrowsError(try CropRect(x: 0.7, y: 0.1, width: 0.4, height: 0.8))
    }

    func testDeduplicatorKeepsOnlyNewLines() {
        var deduplicator = LineDeduplicator()
        let first = RecognizedLine(text: "你好", speaker: .contact, confidence: 0.9)
        let duplicate = RecognizedLine(text: "  你好  ", speaker: .contact, confidence: 0.8)
        let newLine = RecognizedLine(text: "明天见", speaker: .user, confidence: 0.9)

        XCTAssertEqual(deduplicator.newLines(from: [first]), [first])
        XCTAssertEqual(deduplicator.newLines(from: [duplicate, newLine]), [newLine])
    }

    func testDeduplicatorSeparatesSpeakers() {
        var deduplicator = LineDeduplicator()
        let contactLine = RecognizedLine(text: "好的", speaker: .contact, confidence: 0.9)
        let userLine = RecognizedLine(text: "好的", speaker: .user, confidence: 0.9)

        XCTAssertEqual(deduplicator.newLines(from: [contactLine, userLine]), [contactLine, userLine])
    }

    func testChatRegionDetectorFollowsMovedDivider() {
        let firstImage = syntheticWindowImage(dividerX: 72)
        let secondImage = syntheticWindowImage(dividerX: 126)

        let firstRegion = ChatRegionDetector.detect(in: firstImage)
        let secondRegion = ChatRegionDetector.detect(in: secondImage)

        XCTAssertNotNil(firstRegion)
        XCTAssertNotNil(secondRegion)
        XCTAssertEqual(Double(firstRegion?.dividerX ?? 0), 72, accuracy: 3)
        XCTAssertEqual(Double(secondRegion?.dividerX ?? 0), 126, accuracy: 3)
        XCTAssertEqual(Double(firstRegion?.headerDividerY ?? 0), 30, accuracy: 3)
        XCTAssertEqual(Double(firstRegion?.composerDividerY ?? 0), 145, accuracy: 3)
        XCTAssertGreaterThan(firstRegion?.cropRect.minY ?? 0, 30)
        XCTAssertLessThan(firstRegion?.cropRect.maxY ?? 0, 145)
        XCTAssertGreaterThan(firstRegion?.cropRect.minX ?? 0, 72)
        XCTAssertGreaterThan(secondRegion?.cropRect.minX ?? 0, 126)
    }

    func testCachedDividerValidationAvoidsFullRescanUntilMoved() {
        let originalImage = syntheticWindowImage(dividerX: 72)
        let movedImage = syntheticWindowImage(dividerX: 126)

        let originalRegion = ChatRegionDetector.detect(in: originalImage)!
        XCTAssertTrue(ChatRegionDetector.isRegionStillValid(in: originalImage, region: originalRegion))
        XCTAssertFalse(ChatRegionDetector.isRegionStillValid(in: movedImage, region: originalRegion))
    }

    func testChatRegionDetectorRejectsImageWithoutDivider() {
        XCTAssertNil(ChatRegionDetector.detect(in: syntheticWindowImage(dividerX: nil)))
    }

    func testComposerPrefersFirstReliableBoundaryOverStrongerLowerEdge() {
        let image = syntheticWindowImage(dividerX: 72, hasStrongerLowerEdge: true)
        let region = ChatRegionDetector.detect(in: image)

        XCTAssertEqual(Double(region?.headerDividerY ?? 0), 30, accuracy: 3)
        XCTAssertEqual(Double(region?.composerDividerY ?? 0), 145, accuracy: 3)
        XCTAssertTrue(ChatRegionDetector.isRegionStillValid(in: image, region: region!))
    }

    func testPreviewDrawingRectMirrorsOnlyVerticalCoordinate() {
        let cropRect = CGRect(x: 72, y: 30, width: 220, height: 115)
        let previewRect = ChatRegionDetector.previewDrawingRect(
            for: cropRect,
            imageHeight: 200
        )

        XCTAssertEqual(previewRect.minX, 72)
        XCTAssertEqual(previewRect.width, 220)
        XCTAssertEqual(previewRect.minY, 55)
        XCTAssertEqual(previewRect.height, 115)
        XCTAssertEqual(
            ChatRegionDetector.previewDrawingY(forImageRow: 30, imageHeight: 200),
            170
        )
        XCTAssertEqual(
            ChatRegionDetector.previewDrawingY(forImageRow: 145, imageHeight: 200),
            55
        )
    }

    private func syntheticWindowImage(
        dividerX: Int?,
        hasStrongerLowerEdge: Bool = false
    ) -> CGImage {
        let width = 300
        let height = 200
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        let context = CGContext(
            data: nil,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: width * 4,
            space: colorSpace,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        )!

        context.setFillColor(CGColor(red: 0.12, green: 0.12, blue: 0.12, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        if let dividerX {
            context.setFillColor(CGColor(red: 0.27, green: 0.27, blue: 0.27, alpha: 1))
            context.fill(CGRect(x: 0, y: 0, width: dividerX, height: height))
            context.setFillColor(CGColor(red: 0.20, green: 0.20, blue: 0.20, alpha: 1))
            context.fill(CGRect(x: dividerX, y: height - 30, width: width - dividerX, height: 30))
            context.fill(CGRect(x: dividerX, y: 0, width: width - dividerX, height: 55))
            if hasStrongerLowerEdge {
                // 更靠下的窗口边缘对比更强，但不应被误当成输入区顶线。
                context.setFillColor(CGColor(red: 0.04, green: 0.04, blue: 0.04, alpha: 1))
                context.fill(CGRect(x: dividerX, y: 0, width: width - dividerX, height: 20))
            }
        }
        return context.makeImage()!
    }
}
