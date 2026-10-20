import CoreGraphics
import CoreText
import Darwin
import Foundation
import XCTest
@testable import NotAloneSyncCore

// 只在显式提供端侧私有语料时运行；名称和生成图像不进入普通测试日志。
final class HeaderOCRCorpusTests: XCTestCase {
    @MainActor
    func testScanExplicitPrivateCorpus() throws {
        let environment = ProcessInfo.processInfo.environment
        guard let inputPath = environment["NOTALONE_HEADER_OCR_SCAN_INPUT"], !inputPath.isEmpty,
              let outputPath = environment["NOTALONE_HEADER_OCR_SCAN_OUTPUT"], !outputPath.isEmpty else {
            throw XCTSkip("未指定私有名称语料与结果路径，跳过真实 Vision 扫描")
        }
        let inputURL = URL(fileURLWithPath: inputPath)
        let outputURL = URL(fileURLWithPath: outputPath)
        try requirePrivateInput(inputURL)
        try requirePrivateDirectory(outputURL.deletingLastPathComponent())
        guard !FileManager.default.fileExists(atPath: outputURL.path) else {
            throw ScanFailure.outputAlreadyExists
        }
        let corpus = try JSONDecoder().decode(Corpus.self, from: Data(contentsOf: inputURL))
        let font = CTFontCreateWithName("PingFangSC-Medium" as CFString, 14, nil)
        guard CTFontCopyPostScriptName(font) as String == "PingFangSC-Medium" else {
            throw ScanFailure.fontUnavailable
        }
        let fontVersion = CTFontCopyName(font, kCTFontVersionNameKey) as String? ?? "unknown"
        var results: [[String: Any]] = []
        var classifications: [String: Int] = [:]
        var chatTypes: [String: [String: Int]] = [:]
        var tagCounts: [String: [String: Int]] = [:]
        var lengthBuckets: [String: [String: Int]] = [:]
        let started = Date()

        for (index, item) in corpus.cases.enumerated() {
            let name = item.name ?? ""
            let tags = textTags(name)
            let lengthBucket = lengthBucket(name.count)
            for scale in [1, 2] {
                let result: [String: Any] = try autoreleasepool {
                    var record: [String: Any] = [
                        "id": item.id, "name": item.name as Any? ?? NSNull(), "chatType": item.chatType,
                        "variant": "header_\(scale)x", "tags": tags, "characterCount": name.count,
                        "utf8Length": name.utf8.count, "lengthBucket": lengthBucket,
                        "pixelSize": ["width": 400 * scale, "height": 36 * scale],
                    ]
                    guard !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                        record.merge(["text": "", "confidence": 0.0, "isComplete": false,
                                      "utf8Exact": false, "classification": "invalid_name"]) { _, new in new }
                        return record
                    }
                    let frame = try render(name, font: font, scale: scale)
                    record["renderedTextWidthPoints"] = frame.textWidth
                    record["renderClipped"] = frame.textWidth > 392
                    do {
                        let recognition = try LocalOcr.recognizeHeader(frame.image)
                        let exact = Array(recognition.text.utf8) == Array(name.utf8)
                        let classification: String
                        if recognition.text.isEmpty { classification = "empty" }
                        else if !recognition.isComplete { classification = "incomplete" }
                        else if exact { classification = recognition.confidence >= 0.90 ? "exact_high" : "exact_low" }
                        else { classification = recognition.confidence >= 0.90 ? "mismatch_high" : "mismatch_low" }
                        record.merge([
                            "text": recognition.text,
                            "confidence": recognition.confidence.isFinite ? recognition.confidence as Any : NSNull(),
                            "isComplete": recognition.isComplete, "utf8Exact": exact,
                            "classification": classification,
                        ]) { _, new in new }
                        if let fallback = recognition.textFallback {
                            record["textFallback"] = fallback.protocolValue
                        }
                    } catch {
                        // 错误只记固定类别，避免系统错误描述意外包含私有输入。
                        record.merge(["text": "", "confidence": 0.0, "isComplete": false,
                                      "utf8Exact": false, "classification": "recognition_error"]) { _, new in new }
                    }
                    return record
                }
                let classification = result["classification"] as! String
                classifications[classification, default: 0] += 1
                chatTypes[item.chatType, default: [:]][classification, default: 0] += 1
                lengthBuckets[lengthBucket, default: [:]][classification, default: 0] += 1
                for tag in tags { tagCounts[tag, default: [:]][classification, default: 0] += 1 }
                results.append(result)
            }
            if (index + 1).isMultiple(of: 50) {
                print("Header OCR corpus progress: \(index + 1)/\(corpus.cases.count) cases")
                fflush(stdout)
            }
        }

