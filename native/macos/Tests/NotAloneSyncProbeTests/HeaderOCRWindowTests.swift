import AppKit
import CoreGraphics
import Darwin
import Foundation
@preconcurrency import ScreenCaptureKit
import XCTest
@testable import NotAloneSyncCore

// 显式开启的开发验收：真实微信单帧只留内存，只有自动定位的标题片进入正式OCR。
// 后台窗口定位仅供本测试使用，不提供联系人资格，也不改变产品正式采集的前台门禁。
final class HeaderOCRWindowTests: XCTestCase {
    @MainActor
    func testCaptureExplicitPrivateWeChatWindow() async throws {
        guard let path = ProcessInfo.processInfo.environment["NOTALONE_HEADER_OCR_WINDOW_OUTPUT"], !path.isEmpty else {
            throw XCTSkip("未指定私有输出路径，跳过真实微信窗口验收")
        }
        let output = URL(fileURLWithPath: path)
        try requirePrivateDestination(output, original: path)
        let start = Date()
        var report: [String: Any] = [
            "schemaVersion": 1, "source": "actual_wechat_window", "acceptanceOnly": true,
            "singleFrame": true, "rawImagesSaved": false, "identityQualified": false,
            "recognizer": "LocalOcr.recognizeHeader",
        ]
        var failure: String?
        do {
            let current = try CalibrationContext.resolve(requireForeground: false)
            guard CGPreflightScreenCaptureAccess() else { throw WindowFailure.permissionMissing }
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            guard try CalibrationContext.resolve(requireForeground: false) == current else { throw WindowFailure.contextChanged }
            let matches = content.windows.filter {
                $0.windowID == current.windowId && $0.frame == current.frame
                    && $0.owningApplication?.processID == current.processId
                    && $0.owningApplication?.bundleIdentifier == "com.tencent.xinWeChat"
            }
            guard matches.count == 1, let window = matches.first else { throw WindowFailure.windowMetadataChanged }
            let filter = SCContentFilter(desktopIndependentWindow: window)
            let scale = CGFloat(filter.pointPixelScale)
            let width = current.frame.width * scale, height = current.frame.height * scale
            guard (1...3).contains(scale), width.isFinite, height.isFinite,
                  width * height <= 24_000_000 else { throw WindowFailure.invalidScale }
            let configuration = SCStreamConfiguration()
            configuration.width = Int(width.rounded()); configuration.height = Int(height.rounded())
            configuration.showsCursor = false; configuration.showMouseClicks = false
            configuration.capturesAudio = false; configuration.captureMicrophone = false
            configuration.includeChildWindows = false; configuration.ignoreShadowsSingleWindow = true
            configuration.preservesAspectRatio = false
            let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
            let capturedAt = Date()
            report["isForegroundAtCapture"] = NSWorkspace.shared.frontmostApplication?.processIdentifier == current.processId
            guard image.width == configuration.width, image.height == configuration.height else {
                throw WindowFailure.dimensionsChanged
            }
            guard try CalibrationContext.resolve(requireForeground: false) == current else { throw WindowFailure.contextChanged }
            let layout = try AutomaticSessionRegions.headerLayout(image, windowSize: current.frame.size)
            guard let header = image.cropping(to: layout.rectangle) else { throw WindowFailure.headerUnavailable }
            let result = try LocalOcr.recognizeHeader(header)
            guard try CalibrationContext.resolve(requireForeground: false) == current else { throw WindowFailure.contextChanged }
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            report.merge([
                "ok": true, "capturedAt": formatter.string(from: capturedAt),
                "windowPoints": ["width": current.frame.width, "height": current.frame.height],
                "windowPixels": ["width": image.width, "height": image.height],
                "headerPixels": ["width": header.width, "height": header.height],
                "pixelScale": scale, "rawText": result.text,
                "rawConfidence": result.confidence.isFinite ? result.confidence as Any : NSNull(),
                "rawComplete": result.isComplete,
            ]) { _, new in new }
            if let fallback = result.textFallback { report["textFallback"] = fallback.protocolValue }
        } catch let error as CalibrationContextFailure {
            failure = error.rawValue
        } catch let error as WindowFailure {
            failure = error.rawValue
        } catch let error as AutomaticLayoutFailure {
            failure = error.rawValue
        } catch {
            failure = "window_capture_or_ocr_unavailable"
        }
        if let failure { report.merge(["ok": false, "error": failure]) { _, new in new } }
        let elapsed = Int(Date().timeIntervalSince(start) * 1_000)
        report["elapsedMs"] = elapsed
        try writePrivateReport(JSONSerialization.data(withJSONObject: report, options: [.sortedKeys, .prettyPrinted]), to: output)
        if let failure {
            print("Header OCR actual window: failed; code=\(failure); elapsed_ms=\(elapsed); raw_images_saved=false")
            XCTFail("真实窗口验收失败：\(failure)")
        } else {
            print("Header OCR actual window: success; elapsed_ms=\(elapsed); single_frame=true; raw_images_saved=false")
        }
    }

    private enum WindowFailure: String, Error {
        case destinationInvalid = "private_destination_invalid"
        case permissionMissing = "screen_capture_permission_missing"
        case contextChanged = "window_context_changed"
        case windowMetadataChanged = "window_metadata_changed"
        case invalidScale = "window_scale_invalid"
        case dimensionsChanged = "window_dimensions_changed"
        case headerUnavailable = "header_image_unavailable"
        case outputUnavailable = "private_output_unavailable"
    }

    private func requirePrivateDestination(_ url: URL, original: String) throws {
        let directory = url.deletingLastPathComponent()
        var attributes = stat(), existing = stat()
        guard original.hasPrefix("/"), url.standardizedFileURL.path == original,
              directory.resolvingSymlinksInPath().path == directory.path,
              lstat(directory.path, &attributes) == 0,
              attributes.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR),
              attributes.st_mode & 0o777 == 0o700, attributes.st_uid == geteuid(),
              lstat(url.path, &existing) != 0, errno == ENOENT else { throw WindowFailure.destinationInvalid }
    }

    private func writePrivateReport(_ data: Data, to url: URL) throws {
        let descriptor = open(url.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
        guard descriptor >= 0 else { throw WindowFailure.outputUnavailable }
        defer { close(descriptor) }
        var attributes = stat()
        guard fstat(descriptor, &attributes) == 0,
              attributes.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG), attributes.st_mode & 0o777 == 0o600,
              attributes.st_uid == geteuid() else { throw WindowFailure.outputUnavailable }
        try data.withUnsafeBytes { bytes in
            guard let start = bytes.baseAddress else { throw WindowFailure.outputUnavailable }
            var count = 0
            while count < bytes.count {
                let written = write(descriptor, start.advanced(by: count), bytes.count - count)
                guard written > 0 else { throw WindowFailure.outputUnavailable }
                count += written
            }
        }
        guard fsync(descriptor) == 0 else { throw WindowFailure.outputUnavailable }
    }
}
