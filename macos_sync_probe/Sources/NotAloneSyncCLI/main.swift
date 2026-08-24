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
    let session: Bool
    let json: Bool

    static let help = """
    用法：
      swift run notalone-sync-probe [--watch] [--interval seconds]
        [--crop x,y,width,height] [--show-text]
      swift run notalone-sync-probe --session [--show-text]
      swift run notalone-sync-probe --session --json

    选项：
      --watch              持续观察前台微信窗口；默认只采集一次。
      --interval seconds   观察间隔，默认 1.0 秒，最小 0.5 秒。
      --crop value         相对微信窗口的聊天区域，默认 0.34,0.10,0.66,0.80。
      --show-text          明确要求后才在终端显示短预览等文本；默认只输出字段有无。
      --session            只做一次选中会话定位，输出顶部 display name 和选中行元数据。
      --json               与 --session 配合输出机器可读 JSON，供本机同步驱动解析。
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
        var session = false
        var json = false
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
            case "--session":
                session = true
            case "--json":
                json = true
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
            selfTest: selfTest,
            session: session,
            json: json
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

            if options.session, options.json {
                await printSessionJson()
                return
            }
            if options.json {
                throw ProbeError.invalidArguments("--json 只能与 --session 配合使用。\n\n\(ProbeOptions.help)")
            }
            guard CGPreflightScreenCaptureAccess() else {
                throw ProbeError.screenCapturePermissionMissing
            }

            if options.session {
                // 单次定位当前选中会话：输出匹配用元数据，不读取聊天区域正文。
                let probe = WeChatCaptureProbe()
                let snapshot = try await probe.captureWindowSnapshot()
                let metadata = try probe.selectedSessionMetadata(from: snapshot)
                print("微信在前台：是")
                print("选中会话行：已定位")
                print("顶部 display name：\(metadata.displayName ?? "未识别")")
                print("选中行名字：\(metadata.selectedRowName ?? "未识别")")
                print("最近时间：\(metadata.lastTimeText ?? "未识别")")
                if options.showText {
                    print("短预览：\(metadata.previewText ?? "未识别")")
                } else {
                    print("短预览：\(metadata.previewText == nil ? "未识别" : "已识别（--show-text 显示文本）")")
                }
                return
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

    // 机器可读的单次定位输出：同步驱动按 JSON 解析前台证据。
    // 微信非前台或证据不可读都是正常的稳定状态，用 ok 结果表达；
    // 只有权限缺失等环境错误才返回失败结果。
    @MainActor
    private static func printSessionJson() async {
        guard CGPreflightScreenCaptureAccess() else {
            printJsonLine([
                "ok": false,
                "error": "screen_capture_permission_missing",
            ])
            return
        }

        let probe = WeChatCaptureProbe()
        do {
            let snapshot = try await probe.captureWindowSnapshot()
            do {
                let metadata = try probe.selectedSessionMetadata(from: snapshot)
                var object = metadata.jsonObject()
                object["ok"] = true
                object["wechat_in_front"] = true
                printJsonLine(object)
            } catch ProbeError.selectedRowNotFound, ProbeError.chatRegionNotFound {
                // 选中行或聊天区暂时不可读：返回前台状态但不携带证据。
                printJsonLine(["ok": true, "wechat_in_front": true])
            }
        } catch ProbeError.weChatNotFrontmost {
            printJsonLine(["ok": true, "wechat_in_front": false])
        } catch ProbeError.weChatWindowNotFound {
            // 微信在前台但窗口不可见：同样按证据不可读处理。
            printJsonLine(["ok": true, "wechat_in_front": true])
        } catch {
            printJsonLine(["ok": false, "error": "probe_failed"])
        }
    }

    private static func printJsonLine(_ object: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
              let line = String(data: data, encoding: .utf8) else {
            fputs("探针失败：无法生成 JSON 输出。\n", stderr)
            return
        }
        print(line)
    }
}