        let output: [String: Any] = [
            "schemaVersion": 1, "caseCount": corpus.cases.count, "observationCount": results.count,
            "elapsedSeconds": Date().timeIntervalSince(started),
            "render": ["font": CTFontCopyPostScriptName(font) as String, "fontVersion": fontVersion,
                       "pointSize": 14, "cropPoints": ["width": 400, "height": 36],
                       "scales": [1, 2], "backgroundRGB": [0.929, 0.929, 0.929],
                       "textRGB": [0.08, 0.08, 0.08], "horizontalPaddingPoints": 8,
                       "rawImagesSaved": false],
            "runtime": ["os": ProcessInfo.processInfo.operatingSystemVersionString,
                        "recognizer": "LocalOcr.recognizeHeader", "realWindowCapture": false],
            "summary": ["classification": classifications, "chatType": chatTypes,
                        "tags": tagCounts, "lengthBucket": lengthBuckets],
            "results": results,
        ]
        let data = try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys, .prettyPrinted])
        try writePrivateOutput(data, to: outputURL)
        let summary = classifications.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator: ", ")
        print("Header OCR corpus complete: \(corpus.cases.count) cases, \(results.count) observations; \(summary)")
        XCTAssertEqual(results.count, corpus.cases.count * 2)
    }

    private struct Corpus: Decodable { let cases: [Case] }
    private struct Case: Decodable { let id: Int; let name: String?; let chatType: String }
    private enum ScanFailure: Error {
        case inputNotPrivate, directoryNotPrivate, outputAlreadyExists, fontUnavailable, imageUnavailable, outputUnavailable
    }

    private func render(_ name: String, font: CTFont, scale: Int) throws -> (image: CGImage, textWidth: Double) {
        let width = 400 * scale, height = 36 * scale
        guard let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
              let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8,
                                      bytesPerRow: width * 4, space: colorSpace,
                                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
                                          | CGBitmapInfo.byteOrder32Big.rawValue) else {
            throw ScanFailure.imageUnavailable
        }
        context.setFillColor(red: 0.929, green: 0.929, blue: 0.929, alpha: 1)
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        context.scaleBy(x: CGFloat(scale), y: CGFloat(scale))
        context.setShouldAntialias(true)
        let attributes: [NSAttributedString.Key: Any] = [
            NSAttributedString.Key(kCTFontAttributeName as String): font,
            NSAttributedString.Key(kCTForegroundColorAttributeName as String):
                CGColor(red: 0.08, green: 0.08, blue: 0.08, alpha: 1),
        ]
        let line = CTLineCreateWithAttributedString(NSAttributedString(string: name, attributes: attributes))
        let textWidth = CTLineGetTypographicBounds(line, nil, nil, nil)
        let baseline = (36 - CTFontGetAscent(font) - CTFontGetDescent(font)) / 2 + CTFontGetDescent(font)
        context.textMatrix = .identity
        context.textPosition = CGPoint(x: 8, y: baseline)
        CTLineDraw(line, context)
        guard let image = context.makeImage() else { throw ScanFailure.imageUnavailable }
        return (image, textWidth)
    }

    private func textTags(_ name: String) -> [String] {
        let scalars = name.unicodeScalars
        var tags: [String] = []
        if scalars.contains(where: { $0.properties.isEmojiPresentation || ($0.properties.isEmoji && $0.value > 0x7f) }) {
            tags.append("emoji")
        }
        if scalars.contains(where: { (0x3400...0x4DBF).contains($0.value) || (0x4E00...0x9FFF).contains($0.value)
            || (0xF900...0xFAFF).contains($0.value) || (0x20000...0x323AF).contains($0.value) }) { tags.append("CJK") }
        if scalars.contains(where: { (0x41...0x5A).contains($0.value) || (0x61...0x7A).contains($0.value)
            || (0xC0...0x24F).contains($0.value) || (0x1E00...0x1EFF).contains($0.value) }) { tags.append("Latin") }
        if scalars.contains(where: { CharacterSet.decimalDigits.contains($0) }) { tags.append("digits") }
        if scalars.contains(where: { CharacterSet.punctuationCharacters.contains($0) }) { tags.append("punctuation") }
        if scalars.contains(where: { CharacterSet.whitespacesAndNewlines.contains($0) }) { tags.append("whitespace") }
        if tags.isEmpty { tags.append("other") }
        return tags
    }

    private func lengthBucket(_ length: Int) -> String {
        switch length {
        case 0: "0"
        case 1...2: "1-2"
        case 3...5: "3-5"
        case 6...10: "6-10"
        case 11...20: "11-20"
        case 21...40: "21-40"
        default: "41+"
        }
    }

    private func requirePrivateInput(_ url: URL) throws {
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        guard attributes[.type] as? FileAttributeType == .typeRegular,
              attributes[.posixPermissions] as? Int == 0o600,
              attributes[.ownerAccountID] as? Int == Int(getuid()) else { throw ScanFailure.inputNotPrivate }
    }

    private func requirePrivateDirectory(_ url: URL) throws {
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        guard attributes[.type] as? FileAttributeType == .typeDirectory,
              attributes[.posixPermissions] as? Int == 0o700,
              attributes[.ownerAccountID] as? Int == Int(getuid()) else { throw ScanFailure.directoryNotPrivate }
    }

    private func writePrivateOutput(_ data: Data, to url: URL) throws {
        let descriptor = open(url.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
        guard descriptor >= 0 else { throw ScanFailure.outputUnavailable }
        let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        try handle.write(contentsOf: data)
        try handle.synchronize()
        try handle.close()
    }
}
