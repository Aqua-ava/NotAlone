import CoreGraphics

enum HeaderChangeGeometry {
    static func validateOutput(width: Int, height: Int, expectedWidth: Int, expectedHeight: Int) throws {
        guard width == expectedWidth, height == expectedHeight, (1...1200).contains(width),
              (1...108).contains(height) else { throw HeaderChangeFailure.invalidFrame }
    }

    // 先只支持原点主屏与完整可见窗口；不猜测多屏原点、跨屏和离屏裁剪。
    static func sourceRect(headerPixels: CGRect, scale: CGFloat, window: CGRect, display: CGRect) throws -> CGRect {
        guard display.origin == .zero, display.width > 0, display.height > 0,
              [window.minX, window.minY, window.width, window.height, headerPixels.minX, headerPixels.minY,
               headerPixels.width, headerPixels.height, scale].allSatisfy({ $0.isFinite }),
              (1...3).contains(scale), display.contains(window), window.width >= 600, window.height >= 400 else {
            throw HeaderChangeFailure.unsupportedGeometry
        }
        let local = CGRect(x: headerPixels.minX / scale, y: headerPixels.minY / scale,
            width: headerPixels.width / scale, height: headerPixels.height / scale)
        guard CGRect(origin: .zero, size: window.size).contains(local), local.minX >= 180,
              local.minY >= 0, local.maxY <= 60, (30...400).contains(local.width),
              (18...36).contains(local.height) else { throw HeaderChangeFailure.unsupportedGeometry }
        return local.offsetBy(dx: window.minX, dy: window.minY)
    }
}
