import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

// 为传统 macOS .icns 显式绘制圆角与透明留边，保留原 Logo 的比例和内容。
guard CommandLine.arguments.count == 3 else {
    fatalError("用法：swift scripts/render-app-icon.swift <logo.png> <app-icon.png>")
}
let input = URL(fileURLWithPath: CommandLine.arguments[1])
let output = URL(fileURLWithPath: CommandLine.arguments[2])
guard let source = CGImageSourceCreateWithURL(input as CFURL, nil),
      let logo = CGImageSourceCreateImageAtIndex(source, 0, nil),
      let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
      let context = CGContext(data: nil, width: 1024, height: 1024, bitsPerComponent: 8,
                              bytesPerRow: 0, space: colorSpace,
                              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
    fatalError("无法读取 Logo 或创建图标画布。")
}
let plate = CGPath(roundedRect: CGRect(x: 100, y: 100, width: 824, height: 824),
                   cornerWidth: 185, cornerHeight: 185, transform: nil)
context.saveGState()
context.setShadow(offset: CGSize(width: 0, height: -8), blur: 12,
                  color: CGColor(gray: 0, alpha: 0.18))
context.addPath(plate)
context.setFillColor(CGColor(colorSpace: colorSpace, components: [243.0 / 255, 238.0 / 255, 227.0 / 255, 1])!)
context.fillPath()
context.restoreGState()
context.addPath(plate)
context.clip()
context.interpolationQuality = .high
let scale = min(768 / CGFloat(logo.width), 768 / CGFloat(logo.height))
let width = CGFloat(logo.width) * scale
let height = CGFloat(logo.height) * scale
context.draw(logo, in: CGRect(x: (1024 - width) / 2, y: (1024 - height) / 2,
                              width: width, height: height))
guard let image = context.makeImage(),
      let destination = CGImageDestinationCreateWithURL(output as CFURL, UTType.png.identifier as CFString, 1, nil) else {
    fatalError("无法写入 App 图标。")
}
CGImageDestinationAddImage(destination, image, nil)
guard CGImageDestinationFinalize(destination) else { fatalError("App 图标写入失败。") }
