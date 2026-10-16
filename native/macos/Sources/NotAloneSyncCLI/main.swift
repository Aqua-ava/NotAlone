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
      swift run notalone-sync-probe --session [--show-text]
      swift run notalone-sync-probe --session --json [--minimal-region] [--single-frame]
      swift run notalone-sync-probe --screen-capture-permission --json [--request]
      swift run notalone-sync-probe --calibrate-minimal-region --json [--coordinates]
      swift run notalone-sync-probe --verify-minimal-region --json

    选项：
      --watch              持续观察前台微信窗口；默认只采集一次。
      --interval seconds   观察间隔，默认 1.0 秒，最小 0.5 秒。
      --crop value         相对微信窗口的聊天区域，默认 0.34,0.10,0.66,0.80。
      --show-text          明确要求后才在终端显示短预览等文本；默认只输出字段有无。
      --session            自动定位当前前台微信窗口；内存分析布局，仅OCR两处会话名称。
      --preview-session    显式本机可视化预览，由用户点击观察；图帧与文字不保存，8分钟退出。
      --preview-session-name 自动显示当前微信会话名称；仅本机内存处理，20分钟退出。
      --preview-foreground 前台状态悬浮验收，仅查询元数据、不截图或OCR，8分钟退出。
      --header-change-source --json  宿主专用：最多60秒，只发顶部局部变化/暂停事件，不OCR或保存帧。
      --foreground-status --json  开发诊断：只输出前台分类及前置检查，不创建窗口或采集图像。
      --screen-capture-permission --json  仅静默检查屏幕录制权限，不读取窗口或采集图像。
      --request            仅可追加到权限入口；显式请求后重新检查，不采集图像或OCR。
      --json               与专用入口配合输出机器可读 JSON，供本机宿主解析。
      --minimal-region     仅与 --session --json 配合；保留兼容参数，不使用人工坐标。
      --single-frame       仅与 --session --json 配合；显式要求单帧，输出automatic-header-v3及UTC采集时点。
      --calibrate-minimal-region  用户框选五处最小区域，只输出待校验几何，不截图。
      --coordinates        仅与校准配合，从stdin读取最多4096字节的明确坐标，仅核对元数据。
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
        var seen = Set<String>()

        while index < arguments.count {
            let argument = arguments[index]
            guard seen.insert(argument).inserted else {
                throw ProbeError.invalidArguments("参数不可重复。")
            }
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
            let arguments = Array(CommandLine.arguments.dropFirst())
            if let permission = try ScreenCapturePermissionCommand.run(arguments: arguments) {
                printJsonLine(permission)
                return
            }
            if arguments == ["--header-change-source", "--json"] {
                exit(await HeaderChangeSource.run() ? EXIT_SUCCESS : EXIT_FAILURE)
            }
            if arguments == ["--foreground-status", "--json"] {
                printJsonLine(await ForegroundStatusProbe.observe())
                return
            }
            if arguments == ["--preview-foreground"] {
                ForegroundStatusPreview.run()
                return
            }
            if arguments == ["--preview-session"] {
                SessionCapturePreview.run()
                return
            }
            if arguments == ["--preview-session-name"] {
                SessionCapturePreview.runNames()
                return
            }
            if arguments == ["--verify-minimal-region", "--json"] {
                printJsonLine(await MinimalSessionCapture.verifySelection(try FileHandle.standardInput.read(upToCount: 8193) ?? Data()))
                return
            }
            if arguments == ["--calibrate-minimal-region", "--json", "--coordinates"] {
                var data = Data()
                while data.count <= 4096, let chunk = try FileHandle.standardInput.read(upToCount: 4097 - data.count), !chunk.isEmpty {
                    data.append(chunk)
                }
                printJsonLine(RegionCalibration.selectCoordinates(data))
                return
            }
            if arguments == ["--calibrate-minimal-region", "--json"] {
                printJsonLine(RegionCalibration.run())
                return
            }
            if let session = try SessionInvocation.parse(arguments: arguments) {
                let result = await AutomaticSessionCapture.observe()
                if session.json {
                    printJsonLine(result)
                } else {
                    if result["ok"] as? Bool == true && result["wechat_in_front"] as? Bool == true {
                        print("前台最小区域观察完成；文字仅通过JSON协议传递。")
                    } else { fputs("前台定位安全暂停；请核对布局与屏幕录制权限。\n", stderr) }
                }
                return
            }
            let options = try ProbeOptions.parse(arguments: arguments)
            if options.selfTest {
                try CoreSelfTest.run()
                print("自检通过：动态聊天区域定位、文本规范化和内存去重逻辑正常。")
                return
            }
            _ = NSApplication.shared
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
                } catch ProbeError.screenCapturePermissionMissing {
                    // 权限缺失是环境级错误，重试没有意义；退出。
                    fputs("屏幕录制权限缺失，停止采集。\n", stderr)
                    exit(EXIT_FAILURE)
                } catch {
                    // 窗口不可见、聊天区布局瞬时不可读、OCR 瞬态失败都
                    // 属于跳过本轮的稳定状态；watch 循环保持运行，不能
                    // 被单次瞬态错误终止整个进程。
                    print("[\(captureIndex)] 本轮未采集：\(error.localizedDescription)")
                }

                if options.watch {
                    try await Task.sleep(nanoseconds: UInt64(options.intervalSeconds * 1_000_000_000))
                }
            } while options.watch
        } catch SessionInvocationError.invalidArguments {
            fputs("会话定位参数无效，未检查权限或采集。\n", stderr)
            exit(EXIT_FAILURE)
        } catch ProbeError.invalidArguments(let message) {
            // 参数错误必须走 stderr：--session --json 的 stdout 是
            // 机器可读契约，任何多出来的文本都会让驱动解析失败。
            fputs("\(message)\n", stderr)
            exit(EXIT_FAILURE)
        } catch {
            fputs("探针失败：\(error.localizedDescription)\n", stderr)
            exit(EXIT_FAILURE)
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
