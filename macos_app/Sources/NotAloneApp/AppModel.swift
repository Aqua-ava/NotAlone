import Foundation
import NotAloneAppCore

// 主窗口应用的状态模型：拉起并监管后端子进程、轮询状态与联系人、
// 暴露同步开关操作。所有数据只来自当前 owner 范围的后端 API。
@MainActor
final class AppModel: ObservableObject {
    static let shared = AppModel()

    enum BackendState: Equatable {
        case launching
        case running
        case failed(String)
    }

    @Published private(set) var backendState: BackendState = .launching
    @Published private(set) var contacts: [ContactEntry] = []
    @Published private(set) var status: SyncStatus?
    @Published private(set) var selectedContactId: String?
    @Published private(set) var messages: [MessageEntry] = []
    @Published private(set) var messageStreamState: MessageStreamState = .idle
    @Published var lastOperationMessage: String?

    // 当前选中联系人是否还有更早的消息可加载（首屏后由游标决定）。
    var hasMoreMessages: Bool {
        messageStreamState == .loaded && loadedBefore != nil
    }

    var selectedContactDisplayName: String? {
        guard let selectedContactId else { return nil }
        return contacts.first(where: { $0.contactId == selectedContactId })?.displayName
    }

    // 当前选中消息（供回复工作区定位）；以 messageId 记录，切换联系人时清空。
    @Published var selectedReplyMessageId: String?
    @Published private(set) var replyInFlight = false
    @Published var replyError: String?
    @Published private(set) var replyCandidates: [ReplyCandidate] = []
    @Published private(set) var lastReplyUsedSkill: ReplyGenerated.UsedSkill?
    @Published private(set) var lastReplyContextEvidence: [String] = []

    // MARK: - 记忆管理
    @Published private(set) var contactMemories: [MemoryEntry] = []
    @Published private(set) var pendingMemoryCandidates: [MemoryCandidateEntry] = []
    @Published private(set) var ownerMemories: [MemoryEntry] = []
    @Published private(set) var memoryInFlight = false
    @Published var memoryError: String?

    enum MessageStreamState: Equatable {
        case idle
        case loadingFirstPage
        case loadingMore
        case loaded
        case failed(String)
    }

    private let supervisor = BackendSupervisor()
    private var client: BackendClient?
    private var clientConnection: BackendConnection?
    private var sseClient: SseEventClient?
    private var pollTask: Task<Void, Never>?
    private var messageTask: Task<Void, Never>?
    private var isToggling = false
    private var loadedBefore: String?
    private var knownMessageIds: Set<String> = []

    private init() {}

    func start() {
        guard pollTask == nil else { return }
        pollTask = Task { [weak self] in
            await self?.runPollLoop()
        }
    }

    func stop() {
        pollTask?.cancel()
        pollTask = nil
        messageTask?.cancel()
        messageTask = nil
        sseClient?.stop()
        sseClient = nil
        supervisor.terminate()
    }

    // MARK: - 消息流

    func selectContact(_ contactId: String) {
        guard contactId != selectedContactId else { return }
        selectedContactId = contactId
        messages = []
        knownMessageIds = []
        loadedBefore = nil
        selectedReplyMessageId = nil
        replyCandidates = []
        contactMemories = []
        pendingMemoryCandidates = []
        messageStreamState = .idle
        loadFirstMessagePage()
    }

    func loadFirstMessagePage() {
        guard let selectedContactId, let client else { return }
        messageTask?.cancel()
        messageTask = Task { [weak self] in
            guard let self else { return }
            self.messageStreamState = .loadingFirstPage
            do {
                let page = try await client.messages(contactId: selectedContactId, limit: 50)
                self.messages = page.messages
                self.knownMessageIds = Set(page.messages.map(\.messageId))
                self.loadedBefore = page.nextCursor
                self.messageStreamState = .loaded
            } catch {
                self.messageStreamState = .failed(Self.describe(error))
            }
        }
    }

    func loadMoreMessages() {
        guard let selectedContactId, let client, hasMoreMessages, let loadedBefore else {
            return
        }
        guard !(messageStreamState == .loadingMore) else { return }
        messageTask?.cancel()
        messageTask = Task { [weak self] in
            guard let self else { return }
            self.messageStreamState = .loadingMore
            do {
                let page = try await client.messages(
                    contactId: selectedContactId,
                    limit: 50,
                    before: loadedBefore
                )
                let fresh = page.messages.filter { !self.knownMessageIds.contains($0.messageId) }
                self.messages.append(contentsOf: fresh)
                self.knownMessageIds.formUnion(fresh.map(\.messageId))
                self.loadedBefore = page.nextCursor
                self.messageStreamState = .loaded
            } catch {
                self.messageStreamState = .failed(Self.describe(error))
            }
        }
    }

