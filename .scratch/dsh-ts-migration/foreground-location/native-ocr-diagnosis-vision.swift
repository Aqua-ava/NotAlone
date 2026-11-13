// 纯合成 Vision 对照；不采集画面，不输出文字，不修改现有核心库。
import AppKit
import CoreGraphics
import CoreML
import CoreText
import CryptoKit
import Darwin
import Foundation
import NotAloneSyncCore
import Vision

private struct DiagnosticFailure: Error {}

@main
private struct NativeOcrVisionDiagnostic {
    private static let started = ProcessInfo.processInfo.systemUptime
    private static var mode = ""

    static func main() {
        let arguments = Array(CommandLine.arguments.dropFirst())
        let selectedRevision = arguments.count == 2 ? Int(arguments[1]) : nil
        let simple = arguments.count == 1 && ["library", "direct", "devices", "cpu", "inventory"].contains(arguments[0])
        let revision = arguments.count == 2 && arguments[0] == "revision" && (selectedRevision ?? 0) > 0
        guard simple || revision else {
            FileHandle.standardError.write(Data("用法：native-ocr-diagnosis-vision library|direct|devices|cpu|inventory 或 revision <整数>\n".utf8))
            exit(2)
        }
        mode = arguments[0]
        let environment = ProcessInfo.processInfo.environment
        emit("started", ["nsapp_initialized": NSApp != nil,
            "home_present": environment["HOME"] != nil, "tmpdir_present": environment["TMPDIR"] != nil])
        do {
            if mode == "inventory" { try revisionInventory() }
            let image = try syntheticHeader()
            guard let pixels = image.dataProvider?.data else { throw DiagnosticFailure() }
            emit("frame_ready", ["width": image.width, "height": image.height,
                "synthetic_pixel_sha256": SHA256.hash(data: pixels as Data).map { String(format: "%02x", $0) }.joined()])
            if mode == "library" {
                emit("ocr_started")
                let lines = try LocalOcr.recognize(image)
                complete(count: lines.count, exact: lines.map(\.text).joined(separator: " ") == "合成A1")
            }
            emit("request_create_started")
            let request = VNRecognizeTextRequest()
            emit("request_created", ["revision": request.revision])
            request.recognitionLevel = .accurate
            request.recognitionLanguages = ["zh-Hans", "en-US"]
            request.usesLanguageCorrection = false
            if let selectedRevision {
                guard VNRecognizeTextRequest.supportedRevisions.contains(selectedRevision) else {
                    emit("revision_unsupported", ["requested_revision": selectedRevision])
                    throw DiagnosticFailure()
                }
                request.revision = selectedRevision
                emit("revision_selected", ["requested_revision": selectedRevision, "readback_revision": request.revision])
                guard request.revision == selectedRevision else { throw DiagnosticFailure() }
                let supported = try request.supportedRecognitionLanguages()
                let eligible = ["zh-Hans", "en-US"].allSatisfy { supported.contains($0) }
                emit("revision_languages_checked", ["revision": selectedRevision,
                    "supports_fixed_languages": eligible, "supported_language_count": supported.count])
                guard eligible else { throw DiagnosticFailure() }
            }
            emit("request_configured", ["accurate": true, "language_count": request.recognitionLanguages.count,
                "correction": request.usesLanguageCorrection,
                "automatic_language": request.automaticallyDetectsLanguage, "revision": request.revision])
            if mode == "devices" || mode == "cpu" { try configureCompute(request, selectCpu: mode == "cpu") }
            emit("handler_create_started")
            let handler = VNImageRequestHandler(cgImage: image)
            emit("handler_created")
            emit("perform_started")
            try handler.perform([request])
            emit("perform_completed")
            let observations = request.results ?? []
            let candidates = observations.compactMap { $0.topCandidates(1).first }
            complete(count: candidates.count, exact: candidates.map(\.string).joined(separator: " ") == "合成A1")
        } catch {
            emit("failed", ["error_class": "vision_or_fixture_failed"])
            exit(1)
        }
    }

