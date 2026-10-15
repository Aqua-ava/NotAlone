import AppKit
import CoreGraphics
import Foundation
@preconcurrency import ScreenCaptureKit

// 每轮重新定位当前窗口；整窗只作内存布局分析，OCR只接收名称区域。
@MainActor
public enum AutomaticSessionCapture {
    public static func observe() async -> [String: Any] {
        await observeHeader(context: { try foregroundContext() }, capture: captureWindow,
                            recognize: LocalOcr.recognizeHeader)
    }

    // 正式观察与可视验收共用采集前门禁；调用此方法不会截图或识别。
    static func foregroundContext(
        frontmost: @MainActor () -> ForegroundApplication = ForegroundApplication.current,
        resolve: @MainActor () throws -> CalibrationContext = { try CalibrationContext.resolve(requireForeground: true) }
    ) throws -> CalibrationContext? {
        let application = frontmost()
        guard application != .unknown else { throw CalibrationContextFailure.foregroundApplicationUnavailable }
        guard application == .wechat else { return nil }
        return try resolve()
    }

    // 旧双名称协议仅用于原有裁剪诊断及兼容回归，正式入口使用顶部OCR。
    static func observe(context: () throws -> CalibrationContext?,
                        capture: (CalibrationContext) async throws -> CGImage,
                        recognize: (CGImage) throws -> Name,
                        clock: () -> Date = Date.init) async -> [String: Any] {
        var stage = "context"
        do {
            guard let current = try context() else { return ["ok": true, "wechat_in_front": false] }
            stage = "capture"
            let image = try await capture(current)
            let capturedAt = clock()
            stage = "context_after_capture"
            guard try context() == current else { throw MinimalSessionError.layoutChanged }
            stage = "layout"
            let regions = try AutomaticSessionRegions.detect(image, windowSize: current.frame.size)
            guard let headerImage = image.cropping(to: regions.header),
                  let rowImage = image.cropping(to: regions.row) else { throw MinimalSessionError.captureFailed }
            stage = "names"
            let names = Names(header: try recognize(headerImage), row: try recognize(rowImage))
            guard [names.header.confidence, names.row.confidence].allSatisfy({ $0.isFinite && (0...1).contains($0) }) else { throw MinimalSessionError.qualityUnverified }
            try names.validate()
            stage = "context_after_names"
            guard try context() == current else { throw MinimalSessionError.layoutChanged }
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            formatter.timeZone = TimeZone(secondsFromGMT: 0)
            return ["ok": true, "wechat_in_front": true, "capture_version": "automatic-window-v2",
                    "captured_at": formatter.string(from: capturedAt),
                    "display_name": names.header.text!, "selected_row_name": names.row.text!,
                    "quality": ["layout_verified": true, "display_name_confidence": names.header.confidence,
                                "selected_row_name_confidence": names.row.confidence]]
        } catch {
            return ["ok": false, "stage": stage, "error": (error as? MinimalSessionError)?.rawValue
                    ?? (error as? AutomaticCaptureFailure)?.rawValue
                    ?? (error as? AutomaticLayoutFailure)?.rawValue
                    ?? (error as? CalibrationContextFailure)?.rawValue ?? MinimalSessionError.captureFailed.rawValue]
        }
    }

    // 预览与正式入口消费同一次顶部识别；预览投影不进入联系人协议。
    static func observeHeaderPreview() async -> [String: Any] {
        let result = await observe()
        guard result["ok"] as? Bool == true, result["wechat_in_front"] as? Bool == true,
              let quality = result["quality"] as? [String: Any],
              let captured = result["captured_at"], let text = result["display_name"],
              let confidence = quality["display_name_confidence"] else { return result }
        return ["ok": true, "wechat_in_front": true, "capture_version": "preview-header-v1",
                "captured_at": captured, "header_text": text, "header_confidence": confidence]
    }

    static func observeHeader(
        context: () throws -> CalibrationContext?,
        capture: (CalibrationContext) async throws -> CGImage,
        recognize: (CGImage) throws -> HeaderOcrResult,
        clock: () -> Date = Date.init
    ) async -> [String: Any] {
        var stage = "context"
        do {
            guard let current = try context() else { return ["ok": true, "wechat_in_front": false] }
            stage = "capture"
            let image = try await capture(current)
            let capturedAt = clock()
            stage = "context_after_capture"
            guard try context() == current else { throw AutomaticCaptureFailure.context }
            stage = "layout"
            let rectangle = try AutomaticSessionRegions.headerLayout(image, windowSize: current.frame.size).rectangle
            guard let header = image.cropping(to: rectangle) else { throw MinimalSessionError.captureFailed }
            stage = "header_ocr"
            let name = try recognize(header)
            guard !name.text.isEmpty else { throw MinimalSessionError.headerNameUnreadable }
            guard name.confidence.isFinite, (0...1).contains(name.confidence) else {
                throw MinimalSessionError.qualityUnverified
            }
            stage = "context_after_names"
            guard try context() == current else { throw AutomaticCaptureFailure.context }
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            return ["ok": true, "wechat_in_front": true, "capture_version": "automatic-header-v3",
                    "captured_at": formatter.string(from: capturedAt), "display_name": name.text,
                    "quality": ["layout_verified": true, "display_name_confidence": name.confidence,
                                "name_complete": name.isComplete]]
        } catch {
            return ["ok": false, "stage": stage, "error": (error as? MinimalSessionError)?.rawValue
                    ?? (error as? AutomaticCaptureFailure)?.rawValue
                    ?? (error as? AutomaticLayoutFailure)?.rawValue
                    ?? (error as? CalibrationContextFailure)?.rawValue ?? MinimalSessionError.captureFailed.rawValue]
        }
    }

