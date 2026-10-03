import Foundation

/// 自动状态查询的资格；调用方在同一执行上下文中管理此值。
public struct BackendStatusPolling {
    public struct Connection: Equatable, Sendable {
        public let address: String
        public let token: String

        public init(address: String, token: String) {
            self.address = address
            self.token = token
        }
    }

    public struct Request: Equatable, Sendable {
        fileprivate let id: UUID
    }

    public struct Scope: Equatable, Sendable {
        fileprivate let id: UUID
    }

    public private(set) var currentScope: Scope?

    private var connection: Connection?
    private var currentRequest: Request?
    private var stopped = false

    public init() {}

    @discardableResult
    public mutating func connect(_ connection: Connection?) -> Bool {
        guard !stopped, self.connection != connection else {
            return false
        }
        self.connection = connection
        currentScope = connection == nil ? nil : Scope(id: UUID())
        currentRequest = nil
        return true
    }

    public mutating func begin() -> Request? {
        guard connection != nil, currentRequest == nil else {
            return nil
        }
        let request = Request(id: UUID())
        currentRequest = request
        return request
    }

    public func isCurrent(_ request: Request) -> Bool {
        currentRequest == request
    }

    @discardableResult
    public mutating func invalidateRequest(in scope: Scope) -> Bool {
        guard currentScope == scope else {
            return false
        }
        currentRequest = nil
        return true
    }

    @discardableResult
    public mutating func finish(_ request: Request) -> Bool {
        guard currentRequest == request else {
            return false
        }
        currentRequest = nil
        return true
    }

    public mutating func stop() {
        stopped = true
        connection = nil
        currentScope = nil
        currentRequest = nil
    }
}
