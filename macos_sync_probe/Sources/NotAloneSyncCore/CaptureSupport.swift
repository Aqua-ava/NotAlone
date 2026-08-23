import AppKit
import CoreGraphics
import CryptoKit
import Foundation
@preconcurrency import ScreenCaptureKit
import Vision

// 微信 App 的稳定系统标识，比窗口标题或联系人昵称更适合用来识别应用本身。
private let weChatBundleIdentifier = "com.tencent.xinWeChat"

// 动态检测到的聊天区域，由左侧会话列表、顶部标题栏和底部输入栏三条边界围成。
public struct DetectedChatRegion {
    public let cropRect: CGRect
    public let dividerX: Int?
    public let headerDividerY: Int?
    public let composerDividerY: Int?
    public let confidence: Double

    public init(
        cropRect: CGRect,
        dividerX: Int?,
        headerDividerY: Int?,
        composerDividerY: Int?,
        confidence: Double
    ) {
        self.cropRect = cropRect
        self.dividerX = dividerX
        self.headerDividerY = headerDividerY
        self.composerDividerY = composerDividerY
        self.confidence = confidence
    }
}

// 单次捕获的内存结果。预览仅供用户主动核对裁剪范围，退出或下一帧后会被替换。
public struct CapturedChatRegion {
    public let chatImage: CGImage
    public let previewImage: CGImage?
    public let detectedDividerX: Int?

    public init(chatImage: CGImage, previewImage: CGImage?, detectedDividerX: Int?) {
        self.chatImage = chatImage
        self.previewImage = previewImage
        self.detectedDividerX = detectedDividerX
    }
}

