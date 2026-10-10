import AppKit
import CoreGraphics
import CryptoKit
import Foundation
@preconcurrency import ScreenCaptureKit
import Vision

// session专用路径：display filter只包含已选微信窗口，sourceRect在采集时限制到单一最小区域。
// 不调用旧全窗captureWindowSnapshot，不保存图像，也不操作微信。
@MainActor
public enum MinimalSessionCapture {
    public static func verifySelection(_ data: Data) async -> [String: Any] {
        var stage = "selection"
        func entering(_ name: String) {
            stage = name
            FileHandle.standardError.write(Data("notalone_verification_stage:\(name)\n".utf8))
        }
        entering("selection")
        do {
            let layout = try MinimalRegionLayout.decode(data, requireVerified: false)
            entering("context")
            let deadline = Date().addingTimeInterval(60)
            while !layout.contextMatches(), Date() < deadline {
                try await Task.sleep(nanoseconds: 100_000_000)
            }
            guard layout.contextMatches() else {
                if NSWorkspace.shared.frontmostApplication?.bundleIdentifier != "com.tencent.xinWeChat" {
                    throw MinimalSessionError.weChatNotFrontmost
                }
                throw MinimalSessionError.layoutChanged
            }
            entering("capture-setup")
            let capture = try await Capture(layout)
            entering("sentinels-before")
            let digests = try await capture.sentinels()
            entering("names")
            let names = try await capture.names()
            guard names.consistent, names.confidence >= 0.90 else { throw MinimalSessionError.qualityUnverified }
            entering("sentinels-after")
            guard try await capture.sentinels() == digests else { throw MinimalSessionError.qualityUnverified }
            entering("profile")
            return ["ok": true, "profile": try layout.verified(scale: capture.scale, digests: digests),
                    "verification": ["capture_version": "minimal-region-v1", "names_consistent": true,
                                     "minimum_confidence": names.confidence, "region_count": 5]]
        } catch {
            var result = failure(error)
            result["verification_stage"] = stage
            return result
        }
    }

    public static func observe(profilePath: String?) async -> [String: Any] {
        do {
            // 先核验私有profile，缺失或待校验状态不得触发任何OS观察或权限查询。
            guard let profilePath else { throw MinimalSessionError.layoutUnverified }
            let layout = try MinimalRegionLayout.decode(MinimalRegionLayout.readPrivateFile(profilePath), requireVerified: true)
            guard NSWorkspace.shared.frontmostApplication?.bundleIdentifier == "com.tencent.xinWeChat" else {
                return ["ok": true, "wechat_in_front": false]
            }
            guard layout.contextMatches() else { throw MinimalSessionError.layoutChanged }
            let capture = try await Capture(layout)
            guard capture.scale == layout.pixelScale,
                  try await capture.sentinels() == layout.sentinelDigests else { throw MinimalSessionError.layoutChanged }
            let names = try await capture.names()
            guard try await capture.sentinels() == layout.sentinelDigests else { throw MinimalSessionError.layoutChanged }
            return ["ok": true, "wechat_in_front": true, "capture_version": "minimal-region-v1",
                    "display_name": names.header.text ?? NSNull(), "selected_row_name": names.row.text ?? NSNull(),
                    "quality": ["layout_verified": true, "display_name_confidence": names.header.confidence,
                                "selected_row_name_confidence": names.row.confidence]]
        } catch { return failure(error) }
    }

    private static func failure(_ error: Error) -> [String: Any] {
        ["ok": false, "error": (error as? MinimalSessionError)?.rawValue ?? MinimalSessionError.captureFailed.rawValue]
    }
}

@MainActor
private final class Capture {
    let layout: MinimalRegionLayout
    let filter: SCContentFilter
    let display: SCDisplay
    let scale: Double

