import AppKit
import CoreGraphics
import Foundation

// 只读取本轮浏览器进程的激活状态及屏上窗口数；不截屏、不读取标题、不操作其他应用。
let arguments = CommandLine.arguments.dropFirst()
guard !arguments.isEmpty, arguments.count <= 64 else { exit(2) }
let pids = Set(arguments.compactMap { Int32($0) })
guard pids.count == arguments.count, pids.allSatisfy({ $0 > 0 }) else { exit(2) }
let apps = pids.compactMap { NSRunningApplication(processIdentifier: $0) }
guard let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
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
let data = try JSONSerialization.data(withJSONObject: report, options: [.sortedKeys])
FileHandle.standardOutput.write(data)
