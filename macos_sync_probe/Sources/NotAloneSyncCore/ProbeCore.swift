import CoreGraphics
import Foundation

// 用 0 到 1 的比例描述聊天区域，方便适配不同尺寸的微信窗口。
public struct CropRect: Equatable {
    public let x: Double
    public let y: Double
    public let width: Double
    public let height: Double

    public init(x: Double, y: Double, width: Double, height: Double) throws {
        // 裁剪区域必须完全落在原图范围内。
        guard x >= 0, y >= 0, width > 0, height > 0,
              x + width <= 1, y + height <= 1 else {
            throw ProbeError.invalidCrop
        }

        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }

    public static func parse(_ value: String) throws -> CropRect {
        // 把命令行中的 "x,y,width,height" 文字转换成四个数字。
        let components = value.split(separator: ",").compactMap { Double($0) }
        guard components.count == 4 else {
            throw ProbeError.invalidCrop
        }

        return try CropRect(
            x: components[0],
            y: components[1],
            width: components[2],
            height: components[3]
        )
    }
}

// 当前识别到的文字属于谁。unknown 表示仅靠左右位置无法可靠判断。
public enum Speaker: String {
    case user
    case contact
    case unknown
}

// 目前的一条 OCR 文本片段。未来会增加位置和气泡分组，形成真正的聊天消息。
public struct RecognizedLine: Equatable {
    public let text: String
    public let speaker: Speaker
    public let confidence: Float

    public init(text: String, speaker: Speaker, confidence: Float) {
        self.text = text
        self.speaker = speaker
        self.confidence = confidence
    }
}

// OCR 常会带来多余空格或换行。统一后，"你好" 和 "  你好  " 可以视为同一文本。
public enum TextNormalizer {
    public static func normalize(_ text: String) -> String {
        text
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .split(whereSeparator: { $0.isWhitespace })
            .joined(separator: " ")
    }
}

// 仅在一次 App 运行期间去重，避免同一可见内容被重复报告为“新增”。
public struct LineDeduplicator {
    private var seen: Set<String> = []

    public init() {}

    public mutating func newLines(from lines: [RecognizedLine]) -> [RecognizedLine] {
        var added: [RecognizedLine] = []

        for line in lines {
            let normalizedText = TextNormalizer.normalize(line.text)
            guard !normalizedText.isEmpty else {
                continue
            }

            // 说话人也加入指纹：双方都说“好的”时，仍应算作两条不同文本片段。
            let fingerprint = "\(line.speaker.rawValue)|\(normalizedText)"
            guard seen.insert(fingerprint).inserted else {
                continue
            }

            added.append(line)
        }

        return added
    }
}

// 把底层失败转换成能展示给用户的中文错误说明。
public enum ProbeError: LocalizedError {
    case invalidArguments(String)
    case invalidCrop
    case selfTestFailed(String)
    case weChatNotFrontmost
    case weChatWindowNotFound
    case chatRegionNotFound
    case selectedRowNotFound
    case imageDataUnavailable
    case screenCapturePermissionMissing

    public var errorDescription: String? {
        switch self {
        case .invalidArguments(let message):
            return message
        case .invalidCrop:
            return "裁剪区域必须是 0 到 1 之间的 x,y,width,height，且不能超出窗口。"
        case .selfTestFailed(let message):
            return "自检失败：\(message)"
        case .weChatNotFrontmost:
            return "微信不是当前前台应用，探针不会采集。"
        case .weChatWindowNotFound:
            return "未找到可捕获的微信窗口。"
        case .chatRegionNotFound:
            return "无法确定微信聊天区与会话列表的分隔线，本轮不会进行 OCR。"
        case .selectedRowNotFound:
            return "无法确定左侧选中会话行，本轮不会定位当前会话。"
        case .imageDataUnavailable:
            return "无法读取当前截图的像素数据。"
        case .screenCapturePermissionMissing:
            return "未授予屏幕与系统音频录制权限。请在系统设置中允许启动探针的应用后重试。"
        }
    }
}

