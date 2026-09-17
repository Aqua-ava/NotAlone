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
    // CLI 全量同步与前台 OCR 是两个独立通道；旧后端响应可以不带这些字段。
    public let syncMode: String?
    public let cliSyncPhase: String?
    public let cliSyncMode: String?
    public let cliStreamActive: Bool?
    public let cliBoundCount: Int?
    public let cliPendingCount: Int?
    public let cliBatchMessageCount: Int?
    public let cliFailureCode: String?
    // 后台补齐只展示范围、阶段、计数和可靠游标等元数据，不回显聊天正文。
    public let cliBackfillPhase: String?
    public let cliBackfillContactId: String?
    public let cliBackfillMessageCount: Int?
    public let cliBackfillNonTextCount: Int?
    public let cliBackfillLastCursor: String?
    public let cliBackfillFailureCode: String?
    public let cliBackfillTotalContacts: Int?
    public let cliBackfillCompletedContacts: Int?
    public let cliBackfillSucceededContacts: Int?
    public let cliBackfillSkippedContacts: Int?
    public let cliBackfillFailedContacts: Int?
    public let cliBackfillIncompleteContacts: Int?
    public let cliBackfillPendingContacts: Int?
    public let cliBackfillTotalMessageCount: Int?
    public let cliBackfillTotalNonTextCount: Int?
    public let foregroundPhase: String?
    public let foregroundFailureCode: String?
}

// MARK: - Follow 人工验证

public struct FollowSmokeStatus: Decodable, Equatable, Sendable {
    public let active: Bool
    public let followEnabled: Bool
    public let followStreamActive: Bool
    public let followProcessId: Int?
    public let followMode: String?
    public let followWatermark: Int?
    public let syncEnabled: Bool?
    public let phase: String?
    public let probeAvailable: Bool?
    public let wechatInFront: Bool?
    public let cliAvailable: Bool?
    public let failureCode: String?
    public let activeContactId: String?
    public let activeBindingDisplayName: String?
    public let batchMessageCount: Int?
    public let lastValidObservation: LatestValidForegroundObservation?
    public let contacts: [FollowSmokeContact]
    public let checkpoints: [FollowSmokeCheckpoint]
}

public struct LatestValidForegroundObservation: Decodable, Equatable, Sendable {
    public let observedAt: String
    public let contactId: String
    public let displayName: String?
    public let watermark: Int?
    public let batchMessageCount: Int
}

public struct FollowSmokeContact: Decodable, Equatable, Sendable, Identifiable {
    public let contactId: String
    public let bound: Bool
    public let messageCount: Int
    public let observationRefCount: Int
    public let watermark: Int?
    public let latestMode: String
    public let duplicateIdentities: Int

    public var id: String { contactId }
}

public struct FollowSmokeCheckpoint: Decodable, Equatable, Sendable, Identifiable {
    public let label: String
    public let recordedAt: String
    public let contacts: [FollowSmokeContact]

    public var id: String { "\(label)-\(recordedAt)" }
}

public struct BindingCandidate: Decodable, Equatable, Sendable {
    public let username: String
    public let displayName: String
    public let lastTimestamp: Int?
}

public struct CliSessionCandidate: Decodable, Equatable, Sendable, Identifiable {
    public let username: String
    public let displayName: String
    public let lastTimestamp: Int?
    public let boundContactId: String?

    public var id: String { username }
}

public struct CliSessionsResponse: Decodable, Equatable, Sendable {
    public let sessions: [CliSessionCandidate]
}

public struct CliBindingSelection: Equatable, Sendable {
    public let locator: String
    public let contactId: String?
    public let displayName: String?

    public init(
        locator: String,
        contactId: String? = nil,
        displayName: String? = nil
    ) {
        self.locator = locator
        self.contactId = contactId
        self.displayName = displayName
    }
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
    public let sourceIds: [String]?
    public let confidence: Double?
    public let riskFlags: [String]?
    public let supersedesMemoryId: String?
    public let validAt: String?
    public let invalidAt: String?

    public var id: String { memoryId }
}

