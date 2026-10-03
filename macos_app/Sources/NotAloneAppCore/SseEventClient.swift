import Foundation

// 订阅后端 /api/events 的 SSE 客户端。解析 message.created 与
// task.progress 事件；事件不含消息正文，界面拿到 message_id 后再经
// 消息流 API 取详情。断线自动按 Last-Event-ID 重连（服务端以当前
// 状态为准语义）。
public final class SseEventClient: @unchecked Sendable {
    typealias LineStream = AsyncThrowingStream<String, Error>
    typealias LineStreamProvider = @Sendable (URLRequest) async throws -> LineStream

    public struct MessageCreated: Sendable {
        public let eventId: String
        public let ownerId: String
        public let contactId: String
        public let occurredAt: String
        public let messageId: String
    }

    public struct TaskProgress: Sendable {
        public let eventId: String
        public let ownerId: String
        public let contactId: String
        public let occurredAt: String
        public let taskId: String
        public let step: String
        public let status: String
        public let processedCount: Int
        public let attemptCount: Int
        public let retryCount: Int
    }

    public enum Event: Sendable {
        case messageCreated(MessageCreated)
        case taskProgress(TaskProgress)
        // 断线重连成功后的对账信号：调用方应重新拉取最新状态，
        // 因为 message.created 不按 Last-Event-ID 回放。
        case reconnected
    }

    private let connection: BackendConnection
    private let onEvent: @Sendable (Event) async -> Void
    private let lineStreamProvider: LineStreamProvider
    private var task: Task<Void, Never>?
    private var lastEventId: String?

    public convenience init(connection: BackendConnection, onEvent: @escaping @Sendable (Event) async -> Void) {
        self.init(
            connection: connection,
            lineStreamProvider: { request in
                try await Self.urlSessionLineStream(request)
            },
            onEvent: onEvent
        )
    }

    init(
        connection: BackendConnection,
        lineStreamProvider: @escaping LineStreamProvider,
        onEvent: @escaping @Sendable (Event) async -> Void
    ) {
        self.connection = connection
        self.lineStreamProvider = lineStreamProvider
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
        var hasConnected = false
        while !Task.isCancelled {
            let connected = await openAndRead()
            if hasConnected, connected {
                await onEvent(.reconnected)
            }
            hasConnected = hasConnected || connected
            // 断线后短暂退避再重连。
            try? await Task.sleep(nanoseconds: 2_000_000_000)
        }
    }

    /// 成功建立一次事件流返回 true；连接建立失败返回 false。
    private func openAndRead() async -> Bool {
        guard let url = connection.localBaseURL?
            .appendingPathComponent("api/events") else { return false }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("Bearer \(connection.token)", forHTTPHeaderField: "Authorization")
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        if let lastEventId {
            request.setValue(lastEventId, forHTTPHeaderField: "Last-Event-ID")
        }
        var connected = false
        do {
            let lines = try await lineStreamProvider(request)
            connected = true
            var eventId: String?
            var eventType = ""
            var dataLines: [String] = []
            for try await line in lines {
                if Task.isCancelled {
                    return true
                }
                // SSE 帧按空行分隔；逐行累积，遇到空行时派发事件。
                if line.isEmpty {
                    if eventType == "message.created" || eventType == "task.progress" {
                        await dispatch(type: eventType, data: dataLines.joined(separator: "\n"))
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
        // HTTP 连接已经成功打开后，即使服务器正常结束响应或读取期间
        // 断流，也必须让 run() 发出重连对账信号；message.created 不回放。
        return connected
    }

    private static func urlSessionLineStream(_ request: URLRequest) async throws -> LineStream {
        let (bytes, response) = try await URLSession.shared.bytes(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw InvalidSseResponseError()
        }
        return LineStream { continuation in
            let producer = Task {
                do {
                    for try await line in bytes.lines {
                        continuation.yield(line)
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in
                producer.cancel()
            }
        }
    }

    private func dispatch(type: String, data: String) async {
        guard let jsonData = data.data(using: .utf8) else { return }
        do {
            let envelope = try JSONDecoder.snakeCaseDecoder.decode(EventEnvelope.self, from: jsonData)
            switch type {
            case "message.created":
                await onEvent(.messageCreated(envelope.messageCreated))
            case "task.progress":
                await onEvent(.taskProgress(envelope.taskProgress))
            default:
                // 未识别事件类型跳过；消息详情以消息流 API 为准。
                break
            }
        } catch {
            // 无法解析的事件跳过；消息详情以消息流 API 为准。
        }
    }
}

private struct InvalidSseResponseError: Error {}

private struct EventEnvelope: Decodable {
    let id: String
    let ownerId: String
    let contactId: String
    let occurredAt: String
    let type: String
    let payload: Payload

    struct Payload: Decodable {
        let messageId: String?
        let taskId: String?
        let step: String?
        let status: String?
        let processedCount: Int?
        let attemptCount: Int?
        let retryCount: Int?
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

    var taskProgress: SseEventClient.TaskProgress {
        SseEventClient.TaskProgress(
            eventId: id,
            ownerId: ownerId,
            contactId: contactId,
            occurredAt: occurredAt,
            taskId: payload.taskId ?? "",
            step: payload.step ?? "",
            status: payload.status ?? "",
            processedCount: payload.processedCount ?? 0,
            attemptCount: payload.attemptCount ?? 0,
            retryCount: payload.retryCount ?? 0
        )
    }
}
