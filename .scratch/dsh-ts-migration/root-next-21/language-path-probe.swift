// 固定合成名称图；只改变准确模式的语种配置，不采集或保存画面。
import AppKit
import CoreGraphics
import CoreText
import CoreVideo
import CryptoKit
import Darwin
import Foundation
import Vision

private struct ProbeFailure: Error {}

@main
private struct LanguagePathProbe {
    private static let started = ProcessInfo.processInfo.systemUptime
    private static let expected = "合成A1"

    static func main() {
        let arguments = Set(CommandLine.arguments.dropFirst())
        let supportedModes: Set<String> = ["baseline", "zh", "auto", "pixel"]
        guard !arguments.isEmpty, arguments.isSubset(of: supportedModes) else {
            FileHandle.standardError.write(Data("用法：language-path-probe baseline|zh|auto\n".utf8))
            exit(2)
        }
        let mode = arguments.first!
        do {
            let image = try syntheticHeader()
            guard let pixels = image.dataProvider?.data else { throw ProbeFailure() }
            emit("frame_ready", mode: mode, fields: [
                "width": image.width,
                "height": image.height,
                "pixel_sha256": sha256(pixels as Data),
            ])

            let request = VNRecognizeTextRequest()
            request.revision = 3
            guard request.revision == 3,
                  VNRecognizeTextRequest.supportedRevisions.contains(3) else {
                throw ProbeFailure()
            }
            request.recognitionLevel = .accurate
            request.usesLanguageCorrection = false
            switch mode {
            case "zh":
                request.automaticallyDetectsLanguage = false
                request.recognitionLanguages = ["zh-Hans"]
            case "auto":
                request.automaticallyDetectsLanguage = true
                request.recognitionLanguages = ["zh-Hans", "en-US"]
            default:
                request.automaticallyDetectsLanguage = false
                request.recognitionLanguages = ["zh-Hans", "en-US"]
            }
            let supported = try request.supportedRecognitionLanguages()
            emit("request_configured", mode: mode, fields: [
                "revision": request.revision,
                "accurate": request.recognitionLevel == .accurate,
                "automatic_language": request.automaticallyDetectsLanguage,
                "language_count": request.recognitionLanguages.count,
                "fixed_languages_supported": request.recognitionLanguages.allSatisfy(supported.contains),
            ])
            emit("perform_started", mode: mode)
            let handler: VNImageRequestHandler
            if mode == "pixel" {
                let pixelBuffer = try makePixelBuffer(from: image)
                emit("input_converted", mode: mode, fields: [
                    "format": "32BGRA",
                    "width": CVPixelBufferGetWidth(pixelBuffer),
                    "height": CVPixelBufferGetHeight(pixelBuffer),
                ])
                handler = VNImageRequestHandler(cvPixelBuffer: pixelBuffer)
            } else {
                handler = VNImageRequestHandler(cgImage: image)
            }
            try handler.perform([request])
            emit("perform_completed", mode: mode)
            let candidates = (request.results ?? [])
                .compactMap { $0.topCandidates(1).first }
            let text = candidates.map(\.string).joined(separator: " ")
            let exact = text == expected
            let confidence = candidates.map(\.confidence).min() ?? 0
            emit("ocr_completed", mode: mode, fields: [
                "line_count": candidates.count,
                "synthetic_text_exact": exact,
                "minimum_candidate_confidence": confidence,
            ])
            exit(exact && confidence >= 0.90 ? 0 : 1)
        } catch {
            emit("failed", mode: mode, fields: [:] )
            exit(1)
        }
    }

    private static func syntheticHeader() throws -> CGImage {
        guard let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
              let context = CGContext(
                data: nil,
                width: 800,
                height: 72,
                bitsPerComponent: 8,
                bytesPerRow: 3200,
                space: colorSpace,
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
                    | CGBitmapInfo.byteOrder32Big.rawValue
              ) else {
            throw ProbeFailure()
        }
        context.scaleBy(x: 2, y: 2)
        context.setFillColor(CGColor(gray: 0.96, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: 400, height: 36))
        let font = CTFontCreateWithName("PingFangSC-Medium" as CFString, 14, nil)
        let title = NSAttributedString(string: expected, attributes: [
            NSAttributedString.Key(kCTFontAttributeName as String): font,
            NSAttributedString.Key(kCTForegroundColorAttributeName as String): CGColor(gray: 0.12, alpha: 1),
        ])
        context.textPosition = CGPoint(x: 10, y: 11)
        CTLineDraw(CTLineCreateWithAttributedString(title), context)
        guard let image = context.makeImage() else { throw ProbeFailure() }
        return image
    }

    private static func makePixelBuffer(from image: CGImage) throws -> CVPixelBuffer {
        var buffer: CVPixelBuffer?
        let attributes = [
            kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary,
            kCVPixelBufferCGImageCompatibilityKey: true,
            kCVPixelBufferCGBitmapContextCompatibilityKey: true,
        ] as CFDictionary
        guard CVPixelBufferCreate(
            kCFAllocatorDefault,
            image.width,
            image.height,
            kCVPixelFormatType_32BGRA,
            attributes,
            &buffer
        ) == kCVReturnSuccess, let buffer else {
            throw ProbeFailure()
        }
        CVPixelBufferLockBaseAddress(buffer, [])
        defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
        guard let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
              let context = CGContext(
                data: CVPixelBufferGetBaseAddress(buffer),
                width: image.width,
                height: image.height,
                bitsPerComponent: 8,
                bytesPerRow: CVPixelBufferGetBytesPerRow(buffer),
                space: colorSpace,
                bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue
                    | CGBitmapInfo.byteOrder32Little.rawValue
              ) else {
            throw ProbeFailure()
        }
        context.draw(
            image,
            in: CGRect(x: 0, y: 0, width: image.width, height: image.height)
        )
        return buffer
    }

    private static func emit(_ event: String, mode: String, fields: [String: Any] = [:]) {
        var result: [String: Any] = [
            "event": event,
            "mode": mode,
            "elapsed_ms": ((ProcessInfo.processInfo.systemUptime - started) * 10_000).rounded() / 10,
            "main_thread": Thread.isMainThread,
            "synthetic_input": true,
            "raw_images_saved": false,
        ]
        result.merge(fields) { _, incoming in incoming }
        guard let data = try? JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]) else {
            return
        }
        FileHandle.standardOutput.write(data + Data([0x0A]))
    }

    private static func sha256(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}
