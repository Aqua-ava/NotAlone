// 保留旧校准诊断错误码；正式session已按ADR-049自动定位，不再要求profile。
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
        guard arguments.contains("--session") || arguments.contains("--minimal-region")
                || arguments.contains("--single-frame") else {
            return nil
        }
        let supplied = Set(arguments)
        let allowed: Set<String> = ["--session", "--json", "--minimal-region", "--single-frame", "--show-text"]
        guard supplied.count == arguments.count,
              supplied.isSubset(of: allowed), supplied.contains("--session"),
              !supplied.contains("--minimal-region") || supplied.contains("--json"),
              !supplied.contains("--single-frame") || supplied.contains("--json"),
              !supplied.contains("--show-text") || !supplied.contains("--json") else {
            throw SessionInvocationError.invalidArguments
        }
        return SessionInvocation(json: supplied.contains("--json"))
    }
}
