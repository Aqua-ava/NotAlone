import AppKit
import CoreGraphics
import Foundation
import NotAloneSyncCore

private struct ProbeOptions {
    let crop: CropRect
    let intervalSeconds: Double
    let watch: Bool
    let showText: Bool
    let selfTest: Bool

    static let help = """
    用法：
      swift run notalone-sync-probe [--watch] [--interval seconds]
        [--crop x,y,width,height] [--show-text]

    选项：
      --watch              持续观察前台微信窗口；默认只采集一次。
      --interval seconds   观察间隔，默认 1.0 秒，最小 0.5 秒。
      --crop value         相对微信窗口的聊天区域，默认 0.34,0.10,0.66,0.80。
      --show-text          明确要求后才在终端显示 OCR 文本；默认只输出计数。
      --self-test          运行合成数据自检，不截取屏幕。
      --help               显示本说明。

    该探针只在微信为前台时处理当前窗口。它不保存截图、不写入正式历史、
    不调用模型，也不发送或操作微信。
    """

    static func parse(arguments: [String]) throws -> ProbeOptions {
        var crop = try CropRect(x: 0.34, y: 0.10, width: 0.66, height: 0.80)
        var intervalSeconds = 1.0
        var watch = false
        var showText = false
        var selfTest = false
        var index = 0

        while index < arguments.count {
            let argument = arguments[index]
            switch argument {
            case "--help":
                throw ProbeError.invalidArguments(help)
            case "--watch":
                watch = true
            case "--show-text":
                showText = true
            case "--self-test":
                selfTest = true
            case "--interval", "--crop":
                index += 1
                guard index < arguments.count else {
                    throw ProbeError.invalidArguments("缺少 \(argument) 的参数。\n\n\(help)")
                }

                if argument == "--interval" {
                    guard let value = Double(arguments[index]), value >= 0.5 else {
                        throw ProbeError.invalidArguments("--interval 必须是不小于 0.5 的秒数。")
                    }
                    intervalSeconds = value
                } else {
                    crop = try CropRect.parse(arguments[index])
                }
            default:
                throw ProbeError.invalidArguments("不支持的参数：\(argument)\n\n\(help)")
            }
            index += 1
        }

        return ProbeOptions(
            crop: crop,
            intervalSeconds: intervalSeconds,
            watch: watch,
            showText: showText,
            selfTest: selfTest
        )
    }
}

@main
struct NotAloneSyncCLI {
    @MainActor
    static func main() async {
        do {
            _ = NSApplication.shared
            let options = try ProbeOptions.parse(arguments: Array(CommandLine.arguments.dropFirst()))
            if options.selfTest {
                try CoreSelfTest.run()
                print("自检通过：动态聊天区域定位、文本规范化和内存去重逻辑正常。")
                return
            }
            guard CGPreflightScreenCaptureAccess() else {
                throw ProbeError.screenCapturePermissionMissing
            }

            let probe = WeChatCaptureProbe(crop: options.crop)
            var previousHash: String?
            var deduplicator = LineDeduplicator()
            var captureIndex = 0

            repeat {
                captureIndex += 1
                do {
                    let capture = try await probe.captureChatRegion()
                    let imageHash = try ImageHasher.hash(capture.chatImage)
                    guard imageHash != previousHash else {
                        print("[\(captureIndex)] 画面未变化，跳过 OCR。")
                        try await Task.sleep(nanoseconds: UInt64(options.intervalSeconds * 1_000_000_000))
                        continue
                    }
                    previousHash = imageHash

                    let lines = try LocalOcr.recognize(capture.chatImage)
                    let newLines = deduplicator.newLines(from: lines)
                    print("[\(captureIndex)] 画面变化：识别 \(lines.count) 行，新增 \(newLines.count) 行。")

                    if options.showText {
                        for line in newLines {
                            let confidence = String(format: "%.2f", line.confidence)
                            print("  [\(line.speaker.rawValue), \(confidence)] \(line.text)")
                        }
                    }
                } catch ProbeError.weChatNotFrontmost {
                    print("[\(captureIndex)] 微信不在前台，未采集。")
                }

                if options.watch {
                    try await Task.sleep(nanoseconds: UInt64(options.intervalSeconds * 1_000_000_000))
                }
            } while options.watch
        } catch ProbeError.invalidArguments(let message) {
            print(message)
        } catch {
            fputs("探针失败：\(error.localizedDescription)\n", stderr)
        }
    }
}
