import AppKit
import CoreGraphics
import Foundation

// stderr只给固定阶段、输入序号及入口后耗时；诊断行不能替代stdout的真实quiet结果。
enum DiagnosticPhase: String {
    case argumentsRejected = "arguments_rejected"
    case applicationLookup = "application_lookup"
    case windowListLookup = "window_list_lookup"
    case windowListUnavailable = "window_list_unavailable"
    case serialization = "serialization"
    case complete = "complete"
}
let enteredAt = DispatchTime.now().uptimeNanoseconds
func checkpoint(_ phase: DiagnosticPhase, ordinal: Int = 0) {
    let record: [String: Any] = [
        "phase": phase.rawValue, "ordinal": ordinal,
        "elapsedMilliseconds": (DispatchTime.now().uptimeNanoseconds - enteredAt) / 1_000_000,
    ]
    guard let data = try? JSONSerialization.data(withJSONObject: record, options: [.sortedKeys]) else { exit(4) }
    FileHandle.standardError.write(Data("quiet_observation_stage: ".utf8))
    FileHandle.standardError.write(data)
    FileHandle.standardError.write(Data([10]))
}

// 只读取本轮浏览器进程的激活状态及屏上窗口数；不截屏、不读取标题、不操作其他应用。
let arguments = CommandLine.arguments.dropFirst()
guard !arguments.isEmpty, arguments.count <= 64 else { checkpoint(.argumentsRejected); exit(2) }
let pids = Set(arguments.compactMap { Int32($0) })
guard pids.count == arguments.count, pids.allSatisfy({ $0 > 0 }) else { checkpoint(.argumentsRejected); exit(2) }
let apps = pids.enumerated().compactMap { ordinal, pid in
    checkpoint(.applicationLookup, ordinal: ordinal)
    return NSRunningApplication(processIdentifier: pid)
}
checkpoint(.windowListLookup)
guard let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
    checkpoint(.windowListUnavailable)
    exit(3)
}
let owned = windows.filter { window in
    guard let owner = window[kCGWindowOwnerPID as String] as? NSNumber else { return false }
    return pids.contains(owner.int32Value)
}
let report: [String: Any] = [
    "active": apps.contains(where: { $0.isActive }),
    "registeredApps": apps.count,
    "activationPolicies": apps.map { $0.activationPolicy.rawValue },
    "onscreenWindows": owned.count,
]
checkpoint(.serialization)
let data = try JSONSerialization.data(withJSONObject: report, options: [.sortedKeys])
FileHandle.standardOutput.write(data)
checkpoint(.complete)
