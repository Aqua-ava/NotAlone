import Foundation

// 只访问 127.0.0.1 的本地后端 HTTP 客户端。Swift 端不做自动化测试，
// JSON 契约由服务端契约测试钉住（见 spec Testing Decisions）。
public struct BackendClient: Sendable {
    public enum BackendError: Error, Equatable {
        case badStatus(Int)
        case syncUnavailable
        case notFound
        case confirmRejected(reason: String)
        case replyRejected(reason: String)
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

    // 生成候选回复：reply_to_message（选中消息+表达方向）或
    // rewrite_draft（用户原句+改写要求）。请求带幂等键，重放返回同一结果。
    public func generateReply(
        contactId: String,
        idempotencyKey: String,
        replyToMessage: (targetMessageId: String, direction: String)?,
        rewriteDraft: (draftText: String, userInstruction: String?, includeContext: Bool)?,
        continuedFromCandidateId: String? = nil,
        skillVersionId: String? = nil
    ) async throws -> ReplyGenerated {
        var content: [String: Any]
        if let replyToMessage {
            content = [
                "type": "reply_to_message",
                "target_message_id": replyToMessage.targetMessageId,
                "direction": replyToMessage.direction,
                "direction_source": "direct_input",
            ]
        } else if let rewriteDraft {
            content = [
                "type": "rewrite_draft",
                "draft_text": rewriteDraft.draftText,
                "include_relationship_context": rewriteDraft.includeContext,
            ]
            if let userInstruction = rewriteDraft.userInstruction {
                content["user_instruction"] = userInstruction
            }
        } else {
            throw BackendError.malformedResponse
        }
        var payload: [String: Any] = [
            "idempotency_key": idempotencyKey,
            "contact_id": contactId,
            "content": content,
        ]
        if let continuedFromCandidateId {
            payload["continued_from_candidate_id"] = continuedFromCandidateId
        }
        if let skillVersionId, !skillVersionId.isEmpty {
            payload["skill_version_id"] = skillVersionId
        }
        // 幂等键应每次生成唯一；调用方如传空由服务端拒绝。
        guard let data = try? JSONSerialization.data(withJSONObject: payload) else {
            throw BackendError.malformedResponse
        }
        guard let url = URL(string: "api/reply/generate", relativeTo: baseURL) else {
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
        if status == 409 {
            // 回复被业务拒绝：带出稳定 reason 码供界面展示原因。
            let reason = (try? JSONDecoder.snakeCaseDecoder.decode(
                RejectionEnvelope.self,
                from: bodyData
            ))?.reason ?? "unknown"
            throw BackendError.replyRejected(reason: reason)
        }
        guard status == 200 else {
            throw BackendError.badStatus(status)
        }
        do {
            return try JSONDecoder.snakeCaseDecoder.decode(ReplyGenerated.self, from: bodyData)
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

    // MARK: - 记忆

    public func contactMemories(contactId: String) async throws -> [MemoryEntry] {
        let response: MemoryListResponse = try await request(
            path: "api/contacts/\(contactId)/memories",
            method: "GET"
        )
        return response.memories
    }

    public func pendingMemoryCandidates(contactId: String) async throws -> [MemoryCandidateEntry] {
        let response: MemoryCandidateListResponse = try await request(
            path: "api/contacts/\(contactId)/memory-candidates",
            method: "GET"
        )
        return response.candidates
    }

    public func ownerMemories() async throws -> [MemoryEntry] {
        let response: MemoryListResponse = try await request(
            path: "api/memories/owner",
            method: "GET"
        )
        return response.memories
    }

    public func addManualContactMemory(
        contactId: String,
        text: String,
        category: String,
        topic: String = "other"
    ) async throws -> MemoryEntry {
        let payload: [String: Any] = [
            "contact_id": contactId,
            "text": text,
            "category": category,
            "topic": topic,
        ]
        let response: MemoryMutationResponse = try await requestWithBody(
            path: "api/memories/manual-contact",
            method: "POST",
            body: payload
        )
        return response.memory
    }

    public func addManualOwnerMemory(
        text: String,
        category: String,
        topic: String = "other"
    ) async throws -> MemoryEntry {
        let payload: [String: Any] = [
            "text": text,
            "category": category,
            "topic": topic,
        ]
        let response: MemoryMutationResponse = try await requestWithBody(
            path: "api/memories/manual-owner",
            method: "POST",
            body: payload
        )
        return response.memory
    }

    public func confirmMemoryCandidate(contactId: String, candidateId: String) async throws -> MemoryEntry {
        let response: MemoryMutationResponse = try await request(
            path: "api/contacts/\(contactId)/memory-candidates/\(candidateId)/confirm",
            method: "POST"
        )
        return response.memory
    }

    public func discardMemoryCandidate(contactId: String, candidateId: String) async throws {
        let _: MemoryDiscardResponse = try await requestWithBody(
            path: "api/contacts/\(contactId)/memory-candidates/\(candidateId)/discard",
            method: "POST",
            body: [String: Any]()
        )
    }

    public func correctMemory(
        contactId: String,
        memoryId: String,
        text: String,
        category: String? = nil
    ) async throws -> MemoryEntry {
        var payload: [String: Any] = ["text": text]
        if let category {
            payload["category"] = category
        }
        let response: MemoryMutationResponse = try await requestWithBody(
            path: "api/contacts/\(contactId)/memories/\(memoryId)/correct",
            method: "POST",
            body: payload
        )
        return response.memory
    }

    public func deleteContactMemory(contactId: String, memoryId: String) async throws -> MemoryEntry {
        let response: MemoryMutationResponse = try await request(
            path: "api/contacts/\(contactId)/memories/\(memoryId)/delete",
            method: "POST"
        )
        return response.memory
    }

    public func deleteOwnerMemory(memoryId: String) async throws {
        let _: MemoryMutationResponse = try await requestWithBody(
            path: "api/memories/owner/\(memoryId)/delete",
            method: "POST",
            body: [String: Any]()
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

    // 带 JSON 请求体的请求；body 为 [String: Any] 字典。
    private func requestWithBody<T: Decodable>(
        path: String,
        method: String,
        body: [String: Any]
    ) async throws -> T {
        guard let url = URL(string: path, relativeTo: baseURL) else {
            throw BackendError.malformedResponse
        }
        guard let bodyData = try? JSONSerialization.data(withJSONObject: body) else {
            throw BackendError.malformedResponse
        }
        var urlRequest = URLRequest(url: url)
        urlRequest.httpMethod = method
        urlRequest.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        urlRequest.httpBody = bodyData
        let (data, response) = try await URLSession.shared.data(for: urlRequest)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if status == 503 {
            throw BackendError.syncUnavailable
        }
        if status == 404 {
            throw BackendError.notFound
        }
        if status == 409 {
            let reason = (try? JSONDecoder.snakeCaseDecoder.decode(
                RejectionEnvelope.self,
                from: data
            ))?.reason ?? "unknown"
            throw BackendError.replyRejected(reason: reason)
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