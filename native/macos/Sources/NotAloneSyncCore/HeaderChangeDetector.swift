import CoreGraphics

// 仅保留上一张局部亮度像素；变化是重做正式观察的提示，不能确认身份。
struct HeaderChangeDetector {
    private var previous: [UInt8]?
    private var dimensions: CGSize?

    mutating func accept(_ pixels: [UInt8], width: Int, height: Int) throws -> Bool {
        guard (1...1200).contains(width), (1...108).contains(height),
              pixels.count == width * height else { reset(); throw HeaderChangeFailure.invalidFrame }
        let size = CGSize(width: width, height: height)
        guard let before = previous, dimensions == size else {
            previous = pixels; dimensions = size; return false
        }
        previous = pixels
        // 单像素噪点和小幅亮度抖动不触发；门槛不是联系人或文字相似度。
        let changed = zip(before, pixels).reduce(0) { $0 + (abs(Int($1.0) - Int($1.1)) >= 16 ? 1 : 0) }
        return changed >= max(8, pixels.count / 1000)
    }

    mutating func reset() { previous = nil; dimensions = nil }
}

enum HeaderChangeFailure: Error { case invalidFrame, unsupportedGeometry, contextChanged }