// 从当前窗口画面的中部寻找持续贯穿的竖向颜色边界，避免依赖可拖动分隔线的固定比例。
public enum ChatRegionDetector {
    // 只在正常微信布局可能出现分隔线的横向区间内搜索，避免把消息气泡或右侧滚动条当成分隔线。
    private static let minDividerRatio = 0.12
    private static let maxDividerRatio = 0.60
    private static let verticalSampleTopRatio = 0.05
    private static let verticalSampleBottomRatio = 0.95
    // 截图像素数组和预览显示同向：顶部标题线对应较小的 y，输入栏上边线对应较大的 y。
    // 搜索范围刻意避开消息内容最密集的中段，防止气泡或图片边缘被误判为横线。
    private static let headerSearchStartRatio = 0.04
    private static let headerSearchEndRatio = 0.18
    private static let composerSearchStartRatio = 0.45
    private static let composerSearchEndRatio = 0.90
    public static func detect(in image: CGImage) -> DetectedChatRegion? {
        let width = image.width
        let height = image.height
        guard width >= 80, height >= 80,
              let luminance = luminancePixels(from: image) else {
            return nil
        }

        let verticalTop = Int(Double(height) * verticalSampleTopRatio)
        let verticalBottom = Int(Double(height) * verticalSampleBottomRatio)
        guard verticalBottom - verticalTop >= 40 else {
            return nil
        }

        // 使用多个纵向采样点的低分位差异值：文字和气泡的边缘只会出现在少数行，
        // 而真正的分隔线会在大部分高度上持续出现。
        let sampleY = (0..<31).map { index in
            verticalTop + (verticalBottom - verticalTop - 1) * index / 30
        }
        let searchStart = max(2, Int(Double(width) * minDividerRatio))
        let searchEnd = min(width - 3, Int(Double(width) * maxDividerRatio))
        guard searchStart < searchEnd else {
            return nil
        }

        var scores: [(x: Int, score: Int)] = []
        for x in searchStart...searchEnd {
            let contrastSamples = sampleY.map { y in
                abs(Int(luminance[y * width + x + 1]) - Int(luminance[y * width + x - 1]))
            }
            scores.append((x: x, score: lowerQuartile(contrastSamples)))
        }

        guard let strongest = scores.max(by: { $0.score < $1.score }) else {
            return nil
        }
        let backgroundScore = median(scores.map(\.score))
        // 不确定时宁可不 OCR；这避免误把左侧列表并入聊天上下文。
        guard isReliableBoundary(strongest.score, backgroundScore: backgroundScore) else {
            return nil
        }

        // 分隔线右边预留少量像素，避免把边框本身送入 OCR，又不切掉左侧消息。
        let leftMargin = max(6, width / 250)
        let chatStart = strongest.x + leftMargin
        let chatEnd = width - max(8, width / 100)
        guard chatStart < chatEnd - 32 else {
            return nil
        }

        // 标题栏高度看似稳定，但 ScreenCaptureKit 返回图像和窗口点数不必保持固定比例。
        // 首次直接识别真实分隔线，后续仅验证缓存的窄条，避免每帧重新扫描整图。
        guard let header = strongestHorizontalBoundary(
            luminance: luminance,
            imageWidth: width,
            imageHeight: height,
            startX: chatStart,
            endX: chatEnd,
            startY: Int(Double(height) * headerSearchStartRatio),
            endY: Int(Double(height) * headerSearchEndRatio)
        ), isReliableBoundary(
            header.score,
            backgroundScore: header.backgroundScore
        ) else {
            return nil
        }

        // 取从上往下遇到的第一条可靠横线，而不是整个下半区最强的线。
        // 输入区顶线之后常有窗口底边，后者对比更强却不是聊天区域下边界。
        let composerStartY = max(
            header.position + max(40, height / 4),
            Int(Double(height) * composerSearchStartRatio)
        )
        let composerEndY = Int(Double(height) * composerSearchEndRatio)
        guard composerStartY < composerEndY,
              let composer = strongestHorizontalBoundary(
            luminance: luminance,
            imageWidth: width,
            imageHeight: height,
            startX: chatStart,
            endX: chatEnd,
            startY: composerStartY,
            endY: composerEndY,
            selection: .firstReliable
        ), isReliableBoundary(composer.score, backgroundScore: composer.backgroundScore) else {
            return nil
        }

        let verticalMargin = max(5, height / 400)
        let contentTop = header.position + verticalMargin
        let contentBottom = composer.position - verticalMargin
        guard contentBottom - contentTop >= 40 else {
            return nil
        }
        let cropRect = CGRect(
            x: chatStart,
            y: contentTop,
            width: chatEnd - chatStart,
            height: contentBottom - contentTop
        )
        return DetectedChatRegion(
            cropRect: cropRect,
            dividerX: strongest.x,
            headerDividerY: header.position,
            composerDividerY: composer.position,
            confidence: Double(min(strongest.score, header.score, composer.score)) / 255.0
        )
    }

    // 缓存的分隔线仍然存在时，只读取它附近 5 个像素宽的窄条，不重新扫描整张图片。
    public static func isDividerStillValid(in image: CGImage, dividerX: Int) -> Bool {
        let width = image.width
        let height = image.height
        let top = Int(Double(height) * verticalSampleTopRatio)
        let bottom = Int(Double(height) * verticalSampleBottomRatio)
        guard dividerX >= 2, dividerX + 2 < width, bottom - top >= 40,
              let strip = image.cropping(to: CGRect(
                  x: dividerX - 2,
                  y: top,
                  width: 5,
                  height: bottom - top
              )),
              let luminance = luminancePixels(from: strip) else {
            return false
        }

        let sampleY = (0..<31).map { index in
            (strip.height - 1) * index / 30
        }
        let contrastSamples = sampleY.map { y in
            abs(Int(luminance[y * strip.width + 3]) - Int(luminance[y * strip.width + 1]))
        }
        return lowerQuartile(contrastSamples) >= 8
    }