    private static func revisionInventory() throws -> Never {
        let supported = Array(VNRecognizeTextRequest.supportedRevisions)
        emit("revision_inventory", ["request_default_revision": VNRecognizeTextRequest().revision,
            "default_revision": VNRecognizeTextRequest.defaultRevision,
            "current_revision": VNRecognizeTextRequest.currentRevision, "supported_revisions": supported])
        for revision in supported {
            let request = VNRecognizeTextRequest()
            request.revision = revision
            request.recognitionLevel = .accurate
            request.recognitionLanguages = ["zh-Hans", "en-US"]
            request.usesLanguageCorrection = false
            let languages = try request.supportedRecognitionLanguages()
            emit("revision_capability", ["revision": revision, "readback_revision": request.revision,
                "supports_chinese": languages.contains("zh-Hans"), "supports_english": languages.contains("en-US"),
                "supported_language_count": languages.count])
        }
        emit("inventory_completed")
        exit(0)
    }

    private static func configureCompute(_ request: VNRecognizeTextRequest, selectCpu: Bool) throws {
        guard #available(macOS 14.0, *) else { throw DiagnosticFailure() }
        emit("supported_devices_started")
        let stages = try request.supportedComputeStageDevices
        emit("supported_devices_completed", ["stage_count": stages.count])
        guard !stages.isEmpty else { throw DiagnosticFailure() }
        for stage in stages.keys.sorted(by: { $0.rawValue < $1.rawValue }) {
            guard let devices = stages[stage] else { throw DiagnosticFailure() }
            let kinds = devices.map { device -> String in
                switch device {
                case .cpu: return "cpu"
                case .gpu: return "gpu"
                case .neuralEngine: return "neural_engine"
                @unknown default: return "unknown"
                }
            }
            let label = stage == .main ? "main" : (stage == .postProcessing ? "post_processing" : "unknown")
            emit("supported_stage", ["stage": label, "devices": kinds])
            if selectCpu {
                guard let cpu = devices.first(where: { if case .cpu = $0 { return true }; return false }) else {
                    emit("cpu_unavailable", ["stage": label])
                    throw DiagnosticFailure()
                }
                request.setComputeDevice(cpu, for: stage)
                let confirmed: Bool
                if let selected = request.computeDevice(for: stage), case .cpu = selected { confirmed = true }
                else { confirmed = false }
                emit("cpu_selected", ["stage": label, "readback_confirmed": confirmed])
                guard confirmed else { throw DiagnosticFailure() }
            }
        }
    }

    private static func complete(count: Int, exact: Bool) -> Never {
        emit("ocr_completed", ["line_count": count, "synthetic_text_exact": exact])
        exit(exact ? 0 : 1)
    }

    private static func emit(_ event: String, _ fields: [String: Any] = [:]) {
        var result: [String: Any] = ["event": event, "mode": mode,
            "elapsed_ms": ((ProcessInfo.processInfo.systemUptime - started) * 10_000).rounded() / 10,
            "main_thread": Thread.isMainThread, "synthetic_input": true, "raw_images_saved": false]
        result.merge(fields) { _, incoming in incoming }
        if let data = try? JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]) {
            FileHandle.standardOutput.write(data + Data([0x0A]))
        }
    }

    private static func syntheticHeader() throws -> CGImage {
        guard let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
              let context = CGContext(data: nil, width: 800, height: 72, bitsPerComponent: 8,
                  bytesPerRow: 3200, space: colorSpace,
                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue) else {
            throw DiagnosticFailure()
        }
        context.scaleBy(x: 2, y: 2)
        context.setFillColor(CGColor(gray: 0.96, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: 400, height: 36))
        let font = CTFontCreateWithName("PingFangSC-Medium" as CFString, 14, nil)
        let title = NSAttributedString(string: "合成A1", attributes: [
            NSAttributedString.Key(kCTFontAttributeName as String): font,
            NSAttributedString.Key(kCTForegroundColorAttributeName as String): CGColor(gray: 0.12, alpha: 1),
        ])
        context.textPosition = CGPoint(x: 10, y: 11)
        CTLineDraw(CTLineCreateWithAttributedString(title), context)
        guard let image = context.makeImage() else { throw DiagnosticFailure() }
        return image
    }
}