// 不需要微信或截图权限的合成自检，用来确认基础规则没有被改坏。
public enum CoreSelfTest {
    public static func run() throws {
        guard TextNormalizer.normalize("  今天   下雨\n") == "今天 下雨" else {
            throw ProbeError.selfTestFailed("文本空白规范化")
        }

        do {
            _ = try CropRect(x: 0.7, y: 0.1, width: 0.4, height: 0.8)
            throw ProbeError.selfTestFailed("越界裁剪未被拒绝")
        } catch ProbeError.invalidCrop {
            // 预期行为：越界的区域必须被拒绝。
        }

        var deduplicator = LineDeduplicator()
        let contactLine = RecognizedLine(text: "你好", speaker: .contact, confidence: 0.9)
        let duplicate = RecognizedLine(text: "  你好  ", speaker: .contact, confidence: 0.8)
        let userLine = RecognizedLine(text: "你好", speaker: .user, confidence: 0.9)

        guard deduplicator.newLines(from: [contactLine]) == [contactLine] else {
            throw ProbeError.selfTestFailed("首条消息未加入")
        }
        guard deduplicator.newLines(from: [duplicate, userLine]) == [userLine] else {
            throw ProbeError.selfTestFailed("去重或说话人隔离")
        }

        guard let firstImage = syntheticWindowImage(dividerX: 72),
              let firstRegion = ChatRegionDetector.detect(in: firstImage) else {
            throw ProbeError.selfTestFailed("三条边界初次定位")
        }
        guard abs((firstRegion.dividerX ?? 0) - 72) <= 3,
              abs((firstRegion.headerDividerY ?? 0) - 30) <= 3,
              abs((firstRegion.composerDividerY ?? 0) - 145) <= 3 else {
            throw ProbeError.selfTestFailed(
                "三条边界坐标 x=\(firstRegion.dividerX ?? -1), "
                    + "top=\(firstRegion.headerDividerY ?? -1), "
                    + "bottom=\(firstRegion.composerDividerY ?? -1)"
            )
        }
        guard ChatRegionDetector.isRegionStillValid(in: firstImage, region: firstRegion) else {
            throw ProbeError.selfTestFailed("缓存三条边界验证")
        }

        // 窗口更靠下的位置可能有对比度更强的边缘；仍应选择最早出现的输入区顶线。
        guard let strongerLowerEdgeImage = syntheticWindowImage(
            dividerX: 72,
            hasStrongerLowerEdge: true
        ), let strongerLowerEdgeRegion = ChatRegionDetector.detect(in: strongerLowerEdgeImage),
              abs((strongerLowerEdgeRegion.composerDividerY ?? 0) - 145) <= 3,
              ChatRegionDetector.isRegionStillValid(
                  in: strongerLowerEdgeImage,
                  region: strongerLowerEdgeRegion
              ) else {
            throw ProbeError.selfTestFailed("输入区顶线优先于更强的底边")
        }

        guard let movedImage = syntheticWindowImage(dividerX: 126),
              let movedRegion = ChatRegionDetector.detect(in: movedImage),
              abs((movedRegion.dividerX ?? 0) - 126) <= 3,
              !ChatRegionDetector.isRegionStillValid(in: movedImage, region: firstRegion) else {
            throw ProbeError.selfTestFailed("分隔线移动后重定位")
        }

        guard let imageWithoutDivider = syntheticWindowImage(dividerX: nil),
              ChatRegionDetector.detect(in: imageWithoutDivider) == nil else {
            throw ProbeError.selfTestFailed("无分隔线时停止 OCR")
        }

        let previewRect = ChatRegionDetector.previewDrawingRect(
            for: CGRect(x: 72, y: 30, width: 220, height: 115),
            imageHeight: 200
        )
        guard previewRect.minX == 72,
              previewRect.minY == 55,
              previewRect.width == 220,
              previewRect.height == 115 else {
            throw ProbeError.selfTestFailed("裁剪预览与 OCR 坐标对齐")
        }

        // 左侧面板出现高亮行时应定位到选中会话行；无高亮时必须返回空。
        guard let rowImage = syntheticWindowImage(dividerX: 72, selectedRowY: 90),
              let row = SelectedSessionLocator.detectSelectedRow(in: rowImage, dividerX: 72) else {
            throw ProbeError.selfTestFailed("选中会话行初次定位")
        }
        guard abs(row.rowRect.minY - 90) <= 2,
              abs(row.rowRect.height - 30) <= 2,
              abs(row.rowRect.width - 72) <= 3 else {
            throw ProbeError.selfTestFailed(
                "选中行几何 y=\(row.rowRect.minY), height=\(row.rowRect.height)"
            )
        }
        for crop in [row.nameRect, row.timeRect, row.previewRect, row.avatarRect] {
            guard crop.minX >= row.rowRect.minX,
                  crop.minY >= row.rowRect.minY,
                  crop.maxX <= row.rowRect.maxX,
                  crop.maxY <= row.rowRect.maxY,
                  crop.width > 0, crop.height > 0 else {
                throw ProbeError.selfTestFailed("选中行裁剪区域越界")
            }
        }

        guard let rowMovedImage = syntheticWindowImage(dividerX: 72, selectedRowY: 140),
              let movedRow = SelectedSessionLocator.detectSelectedRow(in: rowMovedImage, dividerX: 72),
              abs(movedRow.rowRect.minY - 140) <= 2 else {
            throw ProbeError.selfTestFailed("选中行移动后重定位")
        }

        guard let rowlessImage = syntheticWindowImage(dividerX: 72),
              SelectedSessionLocator.detectSelectedRow(in: rowlessImage, dividerX: 72) == nil else {
            throw ProbeError.selfTestFailed("无高亮行时停止定位")
        }

        guard let headerCrop = SelectedSessionLocator.displayNameCrop(
            in: firstImage,
            region: firstRegion
        ), abs(headerCrop.minX - 74) <= 3,
              headerCrop.minY == 0,
              abs(headerCrop.maxY - CGFloat(firstRegion.headerDividerY ?? -1)) <= 0.5 else {
            throw ProbeError.selfTestFailed("顶部 display name 裁剪区")
        }
    }

    private static func syntheticWindowImage(
        dividerX: Int?,
        hasStrongerLowerEdge: Bool = false,
        selectedRowY: Int? = nil
    ) -> CGImage? {
        let width = 300
        let height = 200
        guard let context = CGContext(
            data: nil,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: width * 4,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else {
            return nil
        }

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
            context.fill(CGRect(x: dividerX, y: 0, width: width - dividerX, height: height - 145))
            if hasStrongerLowerEdge {
                context.setFillColor(CGColor(red: 0.04, green: 0.04, blue: 0.04, alpha: 1))
                context.fill(CGRect(x: dividerX, y: 0, width: width - dividerX, height: 20))
            }
        }
        return context.makeImage()
    }
}
