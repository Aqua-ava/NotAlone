import Foundation

// 订阅后端 /api/events 的 SSE 客户端。只解析 message.created 事件；
// 事件不含消息正文，界面拿到 message_id 后再经消息流 API 取详情。
// 断线自动按 Last-Event-ID 重连（服务端以当前状态为准语义）。
public final class SseEventClient: @unchecked Sendable {
    public struct MessageCreated: Sendable {
        public let eventId: String
        public let ownerId: String
        public let contactId: String
        public let occurredAt: String
        public let messageId: String
    }

    public enum Event: Sendable {
        case messageCreated(MessageCreated)
        // 断线重连成功后的对账信号：调用方应重新拉取最新状态，
        // 因为 message.created 不按 Last-Event-ID 回放。
        case reconnected
    }

    private let connection: BackendConnection
    private let onEvent: @Sendable (Event) async -> Void
    private var task: Task<Void, Never>?
    private var lastEventId: String?

    public init(connection: BackendConnection, onEvent: @escaping @Sendable (Event) async -> Void) {
        self.connection = connection
        self.onEvent = onEvent
    }

    public func start() {
        guard task == nil else { return }
        task = Task { [weak self] in
            await self?.run()
        }
    }

    public func stop() {
        task?.cancel()
        task = nil
    }

    private func run() async {
        var first = true
        while !Task.isCancelled {
            let reconnected = await openAndRead()
            if !first, reconnected {
                await onEvent(.reconnected)
            }
            first = false
            // 断线后短暂退避再重连。
            try? await Task.sleep(nanoseconds: 2_000_000_000)
        }
    }

    /// 成功建立一次事件流返回 true；连接失败或流中断返回 false。
    private func openAndRead() async -> Bool {
        guard let url = URL(string: "http://\(connection.address)")?
            .appendingPathComponent("api/events") else { return false }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("Bearer \(connection.token)", forHTTPHeaderField: "Authorization")
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        if let lastEventId {
            request.setValue(lastEventId, forHTTPHeaderField: "Last-Event-ID")
        }
        do {
            let (bytes, response) = try await URLSession.shared.bytes(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                return false
            }
            var eventId: String?
            var eventType = ""
            var dataLines: [String] = []
            for try await line in bytes.lines {
                if Task.isCancelled {
                    return true
                }
                // SSE 帧按空行分隔；逐行累积，遇到空行时派发事件。
                if line.isEmpty {
                    if eventType == "message.created" {
                        await dispatch(data: dataLines.joined(separator: "\n"))
                        if let eventId {
                            lastEventId = eventId
                        }
                    }
                    eventId = nil
                    eventType = ""
                    dataLines = []
                    continue
                }
                if line.hasPrefix("id:") {
                    eventId = String(line.dropFirst(3)).trimmingCharacters(in: .whitespaces)
                } else if line.hasPrefix("event:") {
                    eventType = String(line.dropFirst(6)).trimmingCharacters(in: .whitespaces)
                } else if line.hasPrefix("data:") {
                    dataLines.append(String(line.dropFirst(5)).trimmingCharacters(in: .whitespaces))
                }
            }
        } catch {
            // 连接失败或流中断：回到 run() 重连。
        }
        return false
    }

    private func dispatch(data: String) async {
        guard let jsonData = data.data(using: .utf8) else { return }
        do {
            let envelope = try JSONDecoder.snakeCaseDecoder.decode(EventEnvelope.self, from: jsonData)
            await onEvent(.messageCreated(envelope.messageCreated))
        } catch {
            // 无法解析的事件跳过；消息详情以消息流 API 为准。
        }
    }
}

private struct EventEnvelope: Decodable {
    let id: String
    let ownerId: String
    let contactId: String
    let occurredAt: String
    let type: String
    let payload: Payload

    struct Payload: Decodable {
        let messageId: String?
    }

    var messageCreated: SseEventClient.MessageCreated {
        SseEventClient.MessageCreated(
            eventId: id,
            ownerId: ownerId,
            contactId: contactId,
            occurredAt: occurredAt,
            messageId: payload.messageId ?? ""
        )
    }
}