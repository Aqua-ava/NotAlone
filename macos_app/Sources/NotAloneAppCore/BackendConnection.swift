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

    // 握手只允许后端实际输出的 IPv4 回环地址和端口；按字段构造 URL，
    // 不让 userinfo、路径或编码后的主机改变凭据发送目标。
    var localBaseURL: URL? {
        let fields = address.split(separator: ":", omittingEmptySubsequences: false)
        guard fields.count == 2, fields[0] == "127.0.0.1",
              !fields[1].isEmpty,
              fields[1].utf8.allSatisfy({ $0 >= 48 && $0 <= 57 }),
              let port = Int(fields[1]), (1...65535).contains(port) else {
            return nil
        }
        var components = URLComponents()
        components.scheme = "http"
        components.host = "127.0.0.1"
        components.port = port
        return components.url
    }

    public static func infoPath() -> URL {
        let override = ProcessInfo.processInfo.environment["NOTALONE_BACKEND_INFO"]
        if let override, !override.isEmpty {
            return URL(fileURLWithPath: expandedPath(override)).standardizedFileURL
        }
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return URL(fileURLWithPath: expandedPath("~/.notalone/backend.info"))
            .standardizedFileURL
    }

    private static func expandedPath(_ path: String) -> String {
        // URL(fileURLWithPath:) 与 standardizedFileURL 都不展开 "~"，
        // 也不带前导 "/" 的路径按当前工作目录解析：Finder 启动时
        // CWD=/ 会把默认路径解析成 "/~/.notalone/backend.info"，握手
        // 文件读取与"复用既有后端"探测整体失效。显式展开到用户主目录。
        if path == "~" || path.hasPrefix("~/") {
            let home = FileManager.default.homeDirectoryForCurrentUser.path
            return home + path.dropFirst()
        }
        return path
    }

    // 解析握手文本：既支持握手文件的分行格式，也支持后端 stdout
    // 使用的 "address=... token=..." 单行格式；任一字段缺失返回 nil。
    public static func parseHandshake(_ text: String) -> BackendConnection? {
        var address: String?
        var token: String?
        for line in text.split(whereSeparator: { $0.isNewline }) {
            for field in line.split(whereSeparator: { $0 == " " || $0 == "\t" }) {
                if field.hasPrefix("address=") {
                    address = String(field.dropFirst("address=".count))
                } else if field.hasPrefix("token=") {
                    token = String(field.dropFirst("token=".count))
                }
            }
        }
        guard let address, let token, !address.isEmpty, !token.isEmpty else {
            return nil
        }
        let connection = BackendConnection(address: address, token: token)
        guard connection.localBaseURL != nil else { return nil }
        return connection
    }

    public static func read(from path: URL) throws -> BackendConnection? {
        let data = try Data(contentsOf: path)
        guard let text = String(data: data, encoding: .utf8) else {
            return nil
        }
        return parseHandshake(text)
    }
}
