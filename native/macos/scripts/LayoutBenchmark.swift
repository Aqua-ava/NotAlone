// 仅合成图像的布局对照驱动；不采屏、不OCR或连接外部服务。
func synthetic(width: Int, height: Int, scale: Int, mode: Int = 0) -> CGImage {
    let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8,
        bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    context.setFillColor(CGColor(red: 0.61, green: 0.68, blue: 0.72, alpha: 1))
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    if mode != 1 {
        context.setFillColor(CGColor(red: 0.12, green: 0.15, blue: 0.20, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: 300 * scale, height: height))
    }
    if mode != 2 {
        context.setFillColor(CGColor(red: 0.32, green: 0.36, blue: 0.40, alpha: 1))
        context.fill(CGRect(x: 300 * scale, y: height-70*scale,
            width: width-300*scale, height: 70*scale))
    }
    if mode == 3 {
        context.setFillColor(CGColor(red: 0.1, green: 0.1, blue: 0.1, alpha: 1))
        context.fill(CGRect(x: 450*scale, y: 0, width: 90*scale, height: height))
    }
    return context.makeImage()!
}
func baseline(_ image: CGImage, _ size: CGSize) -> String {
    do {
        let result = try Baseline.headerLayout(image, windowSize: size)
        return "\(result.rectangle)|\(result.divider)|\(result.headerY)|\(result.scale)"
    } catch { return "error:\(error)" }
}
func candidate(_ image: CGImage, _ size: CGSize) -> String {
    do {
        let result = try Candidate.headerLayout(image, windowSize: size)
        return "\(result.rectangle)|\(result.divider)|\(result.headerY)|\(result.scale)"
    } catch { return "error:\(error)" }
}
func milliseconds(_ action: () -> String) -> Double {
    let start = DispatchTime.now().uptimeNanoseconds
    let value = action()
    precondition(!value.isEmpty)
    return Double(DispatchTime.now().uptimeNanoseconds-start)/1_000_000
}
func stats(_ values: [Double]) -> [String: Double] {
    let sorted = values.sorted()
    return ["p50_ms": sorted[sorted.count/2],
            "p95_ms": sorted[Int(ceil(Double(sorted.count)*0.95))-1]]
}
@main struct Main {
    static func main() throws {
        var equivalents = 0
        for scale in 1...3 {
            for mode in 0...3 {
                let image = synthetic(width: 900*scale, height: 700*scale, scale: scale, mode: mode)
                let size = CGSize(width: 900, height: 700)
                precondition(baseline(image, size) == candidate(image, size))
                let all = ChatRegionDetector.luminancePixels(from: image)!
                let lazy = LuminanceSampler.create(from: image)!
                for index in stride(from: 0, to: all.count, by: max(1, all.count/10000)) {
                    precondition(all[index] == lazy[index])
                }
                equivalents += 1
            }
        }
        var results: [[String: Any]] = []
        for (w,h,s) in [(1200,800,1),(2400,1600,2),(3600,2400,3),(5120,2880,2)] {
            let image = synthetic(width: w, height: h, scale: s)
            let size = CGSize(width: w/s, height: h/s)
            let expected = baseline(image,size)
            precondition(!expected.hasPrefix("error:"))
            precondition(expected == candidate(image,size))
            for _ in 0..<3 { _ = baseline(image,size); _ = candidate(image,size) }
            var before: [Double] = [], after: [Double] = []
            for i in 0..<31 {
                if i % 2 == 0 {
                    before.append(milliseconds { baseline(image,size) })
                    after.append(milliseconds { candidate(image,size) })
                } else {
                    after.append(milliseconds { candidate(image,size) })
                    before.append(milliseconds { baseline(image,size) })
                }
            }
            results.append(["width":w,"height":h,"scale":s,"pairs":31,
                "baseline":stats(before),"candidate":stats(after),
                "baseline_samples_ms":before,"candidate_samples_ms":after,
                
                "outputs_equal":true])
        }
        let report: [String:Any] = ["equivalence_images":equivalents,
            "scope":"production pure layout functions, synthetic CGImages; no capture/OCR/App timing",
            "results":results]
        let data = try JSONSerialization.data(withJSONObject: report, options: [.sortedKeys,.prettyPrinted])
        print(String(decoding:data,as:UTF8.self))
    }
}
