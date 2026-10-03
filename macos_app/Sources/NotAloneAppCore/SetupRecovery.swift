import Foundation

// 初始化查询与后续业务启动共享同一份请求凭证。
public struct SetupRecovery: Sendable {
    public struct Request: Equatable, Sendable {
        public let connection: BackendConnection
        fileprivate let connectionGeneration: UUID
        fileprivate let id: UUID
    }

    private var connection: BackendConnection?
    private var connectionGeneration = UUID()
    private var latestRequest: Request?
    private var inFlight = false
    private var knownStatus: SetupStatus?

    public init() {}

    /// 更新已验证的连接；传 nil 表示失联或退出，同连接重复更新保留查询状态。
    public mutating func connect(_ connection: BackendConnection?) {
        guard self.connection != connection else { return }
        self.connection = connection
        connectionGeneration = UUID()
        latestRequest = nil
        inFlight = false
        knownStatus = nil
    }

    /// 只在初始化状态未知且没有进行中请求时领取查询资格。
    public mutating func beginQuery() -> Request? {
        guard let connection, !inFlight, knownStatus == nil else { return nil }
        return beginRequest(connection: connection)
    }

    /// 明确未初始化后，仅由用户提交向导领取设置请求资格。
    public mutating func beginSetup() -> Request? {
        guard let connection, !inFlight, knownStatus?.initialized == false else { return nil }
        return beginRequest(connection: connection)
    }

    private mutating func beginRequest(connection: BackendConnection) -> Request {
        let request = Request(
            connection: connection,
            connectionGeneration: connectionGeneration,
            id: UUID()
        )
        latestRequest = request
        inFlight = true
        return request
    }

    /// nil 表示请求失败；保留已有状态，旧请求或重复完成返回 false。
    public mutating func finish(_ request: Request, status: SetupStatus?) -> Bool {
        guard isCurrent(request), inFlight else { return false }
        inFlight = false
        if let status { knownStatus = status }
        return true
    }

    /// 请求完成后仍可校验后续异步结果；换连接、退出或新请求会使凭证失效。
    public func isCurrent(_ request: Request) -> Bool {
        request.connectionGeneration == connectionGeneration && latestRequest == request
    }
}
