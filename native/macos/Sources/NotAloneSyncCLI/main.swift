import Foundation
import NotAloneSyncCore

private struct ProbeHelp {
    static let help = """
    用法：
      swift run notalone-sync-probe --help
      swift run notalone-sync-probe --self-test
      swift run notalone-sync-probe --session
      swift run notalone-sync-probe --session --json [--minimal-region] [--single-frame]
      swift run notalone-sync-probe --session-worker --json
      swift run notalone-sync-probe --screen-capture-permission --json [--request]
      swift run notalone-sync-probe --calibrate-minimal-region --json [--coordinates]
      swift run notalone-sync-probe --verify-minimal-region --json

    选项：
      --session            自动定位当前前台唯一微信窗口；内存分析布局，仅OCR顶部会话名称。
      --preview-session    显式本机可视化预览，由用户点击观察；图帧与文字不保存，8分钟退出。
      --preview-session-name 自动显示当前微信会话名称；仅本机内存处理，20分钟退出。
      --preview-foreground 前台状态悬浮验收，仅查询元数据、不截图或OCR，8分钟退出。
      --session-worker --json  宿主专用：按 stdin 请求单轮观察，空闲60秒退出，不自主采集。
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

}

@main
struct NotAloneSyncCLI {
    @MainActor
    static func main() async {
        do {
            let arguments = Array(CommandLine.arguments.dropFirst())
            if try SessionObservationWorker.accepts(arguments: arguments) {
                exit(await SessionObservationWorker.run() ? EXIT_SUCCESS : EXIT_FAILURE)
            }
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
            switch try ProbeDiagnosticInvocation.parse(arguments: arguments) {
            case .help:
                print(ProbeHelp.help)
            case .selfTest:
                try CoreSelfTest.run()
                print("合成自检通过；未采集屏幕或执行 OCR。")
            }
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
