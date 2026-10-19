import CoreGraphics
import Foundation

// 这是去除孤立彩色尾区后的文字线索；几何检测不能证明尾区是 emoji 或确认联系人身份。
struct HeaderTextFallback {
    let version = "isolated-color-tail-v1"
    let text: String
    let confidence: Double
    let textComplete: Bool
    let maskVerified: Bool

    init(_ recognized: HeaderOcrResult) {
        text = recognized.text
        confidence = recognized.confidence
        textComplete = recognized.isComplete
        maskVerified = true
    }

    var protocolValue: [String: Any] {
        ["version": version, "text": text, "confidence": confidence,
         "text_complete": textComplete, "mask_verified": maskVerified]
    }
}

enum HeaderTextFallbackGeometry {
    // 只接受标准36pt标题片，较矮的裁片不能可靠反推像素比例，因此保守拒绝回退。
    static func maskedImage(_ image: CGImage, raw: HeaderOcrResult) -> CGImage? {
        let width = image.width, height = image.height
        let scale = Double(height) / 36
        guard raw.isComplete, !raw.text.isEmpty, (1...3).contains(scale),
              Double(width) / scale >= 30, Double(width) / scale <= 400,
              let space = CGColorSpace(name: CGColorSpace.sRGB),
              let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8,
                  bytesPerRow: width * 4, space: space,
                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue),
              let buffer = context.data?.assumingMemoryBound(to: UInt8.self) else { return nil }
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        let pixels = UnsafeBufferPointer(start: buffer, count: width * height * 4)
        func rgb(_ x: Int, _ y: Int) -> [Int] {
            let offset = (y * width + x) * 4
            return [Int(pixels[offset]), Int(pixels[offset + 1]), Int(pixels[offset + 2])]
        }
        let cornerSize = max(1, Int(scale.rounded(.up)))
        var corners: [[Int]] = []
        for x in [0, width - cornerSize] {
            for y in [0, height - cornerSize] {
                for dx in 0..<cornerSize { for dy in 0..<cornerSize {
                    guard pixels[((y + dy) * width + x + dx) * 4 + 3] >= 250 else { return nil }
                    corners.append(rgb(x + dx, y + dy))
                } }
            }
        }
        let background = (0..<3).map { channel in corners.reduce(0) { $0 + $1[channel] } / corners.count }
        guard background.max()! - background.min()! <= 12,
              corners.allSatisfy({ color in zip(color, background).allSatisfy { abs($0 - $1) <= 12 } }) else { return nil }

        var inkColumns = [Bool](repeating: false, count: width)
        var grayColumns = [Bool](repeating: false, count: width)
        var colorMin = width, colorMax = -1, inkMin = width, inkMax = -1, inkTop = height, inkBottom = -1
        for y in 0..<height { for x in 0..<width {
            let offset = (y * width + x) * 4
            guard pixels[offset + 3] >= 250 else { return nil }
            // 整张标题片逐像素分析，使用标量避免每像素建立数组。
            let red = Int(pixels[offset]), green = Int(pixels[offset + 1]), blue = Int(pixels[offset + 2])
            let spread = max(red, green, blue) - min(red, green, blue)
            let contrast = max(abs(red - background[0]), abs(green - background[1]), abs(blue - background[2]))
            guard contrast > 24 else { continue }
            inkColumns[x] = true
            inkMin = min(inkMin, x); inkMax = max(inkMax, x)
            inkTop = min(inkTop, y); inkBottom = max(inkBottom, y)
            if spread > 40 { colorMin = min(colorMin, x); colorMax = max(colorMax, x) }
            if spread <= 32 && contrast >= 65 { grayColumns[x] = true }
        } }
        let margin = max(1, Int(scale.rounded(.up)))
        guard colorMax >= colorMin, inkMin > margin, inkMax < width - margin - 1,
              inkTop > margin, inkBottom < height - margin - 1,
              Double(inkBottom - inkTop + 1) <= 24 * scale,
              Double(colorMax - colorMin + 1) <= 64 * scale,
              inkMax <= colorMax + Int((2 * scale).rounded(.up)) else { return nil }

        // 从彩区向左找至少1pt的整列空白；不抹除与前缀相连的笔画。
        var gapCount = 0, separator: Int?
        if colorMin > 0 {
            for x in stride(from: colorMin - 1, through: 0, by: -1) {
                if inkColumns[x] { gapCount = 0 }
                else { gapCount += 1 }
                if gapCount >= margin { separator = x + gapCount; break }
            }
        }
        guard let tailStart = separator, tailStart > inkMin,
              Double(colorMin - tailStart) <= 2 * scale,
              Double(inkMax - tailStart + 1) <= 64 * scale else { return nil }
        let prefixInk = (0..<tailStart).filter { grayColumns[$0] }
        guard let prefixMin = prefixInk.first, let prefixMax = prefixInk.last,
              Double(prefixMax - prefixMin + 1) >= 4 * scale else { return nil }
        for y in 0..<height { for x in tailStart..<width {
            let offset = (y * width + x) * 4
            buffer[offset] = UInt8(background[0]); buffer[offset + 1] = UInt8(background[1])
            buffer[offset + 2] = UInt8(background[2]); buffer[offset + 3] = 255
        } }
        return context.makeImage()
    }
}
