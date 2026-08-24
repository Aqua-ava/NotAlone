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

// MARK: - 消息流

public struct MessagePage: Decodable, Equatable, Sendable {
    public let messages: [MessageEntry]
    public let nextCursor: String?
}

public struct MessageEntry: Decodable, Equatable, Sendable, Identifiable {
    public let messageId: String
    public let speaker: String
    public let messageType: String
    public let text: String
    public let mediaPlaceholder: String?
    public let occurredAt: String?
    public let quoted: QuotedMessage?

    public var id: String { messageId }
}

// 引用消息：正文与被引用内容是两段不同证据；目标缺失时保持未解析。
public struct QuotedMessage: Decodable, Equatable, Sendable {
    public let text: String
    public let targetMessageId: String?
}

// MARK: - 回复

public struct ReplyGenerated: Decodable, Equatable, Sendable {
    public let replyRequestId: String
    public let candidates: [ReplyCandidate]
    public let contextReceipt: ContextReceipt?
    public let usedSkill: UsedSkill?

    public struct ContextReceipt: Decodable, Equatable, Sendable {
        public let evidenceIds: [String]
    }

    public struct UsedSkill: Decodable, Equatable, Sendable {
        public let skillId: String
        public let versionId: String
        public let name: String
        public let selectionMethod: String?
        public let selectionReason: String?
        public let loadState: String?
    }
}

public struct ReplyCandidate: Decodable, Equatable, Sendable, Identifiable {
    public let candidateId: String
    public let text: String
    public let basis: String
    public let citationIds: [String]
    public let riskNotes: [String]

    public var id: String { candidateId }
}

// MARK: - 记忆

public struct MemoryEntry: Decodable, Equatable, Sendable, Identifiable {
    public let memoryId: String
    public let level: String
    public let contactId: String?
    public let text: String
    public let category: String
    public let topic: String
    public let adoptionMethod: String
    public let status: String
    public let revision: Int?
    public let validAt: String?
    public let invalidAt: String?

    public var id: String { memoryId }
}

public struct MemoryCandidateEntry: Decodable, Equatable, Sendable, Identifiable {
    public let candidateId: String
    public let text: String
    public let category: String
    public let topic: String
    public let status: String

    public var id: String { candidateId }
}

public struct MemoryListResponse: Decodable, Sendable {
    public let memories: [MemoryEntry]
}

public struct MemoryCandidateListResponse: Decodable, Sendable {
    public let candidates: [MemoryCandidateEntry]
}

public struct MemoryMutationResponse: Decodable, Sendable {
    public let memory: MemoryEntry
}

public struct MemoryDiscardResponse: Decodable, Sendable {
    public let candidateId: String
}