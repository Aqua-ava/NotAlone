// 当前没有可追溯的最小定位区域profile；所有session调用在任何OS动作前失败关闭。
public enum SessionCaptureSafety {
    public static let failureCode = "minimal_region_layout_unverified"
}

public enum SessionInvocationError: Error {
    case invalidArguments
}

public struct SessionInvocation: Equatable {
    public let json: Bool

    // 非session继续既有诊断解析；session不接受采集区域、watch或自检混用绕过安全门禁。
    public static func parse(arguments: [String]) throws -> SessionInvocation? {
        guard arguments.contains("--session") || arguments.contains("--minimal-region") else {
            return nil
        }
        let supplied = Set(arguments)
        let allowed: Set<String> = ["--session", "--json", "--minimal-region", "--show-text"]
        guard supplied.count == arguments.count,
              supplied.isSubset(of: allowed), supplied.contains("--session"),
              !supplied.contains("--minimal-region") || supplied.contains("--json"),
              !supplied.contains("--show-text") || !supplied.contains("--json") else {
            throw SessionInvocationError.invalidArguments
        }
        return SessionInvocation(json: supplied.contains("--json"))
    }
}