public struct MemoryCandidateEntry: Decodable, Equatable, Sendable, Identifiable {
    public let candidateId: String
    public let text: String
    public let category: String
    public let topic: String
    public let subject: String?
    public let status: String
    public let sourceIds: [String]?
    public let confidence: Double?
    public let riskFlags: [String]?
    public let failureReason: String?
    public let validAt: String?
    public let invalidAt: String?

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

// MARK: - 导入

public struct ChannelIdentityView: Decodable, Equatable, Sendable {
    public let externalId: String
    public let observedName: String
}

public struct ImportPreview: Decodable, Equatable, Sendable {
    public let valid: Bool
    public let fileName: String
    public let recordCount: Int
    public let kindCounts: [String: Int]
    public let ownerChannelIdentity: ChannelIdentityView?
    public let contactChannelIdentity: ChannelIdentityView?
}

public struct ImportCommitResult: Decodable, Equatable, Sendable {
    public let importedCount: Int
    public let skippedDuplicates: Int
    public let contactId: String
}

// MARK: - 任务进度

public struct TaskProgress: Decodable, Equatable, Sendable {
    public let taskId: String
    public let step: String
    public let status: String
    public let processedCount: Int
    public let attemptCount: Int
    public let retryCount: Int
    public let errorCode: String?

    public init(
        taskId: String,
        step: String,
        status: String,
        processedCount: Int,
        attemptCount: Int,
        retryCount: Int,
        errorCode: String?
    ) {
        self.taskId = taskId
        self.step = step
        self.status = status
        self.processedCount = processedCount
        self.attemptCount = attemptCount
        self.retryCount = retryCount
        self.errorCode = errorCode
    }
}

public struct TaskStatusResponse: Decodable, Equatable, Sendable {
    public let status: String
    public let progress: TaskProgress?
}

public struct TaskStartResponse: Decodable, Equatable, Sendable {
    public let status: String
}

// MARK: - Skill 管理

public struct SkillEntry: Decodable, Equatable, Sendable, Identifiable {
    public let skillId: String
    public let name: String
    public let description: String
    public let status: String
    public let contactId: String?
    public let currentVersionId: String?
    public let currentVersionNumber: Int?
    public let enabled: Bool

    public var id: String { skillId }
}

public struct SkillListResponse: Decodable, Sendable {
    public let skills: [SkillEntry]
}

public struct SkillImportResponse: Decodable, Equatable, Sendable {
    public let skillId: String
    public let name: String
    public let versionNumber: Int
    public let revision: Int
    public let warnings: [String]
}

public struct SkillLifecycleResponse: Decodable, Equatable, Sendable {
    public let skillId: String
    public let status: String?
    public let versionNumber: Int?
    public let deleted: Bool?
    public let name: String?
}

public struct SkillPreview: Decodable, Equatable, Sendable {
    public let skillId: String
    public let name: String?
    public let description: String
    public let versionNumber: Int
    public let document: String
    public let resources: [String]
}

// MARK: - 台账概览

public struct LedgerSummary: Decodable, Equatable, Sendable {
    public let totalCalls: Int
    public let providerCounts: [String: Int]
    public let outcomeCounts: [String: Int]
    public let totalInputTokens: Int
    public let totalOutputTokens: Int
    public let recent: [LedgerEntryView]
}

public struct LedgerEntryView: Decodable, Equatable, Sendable {
    public let entryId: String
    public let provider: String
    public let modelName: String
    public let inputTokens: Int?
    public let outputTokens: Int?
    public let latencyMs: Int?
    public let outcome: String
    public let calledAt: String
}

// MARK: - 设置

public struct CredentialsStatus: Decodable, Equatable, Sendable {
    public let provider: String
    public let configured: Bool
}

// MARK: - 首启向导

public struct SetupStatus: Decodable, Equatable, Sendable {
    public let initialized: Bool
    public let ownerConfigured: Bool
    public let credentialsConfigured: Bool

    public init(
        initialized: Bool,
        ownerConfigured: Bool,
        credentialsConfigured: Bool
    ) {
        self.initialized = initialized
        self.ownerConfigured = ownerConfigured
        self.credentialsConfigured = credentialsConfigured
    }
}

public struct SetupInitializeResponse: Decodable, Equatable, Sendable {
    public let ownerId: String
    public let created: Bool
}

public struct SetupCredentialsResponse: Decodable, Equatable, Sendable {
    public let provider: String
    public let configured: Bool
}
