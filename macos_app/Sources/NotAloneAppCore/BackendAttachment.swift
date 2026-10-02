// 已验证的运行时连接独立于 App 是否拥有其 Process；重复探测不重复初始化。
public struct BackendAttachment: Sendable {
    public private(set) var connection: BackendConnection?
    // 失联只重置初始化状态；退出仍对同一已验证运行时尝试认证关闭。
    public private(set) var shutdownConnection: BackendConnection?

    public init() {}

    /// 新连接或真实断线后的恢复需要初始化；同一已连接运行时只初始化一次。
    public mutating func attach(_ connection: BackendConnection) -> Bool {
        guard self.connection != connection else { return false }
        self.connection = connection
        shutdownConnection = connection
        return true
    }

    public mutating func disconnect() {
        connection = nil
    }
}
