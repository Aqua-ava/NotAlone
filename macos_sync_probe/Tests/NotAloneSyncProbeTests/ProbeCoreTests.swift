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

    func testSelectedRowDetectorFindsHighlightBand() {
        let image = syntheticWindowImage(dividerX: 72, selectedRowY: 90)
        let row = SelectedSessionLocator.detectSelectedRow(in: image, dividerX: 72)

        XCTAssertNotNil(row)
        XCTAssertEqual(Double(row?.rowRect.minY ?? 0), 90, accuracy: 2)
        XCTAssertEqual(Double(row?.rowRect.height ?? 0), 30, accuracy: 2)
        XCTAssertEqual(row?.rowRect.width, 72)
    }

    func testSelectedRowDetectorFollowsMovedHighlight() {
        let image = syntheticWindowImage(dividerX: 72, selectedRowY: 140)
        let row = SelectedSessionLocator.detectSelectedRow(in: image, dividerX: 72)

        XCTAssertEqual(Double(row?.rowRect.minY ?? 0), 140, accuracy: 2)
    }

    func testSelectedRowDetectorReturnsNilWithoutHighlight() {
        let image = syntheticWindowImage(dividerX: 72)
        XCTAssertNil(SelectedSessionLocator.detectSelectedRow(in: image, dividerX: 72))
    }

    func testSelectedRowCropRectsStayInsideRow() {
        let row = SelectedRowRegion(
            rowRect: CGRect(x: 0, y: 90, width: 72, height: 30)
        )

        for crop in [row.nameRect, row.timeRect, row.previewRect, row.avatarRect] {
            XCTAssertGreaterThanOrEqual(crop.minX, row.rowRect.minX)
            XCTAssertGreaterThanOrEqual(crop.minY, row.rowRect.minY)
            XCTAssertLessThanOrEqual(crop.maxX, row.rowRect.maxX)
            XCTAssertLessThanOrEqual(crop.maxY, row.rowRect.maxY)
            XCTAssertGreaterThan(crop.width, 0)
            XCTAssertGreaterThan(crop.height, 0)
        }
        // 时间裁剪必须落在行的右上角，预览必须落在下半部分。
        XCTAssertGreaterThan(row.timeRect.maxX, row.rowRect.midX)
        XCTAssertGreaterThanOrEqual(row.previewRect.minY, row.rowRect.midY)
    }

    func testDisplayNameCropFollowsRegionBoundaries() {
        let image = syntheticWindowImage(dividerX: 72)
        let region = ChatRegionDetector.detect(in: image)!
        let crop = SelectedSessionLocator.displayNameCrop(in: image, region: region)

        XCTAssertEqual(Double(crop?.minX ?? 0), Double(region.dividerX ?? 0) + 2, accuracy: 3)
        XCTAssertEqual(crop?.minY, 0)
        XCTAssertEqual(Double(crop?.maxY ?? 0), Double(region.headerDividerY ?? 0), accuracy: 0.5)
        XCTAssertLessThan(crop?.maxX ?? 0, CGFloat(image.width))
    }

    func testSelectedSessionMetadataJsonCarriesEvidenceFields() throws {
        let metadata = SelectedSessionMetadata(
            displayName: "合成甲",
            selectedRowName: "合成甲",
            lastTimeText: "19:59",
            previewText: "合成预览"
        )

        let object = metadata.jsonObject()

        XCTAssertEqual(object["display_name"] as? String, "合成甲")
        XCTAssertEqual(object["selected_row_name"] as? String, "合成甲")
        XCTAssertEqual(object["last_time_text"] as? String, "19:59")
        XCTAssertEqual(object["preview_text"] as? String, "合成预览")
    }

    func testSelectedSessionMetadataJsonUsesNullForMissingFields() throws {
        let metadata = SelectedSessionMetadata(
            displayName: nil,
            selectedRowName: nil,
            lastTimeText: nil,
            previewText: nil
        )

        let line = try metadata.jsonLine()
        let parsed = try JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any]

        XCTAssertNotNil(parsed)
        for key in ["display_name", "selected_row_name", "last_time_text", "preview_text"] {
            XCTAssertTrue(parsed?[key] is NSNull, "\(key) 缺失时应为 JSON null。")
        }
    }

    func testFrontSyncStatusReportParsesActiveCycle() {
        let output = """
        sync=enabled
        phase=active
        probe=ok
        wechat_front=yes
        cli=ok
        contact_id=7F6F7796-5395-4C8F-BAE6-43EF606DF7CA
        binding_display=合成甲
        decision=confirmed_active_binding
        batch_messages=3
        """

        let report = FrontSyncStatusReport.parse(statusOutput: output)

        XCTAssertNotNil(report)
        XCTAssertEqual(report?.syncEnabled, true)
        XCTAssertEqual(report?.phase, "active")
        XCTAssertEqual(report?.wechatInFront, true)
        XCTAssertEqual(report?.cliAvailable, true)
        XCTAssertEqual(report?.bindingDisplay, "合成甲")
        XCTAssertEqual(report?.batchMessages, 3)
        XCTAssertEqual(report?.candidates, [])
    }

    func testFrontSyncStatusReportParsesCandidatesWithEmojiDisplay() {
        let output = """
        sync=enabled
        phase=unavailable
        probe=ok
        wechat_front=yes
        cli=ok
        decision=ambiguous_requires_selection
        batch_messages=0
        candidate[1] username=wxid_one display=FSM💕 cxk last_active=1787486383
        candidate[2] username=wxid_two display=FSM💕 cxk last_active=unknown
        """

        let report = FrontSyncStatusReport.parse(statusOutput: output)

        XCTAssertEqual(report?.candidates.count, 2)
        XCTAssertEqual(report?.candidates.first?.username, "wxid_one")
        XCTAssertEqual(report?.candidates.first?.displayName, "FSM💕 cxk")
        XCTAssertEqual(report?.candidates.last?.username, "wxid_two")
    }

    func testFrontSyncStatusReportFailsClosedOnGarbageOutput() {
        XCTAssertNil(FrontSyncStatusReport.parse(statusOutput: ""))
        XCTAssertNil(FrontSyncStatusReport.parse(statusOutput: "探针失败：无法运行。"))
        // 缺少必备字段（batch_messages）时失败关闭。
        XCTAssertNil(FrontSyncStatusReport.parse(statusOutput: "sync=enabled\nphase=active"))
    }

    func testFrontSyncStatusReportParsesFailureCode() {
        let output = """
        sync=enabled
        phase=failed
        probe=ok
        wechat_front=yes
        cli=unavailable
        failure=cli_not_found
        batch_messages=0
        """

        let report = FrontSyncStatusReport.parse(statusOutput: output)

        XCTAssertEqual(report?.phase, "failed")
        XCTAssertEqual(report?.cliAvailable, false)
        XCTAssertEqual(report?.failureCode, "cli_not_found")
    }

    func testContactListParserKeepsEmojiAndSpaces() {
        let output = """
        contact_id=7f6f7796-5395-4c8f-bae6-43ef606df7ca display_name=FSM💕 cxk
        contact_id=11111111-1111-1111-1111-111111111111 display_name=合成乙
         unrelated line
        """

        let entries = FrontSyncContactEntry.parseList(output)

        XCTAssertEqual(entries.count, 2)
        XCTAssertEqual(entries.first?.contactId, "7f6f7796-5395-4c8f-bae6-43ef606df7ca")
        XCTAssertEqual(entries.first?.displayName, "FSM💕 cxk")
        XCTAssertEqual(entries.last?.displayName, "合成乙")
    }

    private func syntheticWindowImage(
        dividerX: Int?,
        hasStrongerLowerEdge: Bool = false,
        selectedRowY: Int? = nil
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
            if let selectedRowY {
                // 选中会话行的高亮带：亮度明显高于左侧面板背景。
                // CGContext 纵坐标从底部向上，先换算成截图像素行。
                context.setFillColor(CGColor(red: 0.40, green: 0.40, blue: 0.40, alpha: 1))
                context.fill(CGRect(x: 0, y: height - selectedRowY - 30, width: dividerX, height: 30))
            }
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