    // 缓存有效时只验证三条边界附近的窄条；任一边界变化，调用方才重新扫描全图。
    public static func isRegionStillValid(in image: CGImage, region: DetectedChatRegion) -> Bool {
        guard let dividerX = region.dividerX,
              let headerDividerY = region.headerDividerY,
              let composerDividerY = region.composerDividerY,
              isDividerStillValid(in: image, dividerX: dividerX) else {
            return false
        }
        let headerIsStillValid = isHorizontalBoundaryStillValid(
            in: image,
            boundaryY: headerDividerY,
            startX: Int(region.cropRect.minX)
        )
        return headerIsStillValid && isHorizontalBoundaryStillValid(
            in: image,
            boundaryY: composerDividerY,
            startX: Int(region.cropRect.minX)
        )
    }

    public static func previewImage(
        for image: CGImage,
        region: DetectedChatRegion
    ) -> CGImage? {
        let colorSpace = image.colorSpace ?? CGColorSpaceCreateDeviceRGB()
        guard let context = CGContext(
            data: nil,
            width: image.width,
            height: image.height,
            bitsPerComponent: 8,
            bytesPerRow: image.width * 4,
            space: colorSpace,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else {
            return nil
        }

        context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        context.setStrokeColor(CGColor(red: 1, green: 0.20, blue: 0.16, alpha: 1))
        context.setLineWidth(max(3, CGFloat(image.width) / 500))
        // CGImage.cropping 使用截图像素行（顶部为较小 y），而 CGContext 的路径绘制
        // 使用反向纵坐标。OCR 裁剪本身正确时，这里必须单独镜像，红框才会贴合实际裁剪。
        let previewCropRect = previewDrawingRect(
            for: region.cropRect,
            imageHeight: image.height
        )
        context.stroke(previewCropRect.insetBy(dx: 1, dy: 1))
        if let dividerX = region.dividerX {
            context.move(to: CGPoint(x: dividerX, y: 0))
            context.addLine(to: CGPoint(x: dividerX, y: image.height))
            context.strokePath()
        }
        for boundaryY in [region.headerDividerY, region.composerDividerY].compactMap({ $0 }) {
            let previewY = previewDrawingY(
                forImageRow: boundaryY,
                imageHeight: image.height
            )
            context.move(to: CGPoint(x: region.cropRect.minX, y: previewY))
            context.addLine(to: CGPoint(x: CGFloat(image.width), y: previewY))
            context.strokePath()
        }
        return context.makeImage()
    }

    // 仅供预览层使用：保持横坐标不变，把截图像素行换成 CGContext 的绘制纵坐标。
    static func previewDrawingRect(for cropRect: CGRect, imageHeight: Int) -> CGRect {
        CGRect(
            x: cropRect.minX,
            y: previewDrawingY(
                forImageRow: Int(cropRect.maxY),
                imageHeight: imageHeight
            ),
            width: cropRect.width,
            height: cropRect.height
        )
    }

    static func previewDrawingY(forImageRow imageRow: Int, imageHeight: Int) -> CGFloat {
        CGFloat(imageHeight - imageRow)
    }

    private enum HorizontalBoundarySelection {
        case strongest
        case firstReliable
    }

    private static func strongestHorizontalBoundary(
        luminance: [UInt8],
        imageWidth: Int,
        imageHeight: Int,
        startX: Int,
        endX: Int,
        startY: Int,
        endY: Int,
        selection: HorizontalBoundarySelection = .strongest
    ) -> (position: Int, score: Int, backgroundScore: Int)? {
        let safeStartY = max(2, startY)
        let safeEndY = min(imageHeight - 3, endY)
        guard startX < endX, safeStartY < safeEndY else {
            return nil
        }
        let sampleX = (0..<31).map { index in
            startX + (endX - startX - 1) * index / 30
        }
        var scores: [(position: Int, score: Int)] = []
        for y in safeStartY...safeEndY {
            let contrastSamples = sampleX.map { x in
                abs(Int(luminance[(y + 1) * imageWidth + x]) - Int(luminance[(y - 1) * imageWidth + x]))
            }
            scores.append((position: y, score: lowerQuartile(contrastSamples)))
        }
        let backgroundScore = median(scores.map(\.score))
        let selected: (position: Int, score: Int)?
        switch selection {
        case .strongest:
            selected = scores.max(by: { $0.score < $1.score })
        case .firstReliable:
            selected = scores.first(where: {
                isReliableBoundary($0.score, backgroundScore: backgroundScore)
            })
        }
        guard let selected else {
            return nil
        }
        return (
            position: selected.position,
            score: selected.score,
            backgroundScore: backgroundScore
        )
    }

    private static func isHorizontalBoundaryStillValid(
        in image: CGImage,
        boundaryY: Int,
        startX: Int
    ) -> Bool {
        let width = image.width
        let stripWidth = width - startX - max(8, width / 100)
        guard boundaryY >= 2, boundaryY + 2 < image.height,
              stripWidth >= 40,
              let strip = image.cropping(to: CGRect(
                  x: startX,
                  y: boundaryY - 2,
                  width: stripWidth,
                  height: 5
              )),
              let luminance = luminancePixels(from: strip) else {
            return false
        }
        let sampleX = (0..<31).map { index in
            (strip.width - 1) * index / 30
        }
        let contrastSamples = sampleX.map { x in
            abs(Int(luminance[3 * strip.width + x]) - Int(luminance[strip.width + x]))
        }
        return lowerQuartile(contrastSamples) >= 8
    }

    private static func isReliableBoundary(_ score: Int, backgroundScore: Int) -> Bool {
        score >= 8 && score >= backgroundScore + 5
    }

    // 供同包的选中会话定位器复用：把图片变成逐像素亮度数组。
    static func luminancePixels(from image: CGImage) -> [UInt8]? {
        let width = image.width
        let height = image.height
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        let didDraw = pixels.withUnsafeMutableBytes { rawBuffer -> Bool in
            guard let baseAddress = rawBuffer.baseAddress,
                  let context = CGContext(
                      data: baseAddress,
                      width: width,
                      height: height,
                      bitsPerComponent: 8,
                      bytesPerRow: width * 4,
                      space: CGColorSpaceCreateDeviceRGB(),
                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
                  ) else {
                return false
            }
            context.setBlendMode(.copy)
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
            return true
        }
        guard didDraw else {
            return nil
        }

        var luminance: [UInt8] = []
        luminance.reserveCapacity(width * height)
        for offset in stride(from: 0, to: pixels.count, by: 4) {
            let red = Int(pixels[offset])
            let green = Int(pixels[offset + 1])
            let blue = Int(pixels[offset + 2])
            luminance.append(UInt8((54 * red + 183 * green + 19 * blue) / 256))
        }
        return luminance
    }

    private static func lowerQuartile(_ values: [Int]) -> Int {
        let sorted = values.sorted()
        return sorted[(sorted.count - 1) / 4]
    }

    private static func median(_ values: [Int]) -> Int {
        medianOf(values)
    }

    // 供同包的选中会话定位器复用：计算整数序列的中位数。
    static func medianOf(_ values: [Int]) -> Int {
        let sorted = values.sorted()
        return sorted[sorted.count / 2]
    }
}

// 单次窗口捕获的完整结果。聊天区裁剪与选中会话定位必须使用同一帧图像。
public struct WindowSnapshot {
    public let windowImage: CGImage
    public let region: DetectedChatRegion