    init(_ layout: MinimalRegionLayout) async throws {
        self.layout = layout
        guard layout.contextMatches() else { throw MinimalSessionError.layoutChanged }
        // 只静默预检；不调用CGRequestScreenCaptureAccess，不自动接受系统权限。
        guard CGPreflightScreenCaptureAccess() else { throw MinimalSessionError.permissionMissing }
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard layout.contextMatches(),
              let window = content.windows.first(where: {
                  $0.windowID == layout.windowId && $0.owningApplication?.processID == layout.processId
                      && $0.owningApplication?.bundleIdentifier == "com.tencent.xinWeChat" && $0.frame == layout.frame
              }) else { throw MinimalSessionError.layoutChanged }
        let displays = content.displays.filter { $0.frame.contains(layout.frame) }
        guard displays.count == 1, let display = displays.first else { throw MinimalSessionError.layoutChanged }
        self.display = display
        filter = SCContentFilter(display: display, including: [window])
        filter.includeMenuBar = false
        scale = Double(filter.pointPixelScale)
        guard scale >= 1, scale <= 3 else { throw MinimalSessionError.layoutChanged }
    }

    func sentinels() async throws -> [String: String] {
        var result: [String: String] = [:]
        for field in MinimalRegionLayout.sentinelFields {
            result[field] = try digest(await image(field))
        }
        return result
    }

    func names() async throws -> Names {
        let header = try recognize(await image("displayName"))
        let row = try recognize(await image("selectedRowName"))
        // 两个小帧分别采集；再读一次顶部名字，防止跨会话变化被写成同一次可信观察。
        let repeated = try recognize(await image("displayName"))
        guard header.text == repeated.text else { throw MinimalSessionError.layoutChanged }
        return Names(header: Name(text: header.text, confidence: min(header.confidence, repeated.confidence)), row: row)
    }

    private func image(_ field: String) async throws -> CGImage {
        guard layout.contextMatches(), let region = layout.regions[field] else { throw MinimalSessionError.layoutChanged }
        let width = region.width * scale, height = region.height * scale
        guard width.rounded() == width, height.rounded() == height,
              width >= 1, height >= 1, width * height <= 160_000 else { throw MinimalSessionError.layoutChanged }
        let source = region.offsetBy(dx: layout.frame.minX - display.frame.minX, dy: layout.frame.minY - display.frame.minY)
        guard CGRect(origin: .zero, size: display.frame.size).contains(source) else { throw MinimalSessionError.layoutChanged }
        let configuration = SCStreamConfiguration()
        configuration.sourceRect = source
        configuration.width = Int(width); configuration.height = Int(height)
        configuration.showsCursor = false; configuration.showMouseClicks = false
        configuration.capturesAudio = false; configuration.captureMicrophone = false
        configuration.includeChildWindows = false; configuration.ignoreShadowsDisplay = true
        configuration.preservesAspectRatio = false; configuration.captureResolution = .best
        let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
        guard layout.contextMatches(), image.width == Int(width), image.height == Int(height) else {
            throw MinimalSessionError.layoutChanged
        }
        return image
    }
}

private struct Name {
    let text: String?
    let confidence: Double
}

private struct Names {
    let header: Name
    let row: Name
    var consistent: Bool { header.text != nil && header.text == row.text }
    var confidence: Double { min(header.confidence, row.confidence) }
}

private func recognize(_ image: CGImage) throws -> Name {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate; request.recognitionLanguages = ["zh-Hans", "en-US"]
    request.usesLanguageCorrection = false
    try VNImageRequestHandler(cgImage: image).perform([request])
    // 多行、贴边或缺候选不能证明完整名字；不把截断的高置信度前缀当作完整联系人名。
    guard let results = request.results, results.count == 1,
          let observation = results.first, let candidate = observation.topCandidates(1).first,
          observation.boundingBox.minX > 0.01, observation.boundingBox.maxX < 0.99 else {
        return Name(text: nil, confidence: 0)
    }
    let text = candidate.string.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
    return Name(text: text.isEmpty ? nil : text, confidence: Double(candidate.confidence))
}

private func digest(_ image: CGImage) throws -> String {
    let count = image.width * image.height * 4
    var bytes = [UInt8](repeating: 0, count: count)
    let valid = bytes.withUnsafeMutableBytes { buffer -> Bool in
        guard let context = CGContext(data: buffer.baseAddress, width: image.width, height: image.height,
                                      bitsPerComponent: 8, bytesPerRow: image.width * 4,
                                      space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
        context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        return stride(from: 3, to: count, by: 4).allSatisfy { buffer[$0] == 255 }
    }
    guard valid else { throw MinimalSessionError.captureFailed }
    return SHA256.hash(data: Data(bytes)).map { String(format: "%02x", $0) }.joined()
}