    static func captureWindow(_ current: CalibrationContext) async throws -> CGImage {
        guard CGPreflightScreenCaptureAccess() else { throw MinimalSessionError.permissionMissing }
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard CalibrationContext.read(requireForeground: true) == current else { throw AutomaticCaptureFailure.context }
        guard let window = content.windows.first(where: { $0.windowID == current.windowId
                  && $0.owningApplication?.processID == current.processId && $0.frame == current.frame
                  && $0.owningApplication?.bundleIdentifier == "com.tencent.xinWeChat" }) else {
            throw AutomaticCaptureFailure.metadata
        }
        // 独立窗口过滤器不捕获其他App；不使用旧诊断的“最大窗口”选择或全屏采集。
        let filter = SCContentFilter(desktopIndependentWindow: window)
        let scale = CGFloat(filter.pointPixelScale)
        let width = current.frame.width * scale, height = current.frame.height * scale
        guard (1...3).contains(scale), width.isFinite, height.isFinite,
              width * height <= 24_000_000 else { throw AutomaticCaptureFailure.scale }
        let configuration = SCStreamConfiguration()
        configuration.width = Int(width.rounded()); configuration.height = Int(height.rounded())
        configuration.showsCursor = false; configuration.showMouseClicks = false
        configuration.capturesAudio = false; configuration.captureMicrophone = false
        configuration.includeChildWindows = false; configuration.ignoreShadowsSingleWindow = true
        configuration.preservesAspectRatio = false
        let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
        guard image.width == configuration.width, image.height == configuration.height else {
            throw AutomaticCaptureFailure.dimensions
        }
        return image
    }
}

private enum AutomaticCaptureFailure: String, Error {
    case context = "automatic_capture_context_changed"
    case metadata = "automatic_capture_window_metadata_changed"
    case scale = "automatic_capture_scale_invalid"
    case dimensions = "automatic_capture_dimensions_changed"
}

struct HeaderOcrResult {
    let text: String
    let confidence: Double
    let isComplete: Bool

    init(fragments: [(RecognizedLine, CGRect)]) {
        text = fragments.map { $0.0.text }.joined(separator: " ").trimmingCharacters(in: .whitespacesAndNewlines)
        confidence = fragments.allSatisfy({ $0.0.confidence.isFinite && (0...1).contains($0.0.confidence) })
            ? Double(fragments.map { $0.0.confidence }.min() ?? 0) : .nan
        // 原始文字照常展示；边界截断或省略名称只能作为未确认线索。
        isComplete = !text.isEmpty && text.count <= 256 && !text.contains("\n") && !text.contains("\r")
            && !text.contains("…") && !text.contains("...") && fragments.allSatisfy {
                let box = $0.1
                return box.minX.isFinite && box.maxX.isFinite && box.minY.isFinite && box.maxY.isFinite
                    && box.width > 0 && box.height > 0 && box.minX > 0.01 && box.maxX < 0.99
                    && box.minY > 0.01 && box.maxY < 0.99
            }
    }
}

enum AutomaticLayoutFailure: String, Error {
    case vertical = "automatic_layout_vertical_boundary"
    case header = "automatic_layout_header_boundary"
    case selection = "automatic_layout_selection_ambiguous"
    case rail = "automatic_layout_sidebar_boundary"
}

// 微信4.0.6桌面布局的可拒绝检测器。尺寸以当帧比例转换，屏幕原点不参与推导。
// 检测阶段只比较亮度边界，不将侧栏其他联系人或聊天正文送给OCR。
struct AutomaticSessionRegions {
    let header: CGRect
    let row: CGRect