    // 新消息事件到达（当前联系人范围内）时经消息流 API 拉到最新一页
    // 并去重追加，保证界面不手动刷新也能实时更新。
    private func appendNewMessages() {
        fetchLatestAndMerge()
    }

    // 对账：拉取最新一页，只合并本次会话未见过的消息（断线窗口补拉）。
    private func reconcileNewMessages() {
        fetchLatestAndMerge()
    }

    // 拉取最新一页；只把当前会话未见过的消息合并到流头部。
    private func fetchLatestAndMerge() {
        guard let selectedContactId, let client else { return }
        guard !(messageStreamState == .loadingFirstPage || messageStreamState == .loadingMore) else {
            return
        }
        messageTask?.cancel()
        messageTask = Task { [weak self] in
            guard let self else { return }
            do {
                let page = try await client.messages(contactId: selectedContactId, limit: 50)
                let fresh = page.messages.filter { !self.knownMessageIds.contains($0.messageId) }
                guard !fresh.isEmpty else { return }
                self.messages = fresh + self.messages
                self.knownMessageIds.formUnion(fresh.map(\.messageId))
                self.loadedBefore = page.nextCursor
            } catch {
                // 合并失败不打断已有消息流；下一轮轮询或事件会重试。
            }
        }
    }

    private func startSseSubscription() {
        guard sseClient == nil else { return }
        guard let connection = clientConnection else { return }
        let sse = SseEventClient(connection: connection) { [weak self] event in
            guard let self else { return }
            switch event {
            case .messageCreated(let created):
                await MainActor.run {
                    guard created.contactId == self.selectedContactId else { return }
                    self.appendNewMessages()
                }
            case .reconnected:
                // message.created 不按 Last-Event-ID 回放：重连后对账，
                // 拉取最新一页去重合并，弥补断线窗口内入库的消息。
                await MainActor.run {
                    self.reconcileNewMessages()
                }
            }
        }
        sseClient = sse
        sse.start()
    }

    // MARK: - 用户操作

    func toggleSync() {
        guard !isToggling, let client else { return }
        isToggling = true
        let targetEnabled = !(status?.syncEnabled ?? false)
        Task {
            defer { isToggling = false }
            do {
                let updated: SyncStatus = targetEnabled
                    ? try await client.enableSync()
                    : try await client.disableSync()
                status = updated
                lastOperationMessage = targetEnabled ? "已开启前台同步" : "已关闭前台同步"
            } catch {
                lastOperationMessage = "开关失败：\(Self.describe(error))"
            }
        }
    }

    func checkNow() {
        Task {
            await refreshStatus()
        }
    }

    // MARK: - 回复工作区

    // 生成候选回复（选中消息 + 表达方向）。
    func generateReplyToMessage(
        direction: String,
        continuedFromCandidateId: String? = nil,
        skillVersionId: String? = nil
    ) {
        guard let selectedReplyMessageId, let selectedContactId, let client else {
            replyError = "请先选择一条消息"
            return
        }
        generateReply(
            replyRequest: {
                try await client.generateReply(
                    contactId: selectedContactId,
                                        idempotencyKey: UUID().uuidString,
                    replyToMessage: (
                        targetMessageId: selectedReplyMessageId,
                        direction: direction
                    ),
                    rewriteDraft: nil,
                    continuedFromCandidateId: continuedFromCandidateId,
                    skillVersionId: skillVersionId
                )
            }
        )
    }

    // 生成候选回复（用户原句 + 改写要求）。
    func generateRewrite(
        draftText: String,
        instruction: String?,
        continuedFromCandidateId: String? = nil,
        skillVersionId: String? = nil,
        includeRelationshipContext: Bool = false
    ) {
        guard let selectedContactId, let client else {
            replyError = "请先选择联系人"
            return
        }
        generateReply(
            replyRequest: {
                try await client.generateReply(
                    contactId: selectedContactId,
                                        idempotencyKey: UUID().uuidString,
                    replyToMessage: nil,
                    rewriteDraft: (
                        draftText: draftText,
                        userInstruction: instruction,
                        includeContext: includeRelationshipContext
                    ),
                    continuedFromCandidateId: continuedFromCandidateId,
                    skillVersionId: skillVersionId
                )
            }
        )
    }

    private func generateReply(
        replyRequest: @escaping @MainActor () async throws -> ReplyGenerated
    ) {
        guard !replyInFlight, client != nil else {
            replyError = "回复生成进行中或后端不可用"
            return
        }
        replyInFlight = true
        replyError = nil
        Task {
            defer { replyInFlight = false }
            do {
                let generated = try await replyRequest()
                replyCandidates = generated.candidates
                lastReplyUsedSkill = generated.usedSkill
                lastReplyContextEvidence = generated.contextReceipt?.evidenceIds ?? []
                lastOperationMessage = "已生成 \(generated.candidates.count) 个候选"
            } catch {
                replyError = Self.describe(error)
            }
        }
    }

