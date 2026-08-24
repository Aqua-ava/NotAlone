import Foundation

// 只访问 127.0.0.1 的本地后端 HTTP 客户端。Swift 端不做自动化测试，
// JSON 契约由服务端契约测试钉住（见 spec Testing Decisions）。
public struct BackendClient: Sendable {
    public enum BackendError: Error, Equatable {
        case badStatus(Int)
        case syncUnavailable
        case notFound
        case confirmRejected(reason: String)
        case malformedResponse
        case transport
    }

    private struct RejectionEnvelope: Decodable {
        let error: String
        let reason: String?
    }

    private let baseURL: URL
    private let token: String

    public init(connection: BackendConnection) {
        baseURL = URL(string: "http://\(connection.address)")!
        token = connection.token
    }

    // MARK: - 同步状态与控制

    public func syncStatus() async throws -> SyncStatus {
        try await request(path: "api/sync/status", method: "GET")
    }

    public func enableSync() async throws -> SyncStatus {
        try await request(path: "api/sync/enable", method: "POST")
    }

    public func disableSync() async throws -> SyncStatus {
        try await request(path: "api/sync/disable", method: "POST")
    }

    public func checkSync() async throws -> SyncStatus {
        try await request(path: "api/sync/check", method: "POST")
    }

    // 完成一次性绑定确认；被拒绝时抛出 confirmRejected(reason)。
    public func confirmBinding(contactId: String, locator: String) async throws -> SyncStatus {
        let payload = ["contact_id": contactId, "locator": locator]
        guard let data = try? JSONSerialization.data(withJSONObject: payload) else {
            throw BackendError.malformedResponse
        }
        guard let url = URL(string: "api/sync/confirm", relativeTo: baseURL) else {
            throw BackendError.malformedResponse
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = data
        let (bodyData, response) = try await URLSession.shared.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if status == 503 {
            throw BackendError.syncUnavailable
        }
        if status == 404 {
            throw BackendError.notFound
        }
        if status == 409 {
            // 绑定确认被拒绝：带出稳定 reason 码供界面展示。
            let reason = (try? JSONDecoder.snakeCaseDecoder.decode(
                RejectionEnvelope.self,
                from: bodyData
            ))?.reason ?? "unknown"
            throw BackendError.confirmRejected(reason: reason)
        }
        guard status == 200 else {
            throw BackendError.badStatus(status)
        }
        do {
            return try JSONDecoder.snakeCaseDecoder.decode(SyncStatus.self, from: bodyData)
        } catch {
            throw BackendError.malformedResponse
        }
    }

    // MARK: - 联系人列表

    public func contacts() async throws -> [ContactEntry] {
        let response: ContactsResponse = try await request(
            path: "api/contacts",
            method: "GET"
        )
        return response.contacts
    }

    // MARK: - 消息流分页

    public func messages(
        contactId: String,
        limit: Int = 50,
        before: String? = nil
    ) async throws -> MessagePage {
        var queryItems = [URLQueryItem(name: "limit", value: "\(limit)")]
        if let before {
            queryItems.append(URLQueryItem(name: "before", value: before))
        }
        return try await request(
            path: "api/contacts/\(contactId)/messages",
            method: "GET",
            queryItems: queryItems
        )
    }

    // MARK: - 内部

    private func request<T: Decodable>(
        path: String,
        method: String,
        queryItems: [URLQueryItem] = []
    ) async throws -> T {
        guard var components = URLComponents(
            url: baseURL.appendingPathComponent(path),
            resolvingAgainstBaseURL: false
        ) else {
            throw BackendError.malformedResponse
        }
        if !queryItems.isEmpty {
            components.queryItems = queryItems
        }
        guard let url = components.url else {
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
        if status == 404 {
            throw BackendError.notFound
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