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
    @Published private(set) var backfillControlInFlight = false
    @Published private(set) var cliSessions: [CliSessionCandidate] = []
    @Published private(set) var cliSessionsInFlight = false
    @Published var cliSessionsError: String?
    @Published private(set) var cliBindingsInFlight = false
    @Published var cliBindingError: String?
    @Published private(set) var followSmoke: FollowSmokeStatus?
    @Published private(set) var followSmokeInFlight = false
    @Published var followSmokeError: String?
    @Published private(set) var selectedContactId: String?
    @Published private var messagePagination = MessagePagination()
    var messages: [MessageEntry] { messagePagination.messages }
    var messageStreamState: MessageStreamState { messagePagination.state }
    @Published private(set) var lastMessageCheckAt: Date?
    @Published private(set) var lastMessageCheckCount = 0
    @Published var lastOperationMessage: String?

    // 当前选中联系人是否还有更早的消息可加载（首屏后由游标决定）。
    var hasMoreMessages: Bool {
        messagePagination.hasMoreMessages
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
    @Published private(set) var replyEvidence: [ReplyEvidence] = []
    @Published private(set) var replyEvidenceError: String?
    @Published private(set) var replyEvidenceLoading = false
    @Published private(set) var importedSources: [ImportedSource] = []
    @Published private(set) var sourceError: String?
    @Published private(set) var sourceRequestInFlight = false
    private var sourceTask: Task<Void, Never>?
    private var sourceDeleteTask: Task<Void, Never>?
    private var dataGenerationId = UUID()
    private var replyGenerationId = UUID()
    private var lastReplyRequestId: String?


    // MARK: - 记忆管理
    @Published private(set) var contactMemories: [MemoryEntry] = []
    @Published private(set) var pendingMemoryCandidates: [MemoryCandidateEntry] = []
    // 区分「本次会话真的读到过候选列表」和「空列表」：没有读到过就不拿它
    // 当否证（既不展示旧数据，也不隐藏后端仍返回的未确认依据）。
    @Published private(set) var pendingCandidatesLoaded = false
    @Published private(set) var ownerMemories: [MemoryEntry] = []
    @Published private(set) var memoryInFlight = false
    @Published var memoryError: String?

    // MARK: - 导入与任务
    @Published private(set) var importPreview: ImportPreview?
    @Published private(set) var taskProgress: TaskProgress?
    @Published private(set) var taskState: String?
    @Published private(set) var importInFlight = false
    @Published var importError: String?

    // MARK: - Skill 管理
    @Published private(set) var skills: [SkillEntry] = []
    @Published private(set) var ledgerSummary: LedgerSummary?
    @Published private(set) var skillInFlight = false
    @Published var skillError: String?
    @Published var skillPreview: SkillPreview?
    // 回滚：先看版本历史，再二次确认目标版本。
    @Published var skillVersions: [SkillVersionEntry] = []
    @Published var skillVersionsFor: SkillEntry?
    @Published var skillVersionInFlight = false
    @Published private(set) var credentialsStatus: CredentialsStatus?

    // MARK: - 首启向导
    // owner 未初始化时后端只开放 setup 端点；向导完成初始化后重启后端。
    @Published private(set) var setupStatus: SetupStatus?
    @Published private(set) var setupInFlight = false
    @Published var setupError: String?

    typealias MessageStreamState = MessagePagination.State

    private let supervisor = BackendSupervisor()
    private var client: BackendClient?
    private var backendAttachment = BackendAttachment()
    private var setupRecovery = SetupRecovery()
    private var clientConnection: BackendConnection? { backendAttachment.connection }
    private var sseClient: SseEventClient?
    private var pollTask: Task<Void, Never>?
    private var messageTask: Task<Void, Never>?
    private var priorityTask: Task<Void, Never>?
    private var isToggling = false
    private var isCheckingNow = false
    private var isStopping = false

    private init() {}

    func start() {
        guard pollTask == nil else { return }
        isStopping = false
        pollTask = Task { [weak self] in
            await self?.runPollLoop()
        }
    }

    func stop() async {
        guard !isStopping else { return }
        isStopping = true
        invalidateMessageRequests()
        setupRecovery.connect(nil)
        pollTask?.cancel()
        pollTask = nil
        priorityTask?.cancel()
        priorityTask = nil
        sourceTask?.cancel()
        sourceDeleteTask?.cancel()
        sseClient?.stop()
        sseClient = nil
        do {
            try await supervisor.shutdown(connection: backendAttachment.shutdownConnection)
        } catch {
            // 复用实例不能按 PID 猜测终止；失败留明确信号，不冒充已停读。
            lastOperationMessage = "后端关闭未获确认，当前读取可能尚未停止。"
            NSLog("NotAlone：后端关闭未获确认，当前读取可能尚未停止。")
        }
        backendAttachment = BackendAttachment()
        client = nil
    }

    // MARK: - 消息流

    func selectContact(_ contactId: String) {
        guard contactId != selectedContactId else { return }
        selectedContactId = contactId
        sourceDeleteTask?.cancel()
        dataGenerationId = UUID()
        sourceTask?.cancel()
        importedSources = []
        sourceError = nil
        sourceRequestInFlight = false
        resetMessagePagination()
        selectedReplyMessageId = nil
        replyGenerationId = UUID()
        replyInFlight = false
        replyCandidates = []
        lastReplyUsedSkill = nil
        lastReplyRequestId = nil
        replyEvidence = []
        replyEvidenceError = nil
        replyEvidenceLoading = false
        replyError = nil
        contactMemories = []
        pendingMemoryCandidates = []
        pendingCandidatesLoaded = false
        publishPriorityContact(contactId)
        loadFirstMessagePage()
    }

    func loadFirstMessagePage() {
        guard !isStopping, !sourceRequestInFlight,
              selectedContactId != nil, client != nil, clientConnection != nil else { return }
        resetMessagePagination()
        startMessageRead(.firstPage)
    }

    func loadMoreMessages() {
        startMessageRead(.history)
    }

    // 新消息事件与轮询共享有界对账，只有接续旧区间后才展示新增消息。
    private func appendNewMessages() {
        fetchLatestAndMerge()
    }

    // SSE 不回放断线窗口消息，重连后对账已有显示区间。
    private func reconcileNewMessages() {
        fetchLatestAndMerge()
    }

    private func fetchLatestAndMerge() {
        startMessageRead(.reconcile)
    }

    private func startMessageRead(_ action: MessagePagination.Action) {
        guard !isStopping, !sourceRequestInFlight, clientConnection != nil,
              let client, let request = messagePagination.begin(action) else { return }
        messageTask = Task { [weak self] in
            guard let self else { return }
            var current = request
            while !Task.isCancelled {
                do {
                    let page = try await client.messages(
                        contactId: current.contactId,
                        limit: current.limit,
                        before: current.before
                    )
                    guard !Task.isCancelled,
                          let completed = self.messagePagination.complete(current, page: page) else { return }
                    if let count = completed.reconciledCount {
                        self.lastMessageCheckAt = Date()
                        self.lastMessageCheckCount = count
                    }
                    guard let next = completed.nextRequest else { return }
                    current = next
                } catch {
                    guard !Task.isCancelled else { return }
                    _ = self.messagePagination.fail(current, description: Self.describe(error))
                    return
                }
            }
        }
    }

    private func invalidateMessageRequests() {
        messageTask?.cancel()
        messageTask = nil
        messagePagination.invalidateRequests()
    }

    private func resetMessagePagination() {
        messageTask?.cancel()
        messageTask = nil
        messagePagination.reset(contactId: selectedContactId)
        lastMessageCheckAt = nil
        lastMessageCheckCount = 0
    }

    private func publishPriorityContact(_ contactId: String) {
        priorityTask?.cancel()
        guard let client else { return }
        priorityTask = Task {
            do {
                _ = try await client.setSyncPriority(contactId: contactId)
            } catch {
                // 后台下一轮仍会重试；优先级提示失败不打断消息查看。
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
            case .taskProgress(let progress):
                await MainActor.run {
                    // 与其他联系人的任务事件隔离：只接受当前视图联系人。
                    guard progress.contactId == self.selectedContactId else { return }
                    self.taskProgress = TaskProgress(
                        taskId: progress.taskId,
                        step: progress.step,
                        status: progress.status,
                        processedCount: progress.processedCount,
                        attemptCount: progress.attemptCount,
                        retryCount: progress.retryCount,
                        errorCode: self.taskProgress?.errorCode
                    )
                    if progress.status != "running" {
                        self.taskState = progress.status
                    }
                }
            case .reconnected:
                // message.created 不按 Last-Event-ID 回放：重连后对账，
                // 分页补到已有区间，弥补断线窗口内入库的消息。
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
                lastOperationMessage = targetEnabled ? "已开启 CLI 全量同步" : "已关闭 CLI 全量同步"
            } catch {
                lastOperationMessage = "开关失败：\(Self.describe(error))"
            }
        }
    }

    // 人工验证页使用的同步开关；仍然必须由用户点击，且不会隐式开始 follow。
    func setSyncEnabled(_ enabled: Bool) {
        guard !isToggling else {
            followSmokeError = "上一个操作进行中，请稍候"
            return
        }
        guard let client else {
            followSmokeError = "后端正在连接，请稍候"
            return
        }
        if status?.syncEnabled == enabled {
            return
        }
        isToggling = true
        Task {
            defer { isToggling = false }
            do {
                let updated: SyncStatus = enabled
                    ? try await client.enableSync()
                    : try await client.disableSync()
                status = updated
                lastOperationMessage = enabled ? "已开启 CLI 全量同步" : "已关闭 CLI 全量同步"
                // 即使验证尚未开始，也要刷新页面上的初始状态；否则页面
                // 可能在后端连接前出现，成功开启后仍会停留在加载状态。
                await loadFollowSmoke(using: client)
            } catch {
                followSmokeError = "同步开关失败：" + Self.describe(error)
            }
        }
    }

    // MARK: - CLI 全量同步与批量绑定

    func loadCliSessions() {
        guard let client else {
            cliSessionsError = nil
            return
        }
        guard !cliSessionsInFlight else { return }
        cliSessionsInFlight = true
        cliSessionsError = nil
        Task {
            defer { cliSessionsInFlight = false }
            do {
                cliSessions = try await client.cliSessions()
            } catch {
                cliSessionsError = Self.describe(error)
            }
        }
    }

    func confirmCliBindings(_ selections: [CliBindingSelection]) {
        guard !cliBindingsInFlight else {
            cliBindingError = "上一个批量绑定操作进行中，请稍候"
            return
        }
        guard let client else {
            cliBindingError = "后端正在连接，请稍候"
            return
        }
        guard !selections.isEmpty else {
            cliBindingError = "请至少选择一个微信私聊会话"
            return
        }
        cliBindingsInFlight = true
        cliBindingError = nil
        Task {
            defer { cliBindingsInFlight = false }
            do {
                status = try await client.confirmCliBindings(selections: selections)
                cliSessions = try await client.cliSessions()
                contacts = try await client.contacts()
                lastOperationMessage = "已完成所选微信私聊绑定"
            } catch {
                cliBindingError = Self.describe(error)
            }
        }
    }

    // MARK: - Follow 人工验证

    func loadFollowSmoke() {
        guard let client else {
            // 页面可能先于后端连接出现；连接建立后 attach() 会补读，
            // 轮询也会在 followSmoke 仍为空时重试，不能把竞态误报成故障。
            followSmokeError = nil
            return
        }
        Task {
            await loadFollowSmoke(using: client)
        }
    }

    func startFollowSmoke() {
        guard !followSmokeInFlight else {
            followSmokeError = "上一个操作进行中，请稍候"
            return
        }
        guard let client else {
            followSmokeError = "后端正在连接，请稍候"
            return
        }
        followSmokeInFlight = true
        followSmokeError = nil
        Task {
            defer { followSmokeInFlight = false }
            do {
                followSmoke = try await client.startFollowSmoke()
                lastOperationMessage = "已开始 Follow 人工验证"
            } catch {
                followSmokeError = Self.describe(error)
            }
        }
    }

    func stopFollowSmoke() {
        guard !followSmokeInFlight, let client else { return }
        followSmokeInFlight = true
        Task {
            defer { followSmokeInFlight = false }
            do {
                followSmoke = try await client.stopFollowSmoke()
                lastOperationMessage = "验证已结束，已恢复轮询"
            } catch {
                followSmokeError = Self.describe(error)
            }
        }
    }

    func interruptFollowSmoke() {
        guard !followSmokeInFlight, let client else { return }
        followSmokeInFlight = true
        Task {
            defer { followSmokeInFlight = false }
            do {
                followSmoke = try await client.interruptFollowSmoke()
                lastOperationMessage = "已请求中断 Follow 流，等待恢复状态"
            } catch {
                followSmokeError = Self.describe(error)
            }
        }
    }

    func checkpointFollowSmoke(label: String) {
        guard !followSmokeInFlight, let client else { return }
        followSmokeInFlight = true
        Task {
            defer { followSmokeInFlight = false }
            do {
                followSmoke = try await client.checkpointFollowSmoke(label: label)
                lastOperationMessage = "已记录检查点：" + label
            } catch {
                followSmokeError = Self.describe(error)
            }
        }
    }

    // 菜单栏与全局快捷键共用这一层路由；快捷键只调用已有人工验证
    // API，不把窗口切到前台，也不对微信执行任何自动化操作。
    func performFollowSmokeAction(_ action: FollowSmokeControlAction) {
        switch action {
        case .start:
            startFollowSmoke()
        case .stop:
            stopFollowSmoke()
        case .interrupt:
            interruptFollowSmoke()
        case .baseline, .beforeFollow, .afterLiveMessage, .afterIdle,
             .afterFollowRestart, .wechatBackground, .afterReenable,
             .finalResult:
            guard let label = action.checkpointLabel else { return }
            checkpointFollowSmoke(label: label)
        }
    }

    func checkNow() {
        guard !isCheckingNow else {
            lastOperationMessage = "检查进行中，请稍候"
            return
        }
        guard let client else {
            lastOperationMessage = "后端正在连接，请稍候"
            return
        }
        isCheckingNow = true
        Task {
            defer { isCheckingNow = false }
            do {
                // 这里必须调用 POST /api/sync/check 才会真正驱动一次
                // 后端 CLI cycle；只读 syncStatus 只会拿到旧报告。
                status = try await client.checkSync()
                await refreshContacts()
                fetchLatestAndMerge()
                lastOperationMessage = "已执行一次 CLI 同步检查"
            } catch {
                lastOperationMessage = "检查失败：\(Self.describe(error))"
            }
        }
    }

    func pauseBackfill() {
        guard !backfillControlInFlight else {
            lastOperationMessage = "补齐控制进行中，请稍候"
            return
        }
        guard let client else {
            lastOperationMessage = "后端正在连接，请稍候"
            return
        }
        backfillControlInFlight = true
        Task {
            defer { backfillControlInFlight = false }
            do {
                status = try await client.pauseBackfill()
                lastOperationMessage = "已暂停 CLI 后台补齐；未完成状态会保留"
            } catch {
                lastOperationMessage = "暂停补齐失败：\(Self.describe(error))"
            }
        }
    }

    func retryBackfill() {
        guard !backfillControlInFlight else {
            lastOperationMessage = "补齐控制进行中，请稍候"
            return
        }
        guard let client else {
            lastOperationMessage = "后端正在连接，请稍候"
            return
        }
        backfillControlInFlight = true
        Task {
            defer { backfillControlInFlight = false }
            do {
                status = try await client.retryBackfill()
                lastOperationMessage = "已请求恢复 CLI 后台补齐"
            } catch {
                lastOperationMessage = "重试补齐失败：\(Self.describe(error))"
            }
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
        guard !replyInFlight, client != nil, let contactId = selectedContactId else {
            replyError = "回复生成进行中或后端不可用"
            return
        }
        let generationId = UUID()
        replyGenerationId = generationId
        replyInFlight = true
        replyError = nil
        replyCandidates = []
        replyEvidence = []
        replyEvidenceError = nil
        replyEvidenceLoading = false
        lastReplyUsedSkill = nil
        lastReplyRequestId = nil
        Task {
            defer {
                if replyGenerationId == generationId { replyInFlight = false }
            }
            do {
                let generated = try await replyRequest()
                guard selectedContactId == contactId, replyGenerationId == generationId else { return }
                replyCandidates = generated.candidates
                lastReplyUsedSkill = generated.usedSkill
                lastReplyRequestId = generated.replyRequestId
                lastOperationMessage = "已生成 \(generated.candidates.count) 个候选"
                loadReplyEvidence()
            } catch {
                guard selectedContactId == contactId, replyGenerationId == generationId else { return }
                replyError = Self.describe(error)
            }
        }
    }

    func loadReplyEvidence() {
        guard let client, let contactId = selectedContactId,
              let requestId = lastReplyRequestId, !replyEvidenceLoading else { return }
        let generationId = replyGenerationId
        replyEvidenceLoading = true
        replyEvidenceError = nil
        Task {
            defer {
                if replyGenerationId == generationId { replyEvidenceLoading = false }
            }
            do {
                let snapshot = try await client.replyEvidence(contactId: contactId, requestId: requestId)
                guard selectedContactId == contactId, replyGenerationId == generationId,
                      lastReplyRequestId == snapshot.replyRequestId else { return }
                replyEvidence = snapshot.evidence
                // 未确认候选的现值只以后端为准：快照里出现未确认候选时，
                // 同时重读待确认列表，否决或确认过的候选不再靠旧数据呈现。
                if snapshot.evidence.contains(where: { $0.kind == "pending_candidate" }) {
                    await reloadPendingCandidates(client: client, contactId: contactId)
                }
            } catch {
                guard selectedContactId == contactId, replyGenerationId == generationId else { return }
                replyEvidenceError = "依据读取失败：\(Self.describe(error))"
            }
        }
    }

    // 重读待确认候选列表，供回复依据卡片判定「该候选是否仍未确认」。
    private func reloadPendingCandidates(client: BackendClient, contactId: String) async {
        guard let candidates = try? await client.pendingMemoryCandidates(contactId: contactId) else {
            // 读不到就不把空列表当否证：保持未加载状态，不缓存也不臆测。
            return
        }
        guard selectedContactId == contactId else { return }
        pendingMemoryCandidates = candidates
        pendingCandidatesLoaded = true
    }

    func loadImportedSources() {
        guard let client, let contactId = selectedContactId else { return }
        sourceTask?.cancel()
        sourceTask = Task {
            do {
                let sources = try await client.importedSources(contactId: contactId)
                guard !Task.isCancelled, selectedContactId == contactId else { return }
                let newlyDeleted = sources.contains { source in
                    source.deletionComplete && importedSources.contains { $0.id == source.id && !$0.deletionComplete }
                }
                importedSources = sources
                if newlyDeleted {
                    clearSourceDerivedViews()
                    loadFirstMessagePage()
                }
                sourceError = nil
            } catch {
                guard !Task.isCancelled, selectedContactId == contactId else { return }
                sourceError = "来源状态读取失败，请刷新确认。"
            }
        }
    }

    func deleteImportedSource(_ source: ImportedSource) {
        guard let client, let contactId = selectedContactId, !sourceRequestInFlight else { return }
        sourceTask?.cancel()
        sourceRequestInFlight = true
        sourceError = nil
        clearSourceDerivedViews()
        sourceDeleteTask = Task {
            defer {
                if !Task.isCancelled, selectedContactId == contactId { sourceRequestInFlight = false }
            }
            do {
                _ = try await client.deleteSource(contactId: contactId, sourceId: source.sourceId)
                guard !Task.isCancelled, selectedContactId == contactId else { return }
                lastOperationMessage = "已提交删除请求，正在确认结果"
                for _ in 0..<30 {
                    let sources = try await client.importedSources(contactId: contactId)
                    guard !Task.isCancelled, selectedContactId == contactId else { return }
                    importedSources = sources
                    if let updated = sources.first(where: { $0.sourceId == source.sourceId }), updated.deletionComplete {
                        clearSourceDerivedViews()
                        sourceRequestInFlight = false
                        loadFirstMessagePage()
                        lastOperationMessage = "导入资料已删除；保留不含正文的 AI 调用记录"
                        return
                    }
                    try await Task.sleep(for: .seconds(1))
                }
                lastOperationMessage = "删除尚未确认完成，可刷新状态或继续删除"
            } catch {
                guard !Task.isCancelled, selectedContactId == contactId else { return }
                sourceError = "请求或状态读取失败。删除可能已提交，请刷新确认；未完成时可继续删除。"
            }
        }
    }

    private func clearSourceDerivedViews() {
        dataGenerationId = UUID()
        resetMessagePagination()
        replyGenerationId = UUID()
        replyInFlight = false
        replyCandidates = []
        replyEvidence = []
        replyEvidenceError = nil
        replyEvidenceLoading = false
        lastReplyRequestId = nil
        lastReplyUsedSkill = nil
        selectedReplyMessageId = nil
        contactMemories = []
        pendingMemoryCandidates = []
        pendingCandidatesLoaded = false
        ownerMemories = []
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

    // 处理同步后台已捕获的候选；不要求 NotAlone 失去焦点后再把微信切回前台。
    func confirmPendingBinding(contactId: String, locator: String, displayName: String) {
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
                let updated = try await client.confirmPendingBinding(
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
        let contactId = selectedContactId
        let generationId = dataGenerationId
        Task {
            memoryInFlight = true
            defer { memoryInFlight = false }
            do {
                var confirmed: [MemoryEntry] = []
                var pending: [MemoryCandidateEntry] = []
                if let contactId {
                    confirmed = try await client.contactMemories(contactId: contactId)
                    pending = try await client.pendingMemoryCandidates(contactId: contactId)
                }
                let own = try await client.ownerMemories()
                guard selectedContactId == contactId, dataGenerationId == generationId else { return }
                contactMemories = confirmed
                pendingMemoryCandidates = pending
                // 读到过列表（哪怕为空）才算已知：空列表不能和「读失败」混为一谈。
                pendingCandidatesLoaded = contactId != nil
                ownerMemories = own
                memoryError = nil
            } catch {
                guard selectedContactId == contactId, dataGenerationId == generationId else { return }
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
        guard isStillPending(candidate) else { return }
        Task {
            memoryInFlight = true
            defer { memoryInFlight = false }
            do {
                _ = try await client.confirmMemoryCandidate(
                    contactId: selectedContactId,
                    candidateId: candidate.candidateId
                )
                lastOperationMessage = "候选已确认为记忆"
                await invalidateCandidateReplyEvidence(candidateId: candidate.candidateId)
            } catch {
                memoryError = Self.describe(error)
            }
        }
    }

    func discardPendingCandidate(_ candidate: MemoryCandidateEntry) {
        guard let client, let selectedContactId else { return }
        guard isStillPending(candidate) else { return }
        Task {
            memoryInFlight = true
            defer { memoryInFlight = false }
            do {
                try await client.discardMemoryCandidate(
                    contactId: selectedContactId,
                    candidateId: candidate.candidateId
                )
                lastOperationMessage = "候选已丢弃（计入删除指纹）"
                await invalidateCandidateReplyEvidence(candidateId: candidate.candidateId)
            } catch {
                memoryError = Self.describe(error)
            }
        }
    }

    // 列表刷新后，已处理过的候选行会消失；重复提交不再打后端。
    private func isStillPending(_ candidate: MemoryCandidateEntry) -> Bool {
        !pendingCandidatesLoaded
            || pendingMemoryCandidates.contains { $0.candidateId == candidate.candidateId }
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
        loadMemories()
    }

    // 用户处理完一个候选（确认或否决）后，立刻撤下它的未确认回复依据，
    // 再重新读取：后端已保证不再返回，界面不得继续用旧快照展示。
    private func invalidateCandidateReplyEvidence(candidateId: String) async {
        replyEvidence.removeAll { entry in
            entry.kind == "pending_candidate" && entry.evidenceId == candidateId
        }
        pendingMemoryCandidates.removeAll { $0.candidateId == candidateId }
        await reloadAfterMutation()
        loadReplyEvidence()
    }

    // MARK: - 导入与任务

    func previewImport(path: String) {
        guard let client else {
            importError = "后端不可用"
            return
        }
        Task {
            importInFlight = true
            defer { importInFlight = false }
            do {
                importPreview = try await client.importPreview(path: path)
                importError = nil
            } catch {
                importError = Self.describe(error)
            }
        }
    }

    func commitImport(path: String, contactId: String?, newContactName: String?) {
        guard let client else {
            importError = "后端不可用"
            return
        }
        Task {
            importInFlight = true
            defer { importInFlight = false }
            do {
                _ = try await client.importCommit(
                    path: path,
                    contactId: contactId,
                    newContactName: newContactName
                )
                importPreview = nil
                importError = nil
                lastOperationMessage = "导入完成"
                loadImportedSources()
                await refreshContacts()
            } catch {
                importError = Self.describe(error)
            }
        }
    }

    func startTask() {
        guard let client, let selectedContactId else {
            importError = "请先选择联系人"
            return
        }
        Task {
            do {
                let response = try await client.startTask(contactId: selectedContactId)
                taskState = response.status
                if response.status == "started" {
                    await pollTaskStatus()
                }
            } catch {
                importError = Self.describe(error)
            }
        }
    }

    private func pollTaskStatus() async {
        guard let client, let selectedContactId else { return }
        while !Task.isCancelled {
            do {
                let response = try await client.taskStatus(contactId: selectedContactId)
                taskState = response.status
                if let progress = response.progress {
                    taskProgress = progress
                }
                if response.status != "running" {
                    return
                }
            } catch {
                importError = Self.describe(error)
                return
            }
            try? await Task.sleep(nanoseconds: 1_000_000_000)
        }
    }

    // MARK: - Skill 管理

    func loadSkills() {
        guard let client else {
            skillError = "后端不可用"
            return
        }
        Task {
            do {
                skills = try await client.skills()
                ledgerSummary = try await client.ledgerSummary()
                credentialsStatus = try? await client.credentialsStatus()
                skillError = nil
            } catch {
                skillError = Self.describe(error)
            }
        }
    }

    func importSkill(packagePath: String) {
        guard let client else {
            skillError = "后端不可用"
            return
        }
        Task {
            skillInFlight = true
            defer { skillInFlight = false }
            do {
                let result = try await client.importSkill(packagePath: packagePath)
                lastOperationMessage = "已导入 Skill「\(result.name)」v\(result.versionNumber)"
                await reloadSkills()
            } catch {
                skillError = Self.describe(error)
            }
        }
    }

    func toggleSkill(_ skill: SkillEntry) {
        guard let client else { return }
        Task {
            skillInFlight = true
            defer { skillInFlight = false }
            do {
                if skill.enabled {
                    _ = try await client.disableSkill(skillId: skill.skillId)
                } else {
                    _ = try await client.enableSkill(skillId: skill.skillId)
                }
                await reloadSkills()
            } catch {
                skillError = Self.describe(error)
            }
        }
    }

    func deleteSkill(_ skill: SkillEntry) {
        guard let client else { return }
        Task {
            skillInFlight = true
            defer { skillInFlight = false }
            do {
                _ = try await client.deleteSkill(skillId: skill.skillId)
                lastOperationMessage = "已删除 Skill「\(skill.name)」"
                await reloadSkills()
            } catch {
                skillError = Self.describe(error)
            }
        }
    }

    func previewSkill(_ skill: SkillEntry) {
        guard let client else {
            skillError = "后端不可用"
            return
        }
        Task {
            skillInFlight = true
            defer { skillInFlight = false }
            do {
                let preview = try await client.previewSkill(skillId: skill.skillId)
                skillPreview = preview
                skillError = nil
            } catch {
                skillError = Self.describe(error)
            }
        }
    }

    func loadSkillVersions(_ skill: SkillEntry) {
        guard let client else {
            skillError = "后端不可用"
            return
        }
        Task {
            skillVersionsFor = skill
            skillVersionInFlight = true
            defer { skillVersionInFlight = false }
            do {
                skillVersions = try await client.skillVersions(skillId: skill.skillId)
                skillError = nil
            } catch {
                skillVersions = []
                skillError = Self.describe(error)
            }
        }
    }

    func dismissSkillVersions() {
        skillVersionsFor = nil
        skillVersions = []
    }

    func rollbackSkill(_ skill: SkillEntry, to version: SkillVersionEntry) {
        guard let client else {
            skillError = "后端不可用"
            return
        }
        Task {
            skillVersionInFlight = true
            defer { skillVersionInFlight = false }
            do {
                _ = try await client.rollbackSkill(
                    skillId: skill.skillId,
                    versionId: version.versionId
                )
                lastOperationMessage =
                    "已把 Skill「\(skill.name)」回滚到第 \(version.versionNumber) 版"
                skillError = nil
                dismissSkillVersions()
                await reloadSkills()
            } catch {
                skillError = Self.describe(error)
            }
        }
    }

    private func reloadSkills() async {
        if let client {
            skills = (try? await client.skills()) ?? []
            ledgerSummary = (try? await client.ledgerSummary()) ?? ledgerSummary
        }
    }

    // MARK: - 首启向导

    // 查询初始化状态；owner 未初始化时前端只展示向导，轮询不再刷新业务数据。
    func checkSetupStatus() {
        guard !isStopping, let client, let request = setupRecovery.beginQuery() else { return }
        Task {
            guard !isStopping, setupRecovery.isCurrent(request) else { return }
            do {
                let status = try await client.setupStatus()
                guard !isStopping, setupRecovery.finish(request, status: status) else { return }
                setupStatus = status
                setupError = nil
                if status.initialized {
                    await proceedAfterSetupIfNeeded(using: client, after: request)
                }
            } catch {
                guard !isStopping, setupRecovery.finish(request, status: nil) else { return }
                setupError = Self.describe(error)
            }
        }
    }

    // owner 已存在：若后端进程仍以未初始化模式运行（读旧的 .env），重启
    // 一次让 NOTALONE_OWNER_ID 生效；否则直接进入正常业务模式。
    private func proceedAfterSetupIfNeeded(
        using client: BackendClient,
        after request: SetupRecovery.Request
    ) async {
        guard !isStopping, setupRecovery.isCurrent(request) else { return }
        do {
            _ = try await client.syncStatus()
        } catch BackendClient.BackendError.ownerUninitialized {
            guard !isStopping, setupRecovery.isCurrent(request) else { return }
            await restartBackendIfNeeded(after: request)
            return
        } catch {
            // 同步不可用（例如尚无渠道身份）不影响进入业务模式。
        }
        // syncStatus 等待期间可能已换连接或退出，旧结果不得启动当前订阅。
        guard !isStopping, setupRecovery.isCurrent(request) else { return }
        startSseSubscription()
        if selectedContactId != nil && messages.isEmpty {
            loadFirstMessagePage()
        }
    }

    // 首启向导提交：写凭据（可留空跳过）→ 初始化 owner → 重启后端。
    func completeSetup(displayName: String, apiKey: String) {
        guard !isStopping, let client, !setupInFlight,
              let request = setupRecovery.beginSetup() else { return }
        setupInFlight = true
        setupError = nil
        Task {
            defer { setupInFlight = false }
            guard !isStopping, setupRecovery.isCurrent(request) else { return }
            do {
                let trimmedKey = apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
                if !trimmedKey.isEmpty {
                    _ = try await client.writeCredentials(apiKey: trimmedKey)
                    guard !isStopping, setupRecovery.isCurrent(request) else { return }
                }
                let result = try await client.initializeOwner(displayName: displayName)
                let initialized = SetupStatus(
                    initialized: true,
                    ownerConfigured: true,
                    credentialsConfigured: !trimmedKey.isEmpty
                )
                guard !isStopping, setupRecovery.finish(request, status: initialized) else {
                    return
                }
                setupStatus = initialized
                lastOperationMessage = result.created
                    ? "已完成初始化，正在进入主界面…"
                    : "已连接既有 owner，正在进入主界面…"
                await restartBackendIfNeeded(after: request)
            } catch {
                guard !isStopping, setupRecovery.finish(request, status: nil) else { return }
                setupError = Self.describe(error)
            }
        }
    }

    // owner 初始化写入 .env 后，后端进程需重启才能以已初始化模式运行。
    // 必须先真正终止旧进程（否则 ensureBackendLaunched 会复用旧连接，
    // 后端仍以 owner 未初始化模式运行，造成重启循环）。
    private func restartBackendIfNeeded(after request: SetupRecovery.Request) async {
        guard !isStopping, setupRecovery.isCurrent(request) else { return }
        invalidateMessageRequests()
        sseClient?.stop()
        sseClient = nil
        do {
            try await supervisor.shutdown(connection: request.connection)
        } catch {
            guard !isStopping, setupRecovery.isCurrent(request) else { return }
            setupError = "后端关闭未获确认，请退出旧实例后重试。"
            return
        }
        guard !isStopping, setupRecovery.isCurrent(request) else { return }
        invalidateMessageRequests()
        backendAttachment = BackendAttachment()
        setupRecovery.connect(nil)
        setupStatus = nil
        client = nil
        backendState = .launching
        await ensureBackendLaunched()
    }

    // MARK: - 轮询

    private func runPollLoop() async {
        await ensureBackendLaunched()
        while !Task.isCancelled {
            // 未查明初始化状态时按既有节奏重试；进行中或已查明时由 Core 跳过。
            checkSetupStatus()
            if setupStatus?.initialized != false {
                // owner 已初始化（或状态未知）：正常轮询业务数据。
                await refreshStatus()
                await refreshContacts()
                // SSE 是低延迟通道；选中会话再做 3 秒级有界分页对账，
                // 覆盖 SSE 断线、事件遗漏或事件到达时首屏仍在加载的窗口。
                if selectedContactId != nil {
                    if let selectedContactId {
                        publishPriorityContact(selectedContactId)
                    }
                    fetchLatestAndMerge()
                }
                await refreshFollowSmokeIfNeeded()
            }
            if clientConnection == nil || !supervisor.isRunning {
                // 传输失联时恢复连接与 SSE；进程退出时探测既有实例或重新启动。
                await ensureBackendLaunched()
            }
            try? await Task.sleep(nanoseconds: 3_000_000_000)
        }
    }

    private func ensureBackendLaunched() async {
        guard !isStopping else { return }
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
            guard !isStopping else { return }
            attach(existing)
            return
        }
        guard !isStopping else { return }
        invalidateMessageRequests()
        backendAttachment.disconnect()
        client = nil
        setupRecovery.connect(nil)
        setupStatus = nil
        sseClient?.stop()
        sseClient = nil
        guard let serverBin = EnvironmentLocator.locateServerBin() else {
            backendState = .failed("未找到 conda 环境中的 notalone-server。")
            return
        }
        backendState = .launching
        do {
            let connection = try await supervisor.launch(repoRoot: repoRoot, serverBin: serverBin)
            guard !isStopping else {
                try? await supervisor.shutdown(connection: connection)
                return
            }
            attach(connection)
        } catch {
            backendState = .failed(supervisor.lastError ?? Self.describe(error))
        }
    }

    private func attach(_ connection: BackendConnection) {
        // 后端监听随机端口，每次重启地址和 token 都会变化；连接变了
        // 必须重建 SSE 客户端，否则旧客户端会对已死端口无限重连，
        // 实时事件静默失效（只剩 3 秒轮询）。
        guard !isStopping, backendAttachment.attach(connection) else { return }
        invalidateMessageRequests()
        setupRecovery.connect(connection)
        setupStatus = nil
        setupError = nil
        sseClient?.stop()
        sseClient = nil
        client = BackendClient(connection: connection)
        backendState = .running
        // owner 未初始化时同步/事件端点按设计 503；先查 setup 状态，
        // 已初始化后才启动 SSE 订阅与业务数据加载。
        checkSetupStatus()
        // SwiftUI 的页面 onAppear 可能早于这里的后端握手；连接建立后
        // 主动补读一次，避免首次读取失败后永久停在空状态。
        loadCliSessions()
        loadFollowSmoke()
        if let selectedContactId {
            publishPriorityContact(selectedContactId)
        }
        if selectedContactId != nil && messages.isEmpty {
            loadFirstMessagePage()
        }
    }

    // 握手文件指向的后端仍可连接时直接复用；连接失败视为无既有实例。
    // owner 未初始化时 syncStatus 按设计 503，改用 setupStatus 探测。
    private func probeExistingBackend() async -> BackendConnection? {
        let infoPath = BackendConnection.infoPath()
        guard let recorded = try? BackendConnection.read(from: infoPath) else {
            return nil
        }
        let probe = BackendClient(connection: recorded)
        do {
            _ = try await probe.setupStatus()
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

    // 探针可执行文件：与后端相同的已签名 CLI 构建产物；避免调试窗口
    // 另启一个 .build/debug ad-hoc 二进制，产生第二个 macOS 授权主体。
    func probeExecutableURL() -> URL? {
        guard let root = locateRepoRoot() else { return nil }
        let candidate = root
            .appendingPathComponent("macos_sync_probe")
            .appendingPathComponent("build")
            .appendingPathComponent("cli")
            .appendingPathComponent("notalone-sync-probe")
        return FileManager.default.isExecutableFile(atPath: candidate.path)
            ? candidate
            : nil
    }

    private func refreshStatus() async {
        guard let client, let connection = clientConnection else { return }
        // owner 未初始化时同步状态端点按设计返回 503，不视为后端故障。
        guard setupStatus?.initialized != false else { return }
        do {
            let refreshed = try await client.syncStatus()
            guard !isStopping, clientConnection == connection else { return }
            status = refreshed
            // 上次失败后状态一恢复就回到 running，允许界面自动重连。
            backendState = .running
        } catch {
            guard !isStopping, clientConnection == connection else { return }
            // 只在真实传输失联时重置初始化状态；业务 503/500 仍保留连接并重试。
            if error is URLError || (error as? BackendClient.BackendError) == .transport {
                invalidateMessageRequests()
                backendAttachment.disconnect()
                self.client = nil
                setupRecovery.connect(nil)
                setupStatus = nil
                sseClient?.stop()
                sseClient = nil
            }
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

    private func refreshFollowSmokeIfNeeded() async {
        guard let client,
              FollowSmokeRefreshPolicy.shouldRefresh(
                  hasStatus: followSmoke != nil,
                  isActive: followSmoke?.active
              ) else { return }
        await loadFollowSmoke(using: client)
    }

    private func loadFollowSmoke(using client: BackendClient) async {
        do {
            followSmoke = try await client.followSmokeStatus()
            followSmokeError = nil
        } catch {
            followSmokeError = Self.describe(error)
        }
    }

    private static func describe(_ error: Error) -> String {
        if let backendError = error as? BackendClient.BackendError {
            switch backendError {
            case .ownerUninitialized:
                return "owner 尚未初始化（请完成首启向导）"
            case .syncUnavailable:
                return "同步不可用（可能尚未初始化微信渠道身份）"
            case .badStatus(let code):
                return "后端返回错误状态 \(code)"
            case .notFound:
                return "请求的资源不存在"
            case .confirmRejected(let reason):
                return "绑定确认被拒绝：\(reason)"
            case .cliBindingRejected(let reason):
                return "CLI 批量绑定被拒绝：\(reason)"
            case .cliBindingRequestInvalid:
                return "CLI 批量绑定请求无效"
            case .importCommitFailed:
                return backendError.localizedDescription
            case .replyRejected(let reason):
                return "回复被拒绝：\(Self.replyReasonLabel(reason))"
            case .replyTimedOut:
                return "回复生成超时，本次生成已停止。可以稍后重试。"
            case .replyBudgetExceeded:
                return "本次生成尝试过多，已停止。请调整表达方向后重试。"
            case .followSmokeUnavailable:
                return "Follow 验证不可用（请确认后端已更新）"
            case .followSmokeRejected(let reason):
                return "Follow 验证被拒绝：\(Self.followSmokeReasonLabel(reason))"
            case .followSmokeRequestInvalid:
                return "Follow 验证请求无效"
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

    private static func followSmokeReasonLabel(_ reason: String) -> String {
        switch reason {
        case "sync_disabled":
            return "请先开启前台同步"
        case "not_active":
            return "验证尚未开始"
        default:
            return reason
        }
    }
}
