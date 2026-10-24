// 固定合成图；比较 macOS 15+ Vision 的 async 请求接口，不采集或保存画面。
import AppKit
import CoreGraphics
import CoreText
import CryptoKit
import Foundation
import Vision
import VisionKit

private struct ProbeFailure: Error {}

@main
private struct ModernVisionProbe {
    private static let started = ProcessInfo.processInfo.systemUptime
    private static let expected = "合成A1"

    static func main() async {
        do {
            if CommandLine.arguments.contains("--initialize-nsapp") {
                _ = NSApplication.shared
            }
            let mismatchedFixture = CommandLine.arguments.contains("--mismatched-fixture")
            let image = try syntheticHeader(
                text: mismatchedFixture ? "合成B2" : expected
            )
            guard let data = image.dataProvider?.data else { throw ProbeFailure() }
            let digest = SHA256.hash(data: data as Data)
                .map { String(format: "%02x", $0) }
                .joined()
            emit("frame_ready", [
                "width": image.width,
                "height": image.height,
                "pixel_sha256": digest,
                "fixture_mismatch": mismatchedFixture,
            ])

            if CommandLine.arguments.contains("--visionkit") {
                try await runVisionKit(image)
            }
            if CommandLine.arguments.contains("--visionkit-warm") {
                let transcript = try await warmWithVisionKit(image)
                emit("visionkit_warm_completed", [
                    "synthetic_text_exact": transcript == expected,
                ])
            }
            if CommandLine.arguments.contains("--documents") {
                if #available(macOS 26.0, *) {
                    try await runDocuments(image)
                }
                emit("documents_unavailable")
                throw ProbeFailure()
            }
            if CommandLine.arguments.contains("--legacy-fast") {
                try runLegacyFast(image)
            }

            var request = RecognizeTextRequest()
            request.recognitionLevel = .accurate
            request.automaticallyDetectsLanguage = false
            request.recognitionLanguages = [
                Locale.Language(identifier: "zh-Hans"),
                Locale.Language(identifier: "en-US"),
            ]
            request.usesLanguageCorrection = false
            emit("request_configured", [
                "revision": String(describing: request.revision),
                "language_count": request.recognitionLanguages.count,
            ])

            emit("perform_started")
            let handler = ImageRequestHandler(image)
            let observations = try await handler.perform(request)
            emit("perform_completed")
            let text = observations
                .compactMap { $0.topCandidates(1).first?.string }
                .joined(separator: " ")
            let exact = text == expected
            emit("ocr_completed", [
                "line_count": observations.count,
                "synthetic_text_exact": exact,
            ])
            exit(exact ? 0 : 1)
        } catch {
            emit("failed", ["error_class": String(describing: type(of: error))])
            exit(1)
        }
    }

    private static func runVisionKit(_ image: CGImage) async throws {
        guard ImageAnalyzer.isSupported else {
            emit("visionkit_unsupported")
            throw ProbeFailure()
        }
        let supported = ImageAnalyzer.supportedTextRecognitionLanguages
        let eligible = ["zh-Hans", "en-US"].allSatisfy(supported.contains)
        emit("visionkit_capability", [
            "fixed_languages_supported": eligible,
            "language_count": supported.count,
        ])
        guard eligible else { throw ProbeFailure() }
        var configuration = ImageAnalyzer.Configuration([.text])
        configuration.locales = ["zh-Hans", "en-US"]
        emit("perform_started")
        let analysis = try await ImageAnalyzer().analyze(
            image,
            orientation: .up,
            configuration: configuration
        )
        emit("perform_completed")
        let text = analysis.transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        let exact = text == expected
        emit("ocr_completed", [
            "line_count": text.isEmpty ? 0 : 1,
            "synthetic_text_exact": exact,
        ])
        exit(exact ? 0 : 1)
    }

    private static func warmWithVisionKit(_ image: CGImage) async throws -> String {
        guard ImageAnalyzer.isSupported else { throw ProbeFailure() }
        let supported = ImageAnalyzer.supportedTextRecognitionLanguages
        guard ["zh-Hans", "en-US"].allSatisfy(supported.contains) else {
            throw ProbeFailure()
        }
        var configuration = ImageAnalyzer.Configuration([.text])
        configuration.locales = ["zh-Hans", "en-US"]
        let analysis = try await ImageAnalyzer().analyze(
            image,
            orientation: .up,
            configuration: configuration
        )
        return analysis.transcript.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    @available(macOS 26.0, *)
    private static func runDocuments(_ image: CGImage) async throws -> Never {
        var request = RecognizeDocumentsRequest()
        let supported = request.supportedRecognitionLanguages.map(\.minimalIdentifier)
        let eligible = ["zh-Hans", "en-US"].allSatisfy(supported.contains)
        emit("documents_capability", [
            "fixed_languages_supported": eligible,
            "language_count": supported.count,
            "language_ids": supported.sorted(),
        ])
        request.textRecognitionOptions.automaticallyDetectLanguage = false
        request.textRecognitionOptions.recognitionLanguages = [
            Locale.Language(identifier: "zh-Hans"),
            Locale.Language(identifier: "en-US"),
        ]
        request.textRecognitionOptions.useLanguageCorrection = false
        request.textRecognitionOptions.maximumCandidateCount = 1
        emit("request_configured", [
            "revision": String(describing: request.revision),
            "language_count": request.textRecognitionOptions.recognitionLanguages.count,
        ])
        emit("perform_started")
        let observations = try await ImageRequestHandler(image).perform(request)
        emit("perform_completed")
        let candidates = observations
            .flatMap { $0.document.text.lines }
            .compactMap { $0.topCandidates(1).first }
        let text = candidates.map(\.string).joined(separator: " ")
        let exact = text == expected
        let confidence = candidates.map(\.confidence).min() ?? 0
        emit("ocr_completed", [
            "line_count": candidates.count,
            "synthetic_text_exact": exact,
            "minimum_candidate_confidence": confidence,
        ])
        exit(exact && confidence >= 0.90 ? 0 : 1)
    }

    private static func runLegacyFast(_ image: CGImage) throws -> Never {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .fast
        request.automaticallyDetectsLanguage = false
        request.recognitionLanguages = ["zh-Hans", "en-US"]
        request.usesLanguageCorrection = false
        request.customWords = [expected]
        emit("request_configured", [
            "recognition_level": "fast",
            "revision": request.revision,
            "language_count": request.recognitionLanguages.count,
            "custom_word_count": request.customWords.count,
        ])
        emit("perform_started")
        try VNImageRequestHandler(cgImage: image).perform([request])
        emit("perform_completed")
        let candidates = (request.results ?? []).compactMap { $0.topCandidates(1).first }
        let text = candidates.map(\.string).joined(separator: " ")
        let exact = text == expected
        let confidence = candidates.map(\.confidence).min() ?? 0
        emit("ocr_completed", [
            "line_count": candidates.count,
            "synthetic_text_exact": exact,
            "minimum_candidate_confidence": confidence,
        ])
        exit(exact && confidence >= 0.90 ? 0 : 1)
    }

    private static func syntheticHeader(text: String) throws -> CGImage {
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
        let title = NSAttributedString(string: text, attributes: [
            NSAttributedString.Key(kCTFontAttributeName as String): font,
            NSAttributedString.Key(kCTForegroundColorAttributeName as String): CGColor(gray: 0.12, alpha: 1),
        ])
        context.textPosition = CGPoint(x: 10, y: 11)
        CTLineDraw(CTLineCreateWithAttributedString(title), context)
        guard let image = context.makeImage() else { throw ProbeFailure() }
        return image
    }

    private static func emit(_ event: String, _ fields: [String: Any] = [:]) {
        var result: [String: Any] = [
            "event": event,
            "mode": "modern-async",
            "elapsed_ms": ((ProcessInfo.processInfo.systemUptime - started) * 10_000).rounded() / 10,
            "main_thread": Thread.isMainThread,
            "nsapp_initialized": NSApp != nil,
            "bundle_identifier_present": Bundle.main.bundleIdentifier != nil,
            "synthetic_input": true,
            "raw_images_saved": false,
        ]
        result.merge(fields) { _, incoming in incoming }
        guard let data = try? JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]) else {
            return
        }
        FileHandle.standardOutput.write(data + Data([0x0A]))
    }
}
