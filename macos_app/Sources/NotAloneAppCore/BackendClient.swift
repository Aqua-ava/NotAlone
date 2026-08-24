import Foundation

// 只访问 127.0.0.1 的本地后端 HTTP 客户端。Swift 端不做自动化测试，
// JSON 契约由服务端契约测试钉住（见 spec Testing Decisions）。
public struct BackendClient: Sendable {
    public enum BackendError: Error, Equatable {
        case badStatus(Int)
        case syncUnavailable
        case malformedResponse
        case transport
    }

    private let baseURL: URL
    private let token: String

    public init(connection: BackendConnection) {
        baseURL = URL(string: "http://\(connection.address)")!
        token = connection.token
    }

    // MARK: - 同步状态与控制

    public func syncStatus() async throws -> SyncStatus {
        try await request(path: "/api/sync/status", method: "GET")
    }

    public func enableSync() async throws -> SyncStatus {
        try await request(path: "/api/sync/enable", method: "POST")
    }

    public func disableSync() async throws -> SyncStatus {
        try await request(path: "/api/sync/disable", method: "POST")
    }

    public func checkSync() async throws -> SyncStatus {
        try await request(path: "/api/sync/check", method: "POST")
    }

    // MARK: - 联系人列表

    public func contacts() async throws -> [ContactEntry] {
        let response: ContactsResponse = try await request(
            path: "/api/contacts",
            method: "GET"
        )
        return response.contacts
    }

    // MARK: - 内部

    private func request<T: Decodable>(path: String, method: String) async throws -> T {
        guard let url = URL(string: path, relativeTo: baseURL) else {
            throw BackendError.malformedResponse
        }
        var urlRequest = URLRequest(url: url)
        urlRequest.httpMethod = method
        urlRequest.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let (data, response) = try await URLSession.shared.data(for: urlRequest)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if status == 503 {
            throw BackendError.syncUnavailable
        }
        guard status == 200 else {
            throw BackendError.badStatus(status)
        }
        do {
            return try JSONDecoder.snakeCaseDecoder.decode(T.self, from: data)
        } catch {
            throw BackendError.malformedResponse
        }
    }
}

extension JSONDecoder {
    static var snakeCaseDecoder: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return decoder
    }
}