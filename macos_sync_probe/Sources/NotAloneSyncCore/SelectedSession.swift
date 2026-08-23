import CoreGraphics
import Foundation

// 左侧选中会话行的几何定位。只提供匹配证据，不代表联系人身份；
// 重名时由上层用 CLI 候选做比对，定位器本身不做选择。
public struct SelectedRowRegion: Equatable {
    public let rowRect: CGRect

    public init(rowRect: CGRect) {
        self.rowRect = rowRect
    }

    // 头像位于行左侧，名字与预览文本从头像右侧开始。
    private var avatarWidth: CGFloat { rowRect.width * 0.20 }

    // 最近时间显示在行的右上角。
    private var timeWidth: CGFloat { rowRect.width * 0.24 }

    public var nameRect: CGRect {
        let width = rowRect.width - avatarWidth - timeWidth
        return CGRect(
            x: rowRect.minX + avatarWidth,
            y: rowRect.minY + 2,
            width: max(0, width),
            height: max(0, rowRect.height / 2 - 2)
        )
    }

    public var timeRect: CGRect {
        CGRect(
            x: rowRect.maxX - timeWidth,
            y: rowRect.minY + 2,
            width: timeWidth - 2,
            height: max(0, rowRect.height / 2 - 2)
        )
    }

    public var previewRect: CGRect {
        CGRect(
            x: rowRect.minX + avatarWidth,
            y: rowRect.minY + rowRect.height / 2,
            width: rowRect.width - avatarWidth - 2,
            height: max(0, rowRect.height / 2 - 2)
        )
    }

    // 头像区域仅供后续作为备用视觉指纹，默认不保存原始图像。
    public var avatarRect: CGRect {
        CGRect(
            x: rowRect.minX + 2,
            y: rowRect.minY + 2,
            width: max(0, avatarWidth - 4),
            height: max(0, rowRect.height - 4)
        )
    }
}

// 一次前台定位得到的选中会话元数据。所有文本来自同一帧窗口图像。
public struct SelectedSessionMetadata: Equatable {
    public let displayName: String?
    public let selectedRowName: String?
    public let lastTimeText: String?
    public let previewText: String?

    public init(
        displayName: String?,
        selectedRowName: String?,
        lastTimeText: String?,
        previewText: String?
    ) {
        self.displayName = displayName
        self.selectedRowName = selectedRowName
        self.lastTimeText = lastTimeText
        self.previewText = previewText
    }
}

// 在左侧会话列表中寻找唯一的高亮选中行。只读取分隔线左侧面板，
// 不读取整个联系人列表；找不到可靠高亮时返回 nil，由调用方暂停。
public enum SelectedSessionLocator {
    // 会话列表不从窗口最顶端开始，跳过顶部导航区域。
    private static let listTopRatio = 0.12
    // 高亮行与面板背景亮度的最小偏差，低于该值视为无法确定选中行。
    private static let minHighlightDeviation = 10
    // 选中行高度的合理上限，防止把整块面板误判成一行。
    private static let maxRowHeightRatio = 0.30

    public static func detectSelectedRow(
        in image: CGImage,
        dividerX: Int,
        listBottom: Int? = nil
    ) -> SelectedRowRegion? {
        let height = image.height
        guard dividerX >= 20, height >= 80,
              let panel = image.cropping(to: CGRect(
                  x: 0,
                  y: 0,
                  width: dividerX,
                  height: height
              )),
              let luminance = ChatRegionDetector.luminancePixels(from: panel) else {
            return nil
        }

        // 每一像素行的平均亮度：选中高亮会覆盖整行，均值会明显偏离面板背景。
        let listTop = max(2, Int(Double(height) * listTopRatio))
        // 会话行只可能出现在聊天输入区顶线以上；限制下界避免面板内容干扰。
        let scanBottom = min(height - 2, listBottom ?? height - 2)
        guard listTop < scanBottom - 8 else {
            return nil
        }
        var rowMeans: [Int] = []
        rowMeans.reserveCapacity(height)
        for y in 0..<height {
            var sum = 0
            for x in 0..<dividerX {
                sum += Int(luminance[y * dividerX + x])
            }
            rowMeans.append(sum / dividerX)
        }
        let background = ChatRegionDetector.medianOf(Array(rowMeans[listTop..<scanBottom]))

        // 寻找亮度持续偏离背景的最长连续行带；微信同一时刻只高亮一行。
        var bestRange: Range<Int>?
        var currentStart: Int?
        for y in listTop..<scanBottom {
            let isHighlighted = abs(rowMeans[y] - background) >= minHighlightDeviation
            if isHighlighted, currentStart == nil {
                currentStart = y
            } else if !isHighlighted, let start = currentStart {
                if bestRange.map({ y - start > $0.count }) ?? true {
                    bestRange = start..<y
                }
                currentStart = nil
            }
        }
        if let start = currentStart {
            if bestRange.map({ scanBottom - start > $0.count }) ?? true {
                bestRange = start..<scanBottom
            }
        }

        guard let range = bestRange else {
            return nil
        }
        let rowHeight = range.count
        guard rowHeight >= 12, Double(rowHeight) <= Double(height) * maxRowHeightRatio else {
            return nil
        }
        return SelectedRowRegion(
            rowRect: CGRect(x: 0, y: range.lowerBound, width: dividerX, height: rowHeight)
        )
    }

    // 顶部 display name 裁剪区：分隔线右侧、标题分隔线以上的窗口头部。
    public static func displayNameCrop(
        in image: CGImage,
        region: DetectedChatRegion
    ) -> CGRect? {
        guard let dividerX = region.dividerX,
              let headerDividerY = region.headerDividerY,
              dividerX + 8 < image.width, headerDividerY >= 8 else {
            return nil
        }
        return CGRect(x: dividerX + 2, y: 0, width: image.width - dividerX - 4, height: headerDividerY)
    }
}
