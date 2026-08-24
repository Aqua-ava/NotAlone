import Foundation

// 与后端 HTTP JSON 契约对应的解码模型；字段与 Python 契约测试钉住的
// JSON 结构一一对应。任何字段缺失都视为契约不匹配（失败关闭）。

public struct SyncStatus: Decodable, Equatable, Sendable {
    public let syncEnabled: Bool
    public let phase: String
    public let probeAvailable: Bool
    public let wechatInFront: Bool
    public let cliAvailable: Bool
    public let failureCode: String?
    public let activeContactId: String?
    public let activeBindingDisplayName: String?
    public let decisionReason: String?
    public let batchMessageCount: Int
    public let candidates: [BindingCandidate]
}

public struct BindingCandidate: Decodable, Equatable, Sendable {
    public let username: String
    public let displayName: String
    public let lastTimestamp: Int?
}

public struct ContactEntry: Decodable, Equatable, Sendable, Identifiable {
    public let contactId: String
    public let displayName: String
    public let dataStatus: ContactDataStatus

    public var id: String { contactId }
}

public struct ContactDataStatus: Decodable, Equatable, Sendable {
    public let messageCount: Int
    public let sourceCount: Int
}

public struct ContactsResponse: Decodable, Equatable, Sendable {
    public let contacts: [ContactEntry]
}