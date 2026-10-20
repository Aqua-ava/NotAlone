import CoreGraphics
import XCTest
@testable import NotAloneSyncCore

final class LuminanceSamplerTests: XCTestCase {
    func testKnownPremultipliedRGBAValuesKeepIntegerRounding() throws {
        let bytes: [UInt8] = [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255,
                              255, 255, 255, 255, 0, 0, 0, 0, 128, 0, 0, 128]
        let image = try XCTUnwrap(CGImage(width: 6, height: 1, bitsPerComponent: 8,
            bitsPerPixel: 32, bytesPerRow: 24, space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
            provider: CGDataProvider(data: Data(bytes) as CFData)!, decode: nil,
            shouldInterpolate: false, intent: .defaultIntent))
        let pixels = try XCTUnwrap(LuminanceSampler.create(from: image))
        XCTAssertEqual((0..<6).map { pixels[$0] }, [53, 182, 18, 255, 0, 27])
    }

    func testEveryPixelMatchesFrozenBaselineAcrossColorSpacesAlphaAndRowPadding() throws {
        for name in [CGColorSpace.sRGB, CGColorSpace.displayP3, CGColorSpace.linearSRGB] {
            let space = try XCTUnwrap(CGColorSpace(name: name))
            let width = 19, height = 13, rowBytes = width * 4 + 8
            var bytes = [UInt8](repeating: 251, count: rowBytes * height)
            for y in 0..<height { for x in 0..<width {
                let index = y * width + x, alpha = (index * 59) % 256
                let offset = y * rowBytes + x * 4
                bytes[offset] = UInt8((index * 37) % (alpha + 1))
                bytes[offset + 1] = UInt8((index * 71) % (alpha + 1))
                bytes[offset + 2] = UInt8((index * 113) % (alpha + 1))
                bytes[offset + 3] = UInt8(alpha)
            } }
            let image = try XCTUnwrap(CGImage(width: width, height: height, bitsPerComponent: 8,
                bitsPerPixel: 32, bytesPerRow: rowBytes, space: space,
                bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
                provider: CGDataProvider(data: Data(bytes) as CFData)!, decode: nil,
                shouldInterpolate: false, intent: .defaultIntent))
            let expected = try XCTUnwrap(baselineLuminance(from: image))
            let pixels = try XCTUnwrap(LuminanceSampler.create(from: image))
            XCTAssertEqual((0..<(width * height)).map { pixels[$0] }, expected)
            XCTAssertEqual(ChatRegionDetector.luminancePixels(from: image), expected)
        }
    }

    func testGrayscaleInputKeepsBaselineColorConversion() throws {
        let bytes = (0..<77).map { UInt8(($0 * 19) % 256) }
        let image = try XCTUnwrap(CGImage(width: 11, height: 7, bitsPerComponent: 8,
            bitsPerPixel: 8, bytesPerRow: 11, space: CGColorSpaceCreateDeviceGray(),
            bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.none.rawValue),
            provider: CGDataProvider(data: Data(bytes) as CFData)!, decode: nil,
            shouldInterpolate: false, intent: .defaultIntent))
        let expected = try XCTUnwrap(baselineLuminance(from: image))
        let pixels = try XCTUnwrap(LuminanceSampler.create(from: image))
        XCTAssertEqual((0..<77).map { pixels[$0] }, expected)
    }

    // 固定主线681fcc38的转换，独立于候选实现，防止比较双方一起漂移。
    private func baselineLuminance(from image: CGImage) -> [UInt8]? {
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

}