    public init(windowImage: CGImage, region: DetectedChatRegion) {
        self.windowImage = windowImage
        self.region = region
    }
}

// 负责“仅当微信在前台时，拿到聊天区域图片”的边界层。
@MainActor
public final class WeChatCaptureProbe {
    // 仅保留给命令行诊断的显式固定裁剪；菜单栏 App 默认使用动态检测。
    private let fixedCrop: CropRect?
    // 菜单栏 App 首次检测后缓存的分隔线；窗口尺寸改变或分隔线被拖动时才替换。
    private var cachedDynamicRegion: (width: Int, height: Int, region: DetectedChatRegion)?

    public init() {
        fixedCrop = nil
    }

    public init(crop: CropRect) {
        fixedCrop = crop
    }

    public func captureWindowSnapshot() async throws -> WindowSnapshot {
        // 第一层隐私门禁：微信不是前台，就完全不查询窗口、不截图。
        guard NSWorkspace.shared.frontmostApplication?.bundleIdentifier == weChatBundleIdentifier else {
            throw ProbeError.weChatNotFrontmost
        }

        // 获取当前屏幕上可共享的窗口列表，只筛选属于微信的窗口。
        let content = try await SCShareableContent.excludingDesktopWindows(
            false,
            onScreenWindowsOnly: true
        )
        guard let window = content.windows
            .filter({ $0.owningApplication?.bundleIdentifier == weChatBundleIdentifier })
            .max(by: { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height }) else {
            throw ProbeError.weChatWindowNotFound
        }

        // 选择最大的微信窗口，一般就是正在使用的主聊天窗口。
        let filter = SCContentFilter(desktopIndependentWindow: window)
        let configuration = SCStreamConfiguration()
        // 使用两倍窗口尺寸，适配高分屏，给 OCR 足够清晰的像素。
        configuration.width = max(1, Int(window.frame.width * 2))
        configuration.height = max(1, Int(window.frame.height * 2))
        let image = try await SCScreenshotManager.captureImage(
            contentFilter: filter,
            configuration: configuration
        )

        let region: DetectedChatRegion
        if let fixedCrop {
            // 命令行用户显式指定时才允许固定裁剪，便于隔离测试算法本身。
            region = DetectedChatRegion(
                cropRect: CGRect(
                    x: CGFloat(fixedCrop.x) * CGFloat(image.width),
                    y: CGFloat(fixedCrop.y) * CGFloat(image.height),
                    width: CGFloat(fixedCrop.width) * CGFloat(image.width),
                    height: CGFloat(fixedCrop.height) * CGFloat(image.height)
                ).integral,
                dividerX: nil,
                headerDividerY: nil,
                composerDividerY: nil,
                confidence: 1
            )
        } else {
            if let cached = cachedDynamicRegion,
               cached.width == image.width,
               cached.height == image.height,
               ChatRegionDetector.isRegionStillValid(in: image, region: cached.region) {
                region = cached.region
            } else {
                guard let detected = ChatRegionDetector.detect(in: image) else {
                    throw ProbeError.chatRegionNotFound
                }
                cachedDynamicRegion = (image.width, image.height, detected)
                region = detected
            }
        }

        return WindowSnapshot(windowImage: image, region: region)
    }

