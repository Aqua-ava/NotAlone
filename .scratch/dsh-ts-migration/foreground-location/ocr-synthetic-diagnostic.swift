// 纯合成诊断：复用现有核心动态库，不采集屏幕，不输出文字或图像。
import AppKit
import CoreGraphics
import CoreText
import Darwin
import Dispatch
import Foundation
import NotAloneSyncCore

private struct DiagnosticFailure: Error {}

// CGImage 不可变；本诊断只将同一合成图交给一个执行者。
private final class FrozenImage: @unchecked Sendable {
    let value: CGImage
    init(_ value: CGImage) { self.value = value }
}

private struct RunMetadata: Sendable {
    let mode: String
    let started: TimeInterval
    let appInitialized: Bool
    let hasHome: Bool
    let hasTmpdir: Bool
}

@main
private struct SyntheticOcrDiagnostic {
    static func main() {
        let arguments = Array(CommandLine.arguments.dropFirst())
        guard arguments.count == 1, ["main", "background"].contains(arguments[0]) else {
            FileHandle.standardError.write(Data("用法：ocr-synthetic-diagnostic main|background\n".utf8))
            exit(2)
        }
        let environment = ProcessInfo.processInfo.environment
        let metadata = RunMetadata(mode: arguments[0], started: ProcessInfo.processInfo.systemUptime,
            appInitialized: NSApp != nil, hasHome: environment["HOME"] != nil,
            hasTmpdir: environment["TMPDIR"] != nil)
        emit("started", metadata)
        do {
            let image = FrozenImage(try syntheticHeader())
            emit("frame_ready", metadata, fields: ["width": image.value.width, "height": image.value.height])
            if metadata.mode == "main" {
                recognize(image, metadata)
            } else {
                DispatchQueue.global(qos: .userInitiated).async { recognize(image, metadata) }
                // 保留主队列运转；不使用会阻塞主线程的 semaphore/group.wait。
                dispatchMain()
            }
        } catch {
            emit("fixture_failed", metadata)
            exit(2)
        }
    }

    private static func recognize(_ image: FrozenImage, _ metadata: RunMetadata) -> Never {
        emit("ocr_started", metadata)
        do {
            // 与正式 recognizeHeader 共用首次 recognizeFragments；不覆盖私有尾部回退。
            let lines = try LocalOcr.recognize(image.value)
            let exact = lines.map(\.text).joined(separator: " ") == "合成A1"
            emit("ocr_completed", metadata, fields: ["line_count": lines.count,
                "synthetic_text_exact": exact,
                "confidences_valid": lines.allSatisfy { $0.confidence.isFinite && (0...1).contains($0.confidence) }])
            exit(exact ? 0 : 1)
        } catch {
            emit("ocr_failed", metadata)
            exit(1)
        }
    }

    private static func emit(_ event: String, _ metadata: RunMetadata, fields: [String: Any] = [:]) {
        var result: [String: Any] = ["event": event, "executor": metadata.mode,
            "elapsed_ms": ((ProcessInfo.processInfo.systemUptime - metadata.started) * 10_000).rounded() / 10,
            "main_thread": Thread.isMainThread, "nsapp_initialized_at_start": metadata.appInitialized,
            "home_present": metadata.hasHome, "tmpdir_present": metadata.hasTmpdir,
            "synthetic_input": true, "raw_images_saved": false]
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