    static func detect(_ image: CGImage, windowSize: CGSize) throws -> Self {
        let geometry = try headerLayout(image, windowSize: windowSize)
        let scale = geometry.scale, pixels = geometry.pixels
        let divider = geometry.divider, headerY = geometry.headerY
        let w = image.width, h = image.height
        func px(_ points: CGFloat) -> Int { Int((points * scale).rounded()) }
        func median(_ values: [Int]) -> Int { ChatRegionDetector.medianOf(values) }
        // 左边无文字窄条只用于找唯一高亮行，避免头像、时间、预览污染均值。
        let stripe = divider - px(5)
        let start = headerY + px(2), end = h - px(12)
        let values = (start..<end).map { y in median((0..<px(3)).map { Int(pixels[y*w+stripe+$0]) }) }
        let background = median(values)
        var bands: [Range<Int>] = [], begin: Int?
        for (offset, value) in values.enumerated() {
            if abs(value-background) >= 10 {
                if begin == nil { begin = offset }
            } else if let first = begin { bands.append((start+first)..<(start+offset)); begin = nil }
        }
        if let begin { bands.append((start+begin)..<end) }
        let candidates = bands.filter { (px(40)...px(100)).contains($0.count) }
        guard candidates.count == 1, let selected = candidates.first,
              bands.allSatisfy({ $0.count < px(4) || $0 == selected }) else { throw AutomaticLayoutFailure.selection }
        // 高亮的左边界从该行与其他行的差异取得；侧栏不要求有可见竖线。
        let leftCandidates = (px(40)...px(100)).filter { x in
            let base = median((0..<31).map { i in Int(pixels[(start+(end-start-1)*i/30)*w+x]) })
            return [selected.lowerBound+px(4), selected.lowerBound+px(30)].allSatisfy {
                abs(Int(pixels[$0*w+x])-base) >= 10
            }
        }
        guard let rail = leftCandidates.first, leftCandidates.last! - rail >= px(15) else {
            throw AutomaticLayoutFailure.rail
        }
        let title = geometry.rectangle
        let name = CGRect(x: rail+px(54), y: selected.lowerBound+px(6),
                          width: divider-rail-px(118), height: px(25))
        guard title.width >= CGFloat(px(30)), name.width >= CGFloat(px(25)), title.height >= CGFloat(px(18)),
              name.maxY < CGFloat(selected.upperBound),
              CGRect(x: 0, y: 0, width: w, height: h).contains(title),
              CGRect(x: 0, y: 0, width: w, height: h).contains(name) else { throw MinimalSessionError.layoutUnverified }
        return Self(header: title, row: name)
    }

    struct HeaderLayout {
        let rectangle: CGRect
        let pixels: [UInt8]
        let scale: CGFloat
        let divider: Int
        let headerY: Int
    }

    static func headerLayout(_ image: CGImage, windowSize: CGSize) throws -> HeaderLayout {
        guard windowSize.width >= 600, windowSize.height >= 400,
              image.width * image.height <= 24_000_000 else { throw MinimalSessionError.layoutUnverified }
        let scale = CGFloat(image.width) / windowSize.width
        guard (1...3).contains(scale), abs(CGFloat(image.height) / windowSize.height - scale) < 0.001,
              let pixels = ChatRegionDetector.luminancePixels(from: image) else { throw MinimalSessionError.layoutUnverified }
        let w = image.width, h = image.height
        func px(_ points: CGFloat) -> Int { Int((points * scale).rounded()) }
        func median(_ values: [Int]) -> Int { ChatRegionDetector.medianOf(values) }
        func vertical(_ x: Int) -> Int {
            median((0..<31).map { i in
                let y = px(100) + (h - px(120)) * i / 30
                return abs(Int(pixels[y*w+x-1]) - Int(pixels[y*w+x+1]))
            })
        }
        let divider = try uniqueBoundary(range: px(180)...min(px(600), w-px(280)), score: vertical, tolerance: px(3), failure: .vertical)
        // 单行置顶/公告提示会将下缘推至约96pt；仍要求整个有界范围内只有一处强边界。
        let headerY = try uniqueBoundary(range: px(45)...px(110), score: { y in
            median((0..<21).map { i in
                let x = divider + px(20) + (w-divider-px(60))*i/20
                return abs(Int(pixels[(y-1)*w+x]) - Int(pixels[(y+1)*w+x]))
            })
        }, tolerance: px(3), failure: .header)
        let title = CGRect(x: divider+px(10), y: px(12),
                           width: min(px(400), w-divider-px(120)), height: min(px(36), headerY-px(16)))
        guard title.width >= CGFloat(px(30)), title.height >= CGFloat(px(18)),
              CGRect(x: 0, y: 0, width: w, height: h).contains(title) else {
            throw MinimalSessionError.layoutUnverified
        }
        return HeaderLayout(rectangle: title, pixels: pixels, scale: scale, divider: divider, headerY: headerY)
    }

    private static func uniqueBoundary(range: ClosedRange<Int>, score: (Int) -> Int, tolerance: Int, failure: AutomaticLayoutFailure) throws -> Int {
        let scores = range.map { ($0, score($0)) }
        guard let peak = scores.max(by: { $0.1 < $1.1 }), peak.1 >= 8 else { throw failure }
        let strong = scores.filter { $0.1 >= max(8, peak.1 * 3 / 4) }
        guard strong.allSatisfy({ abs($0.0-peak.0) <= tolerance }) else { throw failure }
        return peak.0
    }
}