    // 一次性绑定确认：选择一个候选联系人写入绑定；确认后立即
    // 刷新状态（引擎下一轮自动恢复同步读取）。
    func confirmBinding(contactId: String, locator: String, displayName: String) {
        guard !isToggling, let client else {
            if isToggling {
                lastOperationMessage = "上一个操作进行中，请稍候"
            }
            return
        }
        isToggling = true
        Task {
            defer { isToggling = false }
            do {
                let updated = try await client.confirmBinding(
                    contactId: contactId,
                    locator: locator
                )
                status = updated
                lastOperationMessage = "已绑定「\(displayName)」，同步已恢复"
            } catch {
                lastOperationMessage = "绑定确认失败：\(Self.describe(error))"
            }
        }
    }

    // MARK: - 记忆管理

    func loadMemories() {
        guard let client else { return }
        Task {
            memoryInFlight = true
            defer { memoryInFlight = false }
            do {
                if let selectedContactId {
                    contactMemories = try await client.contactMemories(contactId: selectedContactId)
                    pendingMemoryCandidates = try await client.pendingMemoryCandidates(
                        contactId: selectedContactId
                    )
                }
                ownerMemories = try await client.ownerMemories()
                memoryError = nil
            } catch {
                memoryError = Self.describe(error)
            }
        }
    }

    func addManualMemory(
        text: String,
        category: String,
        level: String
    ) {
        guard let client, let selectedContactId else {
            memoryError = "请先选择联系人"
            return
        }
        Task {
            memoryInFlight = true
            defer { memoryInFlight = false }
            do {
                if level == "owner" {
                    _ = try await client.addManualOwnerMemory(text: text, category: category)
                } else {
                    _ = try await client.addManualContactMemory(
                        contactId: selectedContactId,
                        text: text,
                        category: category
                    )
                }
                lastOperationMessage = "已录入记忆"
                await reloadAfterMutation()
            } catch {
                memoryError = Self.describe(error)
            }
        }
    }

    func confirmPendingCandidate(_ candidate: MemoryCandidateEntry) {
        guard let client, let selectedContactId else { return }
        Task {
            memoryInFlight = true
            defer { memoryInFlight = false }
            do {
                _ = try await client.confirmMemoryCandidate(
                    contactId: selectedContactId,
                    candidateId: candidate.candidateId
                )
                lastOperationMessage = "候选已确认为记忆"
                await reloadAfterMutation()
            } catch {
                memoryError = Self.describe(error)
            }
        }
    }

    func discardPendingCandidate(_ candidate: MemoryCandidateEntry) {
        guard let client, let selectedContactId else { return }
        Task {
            memoryInFlight = true
            defer { memoryInFlight = false }
            do {
                try await client.discardMemoryCandidate(
                    contactId: selectedContactId,
                    candidateId: candidate.candidateId
                )
                lastOperationMessage = "候选已丢弃（计入删除指纹）"
                await reloadAfterMutation()
            } catch {
                memoryError = Self.describe(error)
            }
        }
    }

    func deleteMemory(_ memory: MemoryEntry) {
        guard let client else { return }
        Task {
            memoryInFlight = true
            defer { memoryInFlight = false }
            do {
                if memory.level == "owner" {
                    try await client.deleteOwnerMemory(memoryId: memory.memoryId)
                } else if let selectedContactId {
                    _ = try await client.deleteContactMemory(
                        contactId: selectedContactId,
                        memoryId: memory.memoryId
                    )
                }
                lastOperationMessage = "记忆已删除（文本指纹保留）"
                await reloadAfterMutation()
            } catch {
                memoryError = Self.describe(error)
            }
        }
    }

    func correctMemory(_ memory: MemoryEntry, newText: String) {
        guard let client, let selectedContactId else { return }
        Task {
            memoryInFlight = true
            defer { memoryInFlight = false }
            do {
                _ = try await client.correctMemory(
                    contactId: selectedContactId,
                    memoryId: memory.memoryId,
                    text: newText
                )
                lastOperationMessage = "记忆已修正（版本演变）"
                await reloadAfterMutation()
            } catch {
                memoryError = Self.describe(error)
            }
        }
    }

    private func reloadAfterMutation() async {
        // 等一轮后再刷新列表，直接 reload 即可（读最新）。
        if let selectedContactId, let client {
            contactMemories = (try? await client.contactMemories(contactId: selectedContactId)) ?? []
            pendingMemoryCandidates = (try? await client.pendingMemoryCandidates(
                contactId: selectedContactId
            )) ?? []
        }
        if let client {
            ownerMemories = (try? await client.ownerMemories()) ?? []
        }
    }

