import Foundation

// 消息分页的唯一可变状态；调用方只执行请求并展示结果。
public struct MessagePagination: Sendable {
    public enum Action: Sendable {
        case firstPage
        case history
        case reconcile
    }

    public enum State: Equatable, Sendable {
        case idle
        case loadingFirstPage
        case loadingMore
        case loaded
        case failed(String)
    }

    public struct Request: Equatable, Sendable {
        public let contactId: String
        public let before: String?
        public let limit = 50
        public let action: Action
        fileprivate let generation: UUID
        fileprivate let id: UUID
    }

    public struct Completion: Sendable {
        public let nextRequest: Request?
        public let reconciledCount: Int?
    }

    public private(set) var messages: [MessageEntry] = []
    public private(set) var state: State = .idle
    public var hasMoreMessages: Bool { state == .loaded && historyCursor != nil }
    private var contactId: String?
    private var generation = UUID()
    private var inFlight: Request?
    private var historyCursor: String?
    private var reconciliation: Reconciliation?

    private struct Reconciliation: Sendable {
        let anchorId: String?
        var messages: [MessageEntry] = []
        var ids: Set<String> = []
        var before: String?
        var pagesThisRound = 0
        var pagesTotal = 0
        var cursors: Set<String> = []
    }

    public init() {}

    /// 联系人、来源删除或显式重载改变资料范围时，清空分页并废弃旧凭证。
    public mutating func reset(contactId: String?) {
        self.contactId = contactId
        generation = UUID()
        inFlight = nil
        messages = []
        state = .idle
        historyCursor = nil
        reconciliation = nil
    }

    /// 失联、连接换代或退出时仅废弃在途请求和未接续缓冲，保留已显示历史。
    public mutating func invalidateRequests() {
        generation = UUID()
        inFlight = nil
        reconciliation = nil
        if state == .loadingFirstPage { state = .idle }
        if state == .loadingMore { state = .loaded }
    }

    public mutating func begin(_ action: Action) -> Request? {
        guard let contactId, inFlight == nil else { return nil }
        if action == .history && (state != .loaded || historyCursor == nil) { return nil }
        if action == .reconcile && state != .loaded { return nil }
        if action == .reconcile {
            if reconciliation == nil {
                reconciliation = Reconciliation(anchorId: messages.first?.messageId)
            }
            reconciliation?.pagesThisRound = 0
        }
        let request = registerRequest(
            contactId: contactId,
            before: action == .history ? historyCursor : (action == .reconcile ? reconciliation?.before : nil),
            action: action
        )
        if action == .firstPage { state = .loadingFirstPage }
        if action == .history { state = .loadingMore }
        return request
    }

    public mutating func fail(_ request: Request, description: String) -> Bool {
        guard inFlight == request else { return false }
        inFlight = nil
        if request.action != .reconcile { state = .failed(description) }
        return true
    }

    public mutating func complete(_ request: Request, page: MessagePage) -> Completion? {
        guard inFlight == request else { return nil }
        inFlight = nil
        if request.action == .firstPage {
            var ids = Set<String>()
            messages = page.messages.filter { ids.insert($0.messageId).inserted }
            historyCursor = page.nextCursor
            state = .loaded
        } else if request.action == .history {
            var ids = Set(messages.map(\.messageId))
            messages.append(contentsOf: page.messages.filter { ids.insert($0.messageId).inserted })
            historyCursor = page.nextCursor
            state = .loaded
        } else if var reconciliation {
            reconciliation.pagesThisRound += 1
            reconciliation.pagesTotal += 1
            let anchorIndex = page.messages.firstIndex { $0.messageId == reconciliation.anchorId }
            let incoming = anchorIndex.map { Array(page.messages[..<$0]) } ?? page.messages
            reconciliation.messages.append(contentsOf: incoming.filter { reconciliation.ids.insert($0.messageId).inserted })
            if anchorIndex != nil || reconciliation.anchorId == nil {
                let knownIds = Set(messages.map(\.messageId))
                let fresh = reconciliation.messages.filter { !knownIds.contains($0.messageId) }
                if messages.isEmpty { historyCursor = page.nextCursor }
                messages = fresh + messages
                self.reconciliation = nil
                return Completion(nextRequest: nil, reconciledCount: fresh.count)
            }
            guard let nextCursor = page.nextCursor, !nextCursor.isEmpty,
                  reconciliation.cursors.insert(nextCursor).inserted,
                  reconciliation.pagesTotal < 20 else {
                self.reconciliation = nil
                state = .failed("消息暂时无法接续，请重新加载。")
                return Completion(nextRequest: nil, reconciledCount: nil)
            }
            reconciliation.before = nextCursor
            self.reconciliation = reconciliation
            if reconciliation.pagesThisRound == 10 {
                return Completion(nextRequest: nil, reconciledCount: nil)
            }
            let next = registerRequest(
                contactId: request.contactId,
                before: page.nextCursor,
                action: .reconcile
            )
            return Completion(nextRequest: next, reconciledCount: nil)
        }
        return Completion(nextRequest: nil, reconciledCount: nil)
    }

    private mutating func registerRequest(contactId: String, before: String?, action: Action) -> Request {
        let request = Request(
            contactId: contactId,
            before: before,
            action: action,
            generation: generation,
            id: UUID()
        )
        inFlight = request
        return request
    }
}