    public func captureChatRegion() async throws -> CapturedChatRegion {
        try chatRegionCapture(from: await captureWindowSnapshot())
    }

    // 从已捕获的同一帧快照裁剪聊天区域，供与选中会话定位共享同一张窗口图像。
    public func chatRegionCapture(from snapshot: WindowSnapshot) throws -> CapturedChatRegion {
        let image = snapshot.windowImage
        let region = snapshot.region

        guard let croppedImage = image.cropping(to: region.cropRect) else {
            throw ProbeError.invalidCrop
        }
        return CapturedChatRegion(
            chatImage: croppedImage,
            previewImage: ChatRegionDetector.previewImage(for: image, region: region),
            detectedDividerX: region.dividerX
        )
    }

    // 从同一帧窗口图像提取顶部 display name 与左侧选中会话行的最小元数据。
    // 找不到选中行时抛出错误；上层应暂停本轮定位，不沿用旧联系人写入。
    public func selectedSessionMetadata(from snapshot: WindowSnapshot) throws -> SelectedSessionMetadata {
        let image = snapshot.windowImage
        guard let dividerX = snapshot.region.dividerX else {
            throw ProbeError.chatRegionNotFound
        }
        guard let row = SelectedSessionLocator.detectSelectedRow(
            in: image,
            dividerX: dividerX,
            listBottom: snapshot.region.composerDividerY
        ) else {
            throw ProbeError.selectedRowNotFound
        }

        let displayName: String?
        if let headerCrop = SelectedSessionLocator.displayNameCrop(in: image, region: snapshot.region),
           let headerImage = image.cropping(to: headerCrop) {
            displayName = try LocalOcr.recognizePlainText(headerImage)
        } else {
            displayName = nil
        }

        func cropText(_ rect: CGRect) throws -> String? {
            guard let subImage = image.cropping(to: rect.integral) else {
                return nil
            }
            return try LocalOcr.recognizePlainText(subImage)
        }

        return SelectedSessionMetadata(
            displayName: displayName,
            selectedRowName: try cropText(row.nameRect),
            lastTimeText: try cropText(row.timeRect),
            previewText: try cropText(row.previewRect)
        )
    }
}

// Vision 是 macOS 自带的文字识别框架；这里完全在本地运行，没有把图片传到网络。
public enum LocalOcr {
    public static func recognize(_ image: CGImage) throws -> [RecognizedLine] {
        let request = VNRecognizeTextRequest()
        // 准确模式比速度模式慢一些，但更适合中文聊天文本。
        request.recognitionLevel = .accurate
        request.recognitionLanguages = ["zh-Hans", "en-US"]
        request.usesLanguageCorrection = false

        let handler = VNImageRequestHandler(cgImage: image)
        try handler.perform([request])

        return (request.results ?? [])
            .compactMap { observation -> (RecognizedLine, CGRect)? in
                // 每个 observation 是一个 OCR 文本片段；它现在不等于一条聊天消息。
                guard let candidate = observation.topCandidates(1).first else {
                    return nil
                }
                let centerX = observation.boundingBox.midX
                let speaker: Speaker
                // 临时用文本在左右两侧的位置猜测说话人，后续会改为按聊天气泡分组。
                if centerX < 0.42 {
                    speaker = .contact
                } else if centerX > 0.58 {
                    speaker = .user
                } else {
                    speaker = .unknown
                }
                return (
                    RecognizedLine(
                        text: candidate.string,
                        speaker: speaker,
                        confidence: candidate.confidence
                    ),
                    observation.boundingBox
                )
            }
            // Vision 的返回顺序不保证是从上到下，因此按纵坐标重新排序。
            .sorted { lhs, rhs in
                if abs(lhs.1.midY - rhs.1.midY) > 0.02 {
                    return lhs.1.midY > rhs.1.midY
                }
                return lhs.1.minX < rhs.1.minX
            }
            .map(\.0)
    }

    // 只拼接纯文本，不判断说话人；用于顶部标题和选中行元数据这类短区域。
    public static func recognizePlainText(_ image: CGImage) throws -> String? {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.recognitionLanguages = ["zh-Hans", "en-US"]
        request.usesLanguageCorrection = false

        let handler = VNImageRequestHandler(cgImage: image)
        try handler.perform([request])

        let texts = (request.results ?? []).compactMap { observation in
            observation.topCandidates(1).first?.string
        }
        let joined = texts
            .map(TextNormalizer.normalize)
            .filter { !$0.isEmpty }
            .joined(separator: " ")
        return joined.isEmpty ? nil : joined
    }
}

// 图片哈希是“画面变化检测器”：相同图片就无需再次做 OCR。
public enum ImageHasher {
    public static func hash(_ image: CGImage) throws -> String {
        guard let providerData = image.dataProvider?.data else {
            throw ProbeError.imageDataUnavailable
        }
        let data = providerData as Data
        // SHA-256 只用于比较两张内存图片是否相同，不会保存原图片数据。
        let digest = SHA256.hash(data: data)
        return digest.map { String(format: "%02x", $0) }.joined()
    }
}