    // MARK: - 轮询

    private func runPollLoop() async {
        await ensureBackendLaunched()
        while !Task.isCancelled {
            await refreshStatus()
            await refreshContacts()
            if !supervisor.isRunning {
                // 后端进程崩溃或退出后自动重启，保持"监管"语义。
                await ensureBackendLaunched()
            }
            try? await Task.sleep(nanoseconds: 3_000_000_000)
        }
    }

    private func ensureBackendLaunched() async {
        // 未启动或进程已退出时先探测既有后端：已有实例则复用连接，
        // 避免两个后端实例同时驱动同步（ADR-020 单实例约束）。
        if supervisor.isRunning, let connection = supervisor.connection {
            attach(connection)
            return
        }
        guard let repoRoot = locateRepoRoot() else {
            backendState = .failed("无法定位仓库根目录（pyproject.toml）。")
            return
        }
        if let existing = await probeExistingBackend() {
            attach(existing)
            return
        }
        guard let serverBin = EnvironmentLocator.locateServerBin() else {
            backendState = .failed("未找到 conda 环境中的 notalone-server。")
            return
        }
        backendState = .launching
        do {
            let connection = try await supervisor.launch(repoRoot: repoRoot, serverBin: serverBin)
            attach(connection)
        } catch {
            backendState = .failed(supervisor.lastError ?? Self.describe(error))
        }
    }

    private func attach(_ connection: BackendConnection) {
        clientConnection = connection
        client = BackendClient(connection: connection)
        backendState = .running
        startSseSubscription()
        if selectedContactId != nil && messages.isEmpty {
            loadFirstMessagePage()
        }
    }

    // 握手文件指向的后端仍可连接时直接复用；连接失败视为无既有实例。
    private func probeExistingBackend() async -> BackendConnection? {
        let infoPath = BackendConnection.infoPath()
        guard let recorded = try? BackendConnection.read(from: infoPath) else {
            return nil
        }
        let probe = BackendClient(connection: recorded)
        do {
            _ = try await probe.syncStatus()
            return recorded
        } catch {
            // 文件残留但后端已退出：交给 launch 重新拉起并覆盖握手文件。
            return nil
        }
    }

    private func locateRepoRoot() -> URL? {
        var anchor = Bundle.main.bundleURL
        if anchor.lastPathComponent == "MacOS",
           let executable = Bundle.main.executableURL {
            anchor = executable
        }
        return EnvironmentLocator.locateRepoRoot(anchor: anchor)
    }

    private func refreshStatus() async {
        guard let client else { return }
        do {
            status = try await client.syncStatus()
            // 上次失败后状态一恢复就回到 running，允许界面自动重连。
            backendState = .running
        } catch {
            if case .running = backendState {
                backendState = .failed("后端状态读取失败：\(Self.describe(error))")
            } else if case .launching = backendState {
                backendState = .failed("后端状态读取失败：\(Self.describe(error))")
            }
        }
    }

    private func refreshContacts() async {
        guard let client else { return }
        do {
            contacts = try await client.contacts()
        } catch {
            // 联系人列表失败不打断状态展示；下次轮询重试。
        }
    }

    private static func describe(_ error: Error) -> String {
        if let backendError = error as? BackendClient.BackendError {
            switch backendError {
            case .syncUnavailable:
                return "同步不可用（可能尚未初始化微信渠道身份）"
            case .badStatus(let code):
                return "后端返回错误状态 \(code)"
            case .notFound:
                return "请求的资源不存在"
            case .confirmRejected(let reason):
                return "绑定确认被拒绝：\(reason)"
            case .replyRejected(let reason):
                return "回复被拒绝：\(Self.replyReasonLabel(reason))"
            case .malformedResponse:
                return "后端响应格式异常"
            case .transport:
                return "无法连接后端"
            }
        }
        return error.localizedDescription
    }

    private static func replyReasonLabel(_ reason: String) -> String {
        switch reason {
        case "no_active_binding":
            return "没有已验证的会话绑定"
        case "binding_not_active":
            return "会话绑定已失效"
        case "scope_mismatch":
            return "联系人范围与已验证会话不符"
        case "invalid_reply_input":
            return "回复请求内容无效"
        case "binding_unconfirmed":
            return "会话绑定尚未确认"
        case "conversation_changed":
            return "当前会话已变化"
        case "ambiguous_binding":
            return "会话绑定存在冲突"
        case "binding_low_confidence":
            return "会话绑定置信度不足"
        case "binding_revoked":
            return "会话绑定已撤销"
        case "verification_unavailable":
            return "会话验证暂时不可用"
        default:
            return reason
        }
    }
}