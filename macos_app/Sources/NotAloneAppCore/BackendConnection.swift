import Foundation

// 后端握手文件中的连接信息：address 与随机 token。
// 文件由 notalone-server 写入，路径可用环境变量
// NOTALONE_BACKEND_INFO 覆盖，默认 ~/.notalone/backend.info。
public struct BackendConnection: Equatable, Sendable {
    public let address: String
    public let token: String

    public init(address: String, token: String) {
        self.address = address
        self.token = token
    }

    public static func infoPath() -> URL {
        if let override = ProcessInfo.processInfo.environment["NOTALONE_BACKEND_INFO"],
           !override.isEmpty {
            return URL(fileURLWithPath: override).standardizedFileURL
        }
        return URL(fileURLWithPath: "~/.notalone/backend.info").standardizedFileURL
    }

    // 解析 "address=...\ntoken=..." 两行握手文件；任一缺失返回 nil。
    public static func read(from path: URL) throws -> BackendConnection? {
        let data = try Data(contentsOf: path)
        guard let text = String(data: data, encoding: .utf8) else {
            return nil
        }
        var address: String?
        var token: String?
        for line in text.split(separator: "\n") {
            let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.hasPrefix("address=") {
                address = String(trimmed.dropFirst("address=".count))
            } else if trimmed.hasPrefix("token=") {
                token = String(trimmed.dropFirst("token=".count))
            }
        }
        guard let address, let token, !address.isEmpty, !token.isEmpty else {
            return nil
        }
        return BackendConnection(address: address, token: token)
    }
}