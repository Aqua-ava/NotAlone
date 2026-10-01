import AppKit
import SwiftUI
import NotAloneAppCore

// 主窗口三栏骨架：左栏联系人列表与同步开关；中栏与右栏为后续
// 消息流（06）与回复工作区（08）占位。保持 owner 范围隔离：
// 联系人数据只来自后端当前 owner 的 API。
struct MainWindowView: View {
    @EnvironmentObject private var model: AppModel
    @State private var selectedContact: String?
    @State private var scrollProxy: ScrollViewProxy?
    @State private var selectedCandidate: BindingCandidate?
    // 用户手动关闭后本会话不再自动弹出；后台发现候选不会抢占微信焦点。
    @State private var dismissBindingSheet = false
    // 回复工作区输入
    @State private var replyDirection = ""
    @State private var rewriteDraft = ""
    @State private var rewriteInstruction = ""
    @State private var manualSkillVersion = ""
    @State private var includeRelationshipContext = false
    // 候选正文的会话内编辑内容（按 candidateId）
    @State private var editedCandidateTexts: [String: String] = [:]
    // 右栏切换：0 = 回复，1 = 记忆，2 = 导入，3 = Skill，4 = 设置，5 = 同步管理
    @State private var detailTab = 0
    @State private var selectedCliLocators: Set<String> = []
    @State private var cliDisplayNames: [String: String] = [:]
    // 记忆管理输入
    @State private var newMemoryText = ""
    @State private var newMemoryCategory = MemoryCategoryOption.preference.rawValue
    // 记忆行内修正编辑状态（按 memoryId）
    @State private var editingMemoryId: String?
    @State private var editingMemoryText = ""
    // 导入页输入
    @State private var importPath = ""
    @State private var importTargetContact = ""
    @State private var newImportContactName = ""
    // Skill 库输入
    @State private var skillPackagePath = ""

    enum MemoryCategoryOption: String, CaseIterable, Identifiable {
        case commonFact = "common_fact"
        case preference = "preference"
        case taboo = "taboo"
        case recentState = "recent_state"
        case relationshipNote = "relationship_note"

        var id: String { rawValue }
        var label: String {
            switch self {
            case .commonFact: return "一般事实"
            case .preference: return "偏好"
            case .taboo: return "禁忌"
            case .recentState: return "近期状态"
            case .relationshipNote: return "关系备注"
            }
        }
    }

    var body: some View {
        NavigationSplitView {
            sidebar
        } content: {
            messageStreamView
        } detail: {
            VStack(spacing: 0) {
                Picker("右栏", selection: $detailTab) {
                    Text("回复工作区").tag(0)
                    Text("记忆管理").tag(1)
                    Text("导入").tag(2)
                    Text("Skill 库").tag(3)
                    Text("设置").tag(4)
                    Text("同步管理").tag(5)
                }
                .pickerStyle(.segmented)
                .padding(8)
                Divider()
                if detailTab == 0 {
                    replyPlaceholder
                } else if detailTab == 1 {
                    memoryManagementView
                        .onAppear {
                            model.loadMemories()
                        }
                } else if detailTab == 2 {
                    importView
                } else if detailTab == 3 {
                    skillLibraryView
                        .onAppear {
                            model.loadSkills()
                        }
                } else if detailTab == 4 {
                    settingsView
                } else {
                    followSmokeView
                        .onAppear {
                            model.loadCliSessions()
                            model.loadFollowSmoke()
                            syncCliSelection(model.cliSessions)
                        }
                }
            }
        }
        .navigationTitle(windowTitle)
        .toolbar {
            ToolbarItem(placement: .navigation) {
                syncToggleButton
            }
        }
        .sheet(isPresented: $showBindingConfirmation) {
            bindingConfirmationSheet
        }
        .overlay {
            if model.setupStatus?.initialized == false {
                setupWizardView
            }
        }
        .onChange(of: model.replyCandidates.map(\.candidateId)) { _, ids in
            let currentIds = Set(ids)
            editedCandidateTexts = editedCandidateTexts.filter { currentIds.contains($0.key) }
        }
        .onChange(of: model.status?.candidates.isEmpty) { _, isEmpty in
            if isEmpty == true {
                dismissBindingSheet = false
                return
            }
            guard BindingConfirmationPresentationPolicy.shouldPresent(
                hasCandidates: true,
                appIsActive: NSApp.isActive,
                isDismissed: dismissBindingSheet
            ) else { return }
            // 双通道模式下，CLI 私聊批量绑定页是唯一绑定入口；前台 OCR
            // 只负责定位当前联系人，不应因候选变化弹出旧确认窗。
            guard model.status?.syncMode != "cli_background" else { return }
            selectedCandidate = nil
            showBindingConfirmation = true
        }
    }

    @State private var showBindingConfirmation = false
    // 首启向导输入
    @State private var setupDisplayName = ""
    @State private var setupApiKey = ""

    // 首启向导覆盖层：owner 未初始化时全屏展示，填写展示名称与模型凭据。
    // 凭据不回显；提交后由 AppModel 重启后端进入正常业务模式。
    private var setupWizardView: some View {
        VStack(spacing: 16) {
            Image(systemName: "person.crop.circle.badge.checkmark")
                .font(.system(size: 44))
                .foregroundStyle(.tint)
            Text("欢迎使用 NotAlone")
                .font(.largeTitle.weight(.semibold))
            Text("先完成首次初始化：设置一个联系人展示名称，并填入模型凭据（可选，可稍后在设置页补充）。")
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 380)
            VStack(alignment: .leading, spacing: 8) {
                Text("联系人展示名称")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                TextField("例如：小明", text: $setupDisplayName)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 380)
                Text("模型凭据（DeepSeek API Key，可选）")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                SecureField("sk-…", text: $setupApiKey)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 380)
            }
            if let error = model.setupError {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .frame(maxWidth: 380)
            }
            if model.setupInFlight {
                ProgressView("正在完成初始化…")
            }
            Button {
                model.completeSetup(displayName: setupDisplayName, apiKey: setupApiKey)
            } label: {
                Text("完成初始化")
                    .frame(minWidth: 120)
            }
            .buttonStyle(.borderedProminent)
            .disabled(
                model.setupInFlight
                    || setupDisplayName.trimmingCharacters(in: .whitespaces).isEmpty
            )
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(nsColor: .windowBackgroundColor))
    }

    // 用户主动处理待确认候选时展示一次性选择列表；确认前同步保持暂停。
    // 用户手动关闭后本会话不再自动弹出（dismissBindingSheet 标记），
    // 确认后候选清空自动收起。
    private var bindingConfirmationSheet: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(selectedCandidate == nil ? "确认绑定到哪位联系人？" : "为「\(selectedCandidate?.displayName ?? "")」选择联系人")
                .font(.headline)
            Text("同步已暂停；候选来自最近一次微信前台观察，选择联系人后会完成绑定。")
                .font(.caption)
                .foregroundStyle(.secondary)
            Divider()
            if let candidate = selectedCandidate {
                contactPicker(for: candidate)
            } else if let candidates = model.status?.candidates, !candidates.isEmpty {
                List(candidates, id: \.username) { candidate in
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(candidate.displayName)
                            Text(candidate.username)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        if let timestamp = candidate.lastTimestamp {
                            Text(shortTimestamp(timestamp))
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                        }
                    }
                    .contentShape(Rectangle())
                    .onTapGesture {
                        selectedCandidate = candidate
                    }
                }
                .listStyle(.inset)
            }
            HStack {
                if selectedCandidate != nil {
                    Button("返回候选") {
                        selectedCandidate = nil
                    }
                }
                Spacer()
                Button(selectedCandidate == nil ? "稍后处理" : "取消") {
                    // 手动关闭不写入绑定；同步仍保持暂停，等待下次确认。
                    selectedCandidate = nil
                    dismissBindingSheet = true
                    showBindingConfirmation = false
                    model.lastOperationMessage = "未确认绑定，同步保持暂停"
                }
                .keyboardShortcut(.cancelAction)
            }
        }
        .padding(20)
        .frame(width: 460, height: 360)
    }

    // 选中候选后展示联系人列表，避免按展示名猜测联系人（重名/不同名时安全）。
    private func contactPicker(for candidate: BindingCandidate) -> some View {
        List(model.contacts, id: \.contactId) { contact in
            HStack {
                Text(contact.displayName)
                Spacer()
                if contact.contactId == model.status?.activeContactId {
                    badge("当前同步中", color: .green)
                }
            }
            .contentShape(Rectangle())
            .onTapGesture {
                model.confirmPendingBinding(
                    contactId: contact.contactId,
                    locator: candidate.username,
                    displayName: candidate.displayName
                )
                selectedCandidate = nil
                // 确认成功后候选清空、sheet 收起；失败时状态刷新会保留候选。
                dismissBindingSheet = false
                showBindingConfirmation = false
            }
        }
        .listStyle(.inset)
    }

    private func shortTimestamp(_ timestamp: Int) -> String {
        let date = Date(timeIntervalSince1970: TimeInterval(timestamp))
        let formatter = DateFormatter()
        formatter.dateFormat = "MM-dd HH:mm"
        return formatter.string(from: date)
    }

    // MARK: - 左栏

    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 0) {
            backendStatusBanner
            List(model.contacts, selection: $selectedContact) { contact in
                contactRow(contact)
                    .tag(contact.contactId)
            }
            .listStyle(.inset)
            Divider()
            statusFooter
        }
        .navigationSplitViewColumnWidth(min: 240, ideal: 280)
        .onChange(of: selectedContact) { _, newValue in
            guard let newValue else { return }
            model.selectContact(newValue)
        }
    }

    private func contactRow(_ contact: ContactEntry) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(contact.displayName)
                    .lineLimit(1)
                Text("\(contact.dataStatus.messageCount) 条消息 · \(contact.dataStatus.sourceCount) 个来源")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            if model.status?.activeContactId == contact.contactId {
                badge("同步中", color: .green)
            }
        }
    }

    private func badge(_ text: String, color: Color) -> some View {
        Text(text)
            .font(.caption2)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(color.opacity(0.15), in: Capsule())
            .foregroundStyle(color)
    }

    // MARK: - 状态与开关

    @ViewBuilder
    private var backendStatusBanner: some View {
        if case .failed(let message) = model.backendState {
            VStack(alignment: .leading, spacing: 4) {
                Label("后端不可用", systemImage: "exclamationmark.triangle.fill")
                    .font(.callout.weight(.semibold))
                    .foregroundStyle(.red)
                Text(message)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.red.opacity(0.08))
        }
    }

    private var syncToggleButton: some View {
        Button {
            model.toggleSync()
        } label: {
            Image(systemName: model.status?.syncEnabled == true ? "pause.circle" : "play.circle")
        }
        .help(model.status?.syncEnabled == true ? "关闭 联系人后台同步" : "开启 联系人后台同步")
        .disabled(model.clientUnavailable)
    }

    private var statusFooter: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(statusText)
                .font(.caption)
                .lineLimit(2)
            if let message = model.lastOperationMessage {
                Text(message)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            if let checkedAt = model.lastMessageCheckAt {
                HStack(spacing: 4) {
                    Image(systemName: "arrow.triangle.2.circlepath")
                    Text("消息列表最近检查")
                    Text(checkedAt, style: .time)
                    if model.lastMessageCheckCount > 0 {
                        Text("· 新增 " + String(model.lastMessageCheckCount) + " 条")
                    }
                }
                .font(.caption2)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            }
            Button("立即检查一次") {
                model.checkNow()
            }
            .font(.caption)
            .disabled(model.clientUnavailable)
        }
        .padding(10)
    }

    private var statusText: String {
        if model.status?.syncMode == "cli_background" {
            switch (model.status?.syncEnabled, model.status?.cliSyncPhase) {
            case (false, _):
                return "联系人后台同步已关闭"
            case (true, "active"):
                return "CLI 后台同步中：已绑定 \(model.status?.cliBoundCount ?? 0) 个会话"
            case (true, "degraded"):
                if model.status?.cliStreamActive == true,
                   model.status?.cliSyncMode == "global_follow" {
                    return "CLI 后台同步中（全局流在线，部分读取失败）：已绑定 \(model.status?.cliBoundCount ?? 0) 个会话"
                }
                return "CLI 后台同步降级轮询：已绑定 \(model.status?.cliBoundCount ?? 0) 个会话"
            case (true, "waiting_bindings"):
                return "等待批量绑定微信私聊会话"
            default:
                return "CLI 后台同步状态读取中"
            }
        }
        switch (model.status?.syncEnabled, model.status?.phase) {
        case (false, _):
            return "同步已关闭"
        case (true, "active"):
            let name = model.status?.activeBindingDisplayName ?? "未知联系人"
            return "前台同步中：\(name)"
        case (true, "waiting_foreground"):
            return "等待微信前台"
        case (true, "failed"):
            return "同步失败：\(model.status?.failureCode ?? "unknown")"
        case (true, "unavailable"):
            return "会话不可定位：\(model.status?.decisionReason ?? "unknown")"
        default:
            return "后端状态读取中"
        }
    }

    // MARK: - 中栏消息流

    @ViewBuilder
    private var messageStreamView: some View {
        if model.selectedContactId == nil {
            VStack {
                Spacer()
                Image(systemName: "bubble.left.and.bubble.right")
                    .font(.largeTitle)
                    .foregroundStyle(.tertiary)
                Text("选择联系人查看消息流")
                    .foregroundStyle(.secondary)
                Spacer()
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .navigationTitle("消息流")
        } else {
            messageList
        }
    }

    private var messageList: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 6) {
                    if model.messageStreamState == .loadingFirstPage {
                        ProgressView("加载消息…")
                            .frame(maxWidth: .infinity)
                            .padding()
                    } else if case .failed(let message) = model.messageStreamState {
                        Text("消息流加载失败：\(message)")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .padding()
                        Button("重试") { model.loadFirstMessagePage() }
                            .padding()
                    }
                    if model.hasMoreMessages {
                        Button("加载更早的消息") {
                            model.loadMoreMessages()
                        }
                        .font(.caption)
                        .buttonStyle(.link)
                        .padding(.vertical, 4)
                        .frame(maxWidth: .infinity)
                    }
                    ForEach(model.messages) { message in
                        messageRow(message)
                            .id(message.messageId)
                    }
                }
                .padding(10)
            }
            .onAppear {
                scrollProxy = proxy
            }
            .onChange(of: model.messages.first?.messageId) { _, newValue in
                guard let newValue else { return }
                // 只有头部增加新消息（SSE 追加/断线对账）时才滚到最新；
                // 「加载更早的消息」向尾部扩展，不打扰当前视口。
                withAnimation {
                    proxy.scrollTo(newValue, anchor: .top)
                }
            }
        }
        .navigationTitle(model.selectedContactDisplayName ?? "消息流")
    }

    private func messageRow(_ message: MessageEntry) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack {
                Text(speakerLabel(message.speaker))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
                if let occurredAt = message.occurredAt {
                    Text(displayTime(occurredAt))
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }
            if let quoted = message.quoted {
                quotedBlock(message, quoted: quoted)
            }
            if !message.text.isEmpty {
                Text(message.text)
                    .textSelection(.enabled)
            } else if let placeholder = message.mediaPlaceholder {
                HStack(spacing: 4) {
                    Image(systemName: mediaIcon(message.messageType))
                        .foregroundStyle(.secondary)
                    Text(placeholder)
                        .font(.callout)
                        .italic()
                        .foregroundStyle(.secondary)
                }
            }
            Button("用于回复") {
                model.selectedReplyMessageId = message.messageId
            }
            .font(.caption2)
            .buttonStyle(.link)
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            message.speaker == "user"
                ? Color.accentColor.opacity(0.06)
                : Color.clear,
            in: RoundedRectangle(cornerRadius: 8)
        )
    }

    @ViewBuilder
    private func quotedBlock(
        _ message: MessageEntry,
        quoted: QuotedMessage
    ) -> some View {
        if let targetId = quoted.targetMessageId,
           model.messages.contains(where: { $0.messageId == targetId }) {
            // 引用目标在已加载范围：点击可定位到目标消息。
            Button {
                withAnimation {
                    scrollProxy?.scrollTo(targetId, anchor: .center)
                }
            } label: {
                quotedLabel(quoted)
            }
            .buttonStyle(.plain)
        } else {
            quotedLabel(quoted)
        }
    }

    private func quotedLabel(_ quoted: QuotedMessage) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 4) {
            Image(systemName: "quote.opening")
                .font(.caption2)
                .foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 1) {
                Text(quoted.text)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(3)
                if quoted.targetMessageId == nil {
                    Text("引用目标缺失：未解析引用")
                        .font(.caption2)
                        .foregroundStyle(.orange)
                }
            }
            Spacer()
        }
        .padding(6)
        .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 6))
    }

    private func speakerLabel(_ speaker: String) -> String {
        switch speaker {
        case "user":
            return "我"
        case "contact":
            return "对方"
        case "system":
            return "系统"
        default:
            return speaker
        }
    }

    private func mediaIcon(_ type: String) -> String {
        switch type {
        case "image":
            return "photo"
        case "sticker":
            return "smiley"
        case "voice", "voip":
            return "waveform"
        case "video", "channel_video":
            return "video"
        case "file":
            return "doc"
        case "transfer":
            return "yensign.circle"
        case "system":
            return "info.circle"
        default:
            return "paperclip"
        }
    }

    private func displayTime(_ iso: String) -> String {
        // 契约：秒级 UTC（2027-01-15T08:00:01Z）。
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var date = formatter.date(from: iso)
        if date == nil {
            formatter.formatOptions = [.withInternetDateTime]
            date = formatter.date(from: iso)
        }
        guard let date else {
            return ""
        }
        let time = DateFormatter()
        time.dateFormat = "MM-dd HH:mm"
        return time.string(from: date)
    }

    private var memoryManagementView: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Text("记忆管理")
                    .font(.headline)
                if let error = model.memoryError {
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(.red)
                }
                manualEntrySection
                Divider()
                pendingCandidatesSection
                Divider()
                contactMemoriesSection
                Divider()
                ownerMemoriesSection
            }
            .padding(12)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    // 手动录入：文本 + 分类 + 级别（联系人级 / owner 级）。
    private var manualEntrySection: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("手动录入记忆")
                .font(.subheadline.weight(.semibold))
            TextField("记忆正文（例如：对方喜欢提前约时间）", text: $newMemoryText, axis: .vertical)
                .textFieldStyle(.roundedBorder)
                .lineLimit(2...4)
            HStack {
                Picker("分类", selection: $newMemoryCategory) {
                    ForEach(MemoryCategoryOption.allCases) { option in
                        Text(option.label).tag(option.rawValue)
                    }
                }
                .pickerStyle(.menu)
                .frame(maxWidth: 160)
                Button("录入（联系人）") {
                    model.addManualMemory(
                        text: newMemoryText,
                        category: newMemoryCategory,
                        level: "contact"
                    )
                    newMemoryText = ""
                }
                .disabled(
                    model.memoryInFlight
                        || newMemoryText.trimmingCharacters(in: .whitespaces).isEmpty
                )
                Button("录入（自己）") {
                    model.addManualMemory(
                        text: newMemoryText,
                        category: newMemoryCategory,
                        level: "owner"
                    )
                    newMemoryText = ""
                }
                .disabled(
                    model.memoryInFlight
                        || newMemoryText.trimmingCharacters(in: .whitespaces).isEmpty
                )
                .help("录入一条关于自己的长期事实（owner 级）")
            }
        }
        .padding(10)
        .background(Color.secondary.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
    }

    // 待处理候选：第一次人工处理（确认 / 丢弃）。
    private var pendingCandidatesSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("待处理候选（低置信）")
                .font(.subheadline.weight(.semibold))
            if model.pendingMemoryCandidates.isEmpty {
                Text("没有待处理候选。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(model.pendingMemoryCandidates) { candidate in
                    HStack(alignment: .top) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(candidate.text)
                            Text("分类：\(categoryLabel(candidate.category))")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                            if let subject = candidate.subject {
                                Text("主体：\(subjectLabel(subject))")
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                            if let confidence = candidate.confidence {
                                Text("置信度：\(confidence * 100, specifier: "%.0f%%")")
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                            if let riskFlags = candidate.riskFlags,
                               !riskFlags.isEmpty {
                                Text("风险：\(riskFlags.joined(separator: "、"))")
                                    .font(.caption2)
                                    .foregroundStyle(.orange)
                            }
                            if let sourceIds = candidate.sourceIds,
                               !sourceIds.isEmpty {
                                Text("来源：\(sourceIds.joined(separator: "、"))")
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        Spacer()
                        Button("确认") {
                            model.confirmPendingCandidate(candidate)
                        }
                        .font(.caption)
                        Button("丢弃") {
                            model.discardPendingCandidate(candidate)
                        }
                        .font(.caption)
                    }
                    .padding(8)
                    .background(Color.secondary.opacity(0.05), in: RoundedRectangle(cornerRadius: 6))
                }
            }
        }
    }

    // 已确认的联系人级记忆。
    private var contactMemoriesSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("联系人记忆")
                .font(.subheadline.weight(.semibold))
            if model.contactMemories.isEmpty {
                Text("当前联系人还没有记忆。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(model.contactMemories) { memory in
                    memoryRow(memory)
                }
            }
        }
    }

    // owner 级记忆。
    private var ownerMemoriesSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("关于自己的记忆")
                .font(.subheadline.weight(.semibold))
            if model.ownerMemories.isEmpty {
                Text("还没有关于自己的记忆。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(model.ownerMemories) { memory in
                    memoryRow(memory)
                }
            }
        }
    }

    private func memoryRow(_ memory: MemoryEntry) -> some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 2) {
                if editingMemoryId == memory.memoryId {
                    TextField("修正后的记忆文本", text: $editingMemoryText, axis: .vertical)
                        .textFieldStyle(.roundedBorder)
                        .lineLimit(2...4)
                    HStack {
                        Button("保存修正") {
                            model.correctMemory(memory, newText: editingMemoryText)
                            editingMemoryId = nil
                        }
                        .font(.caption)
                        .disabled(
                            editingMemoryText.trimmingCharacters(in: .whitespaces).isEmpty
                        )
                        Button("取消") {
                            editingMemoryId = nil
                        }
                        .font(.caption)
                    }
                } else {
                    Text(memory.text)
                    Text("\(categoryLabel(memory.category)) · \(adoptionLabel(memory.adoptionMethod)) · 修订 \(memory.revision ?? 1)")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    if let confidence = memory.confidence {
                        Text("置信度：\(confidence * 100, specifier: "%.0f%%")")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                    if let riskFlags = memory.riskFlags,
                       !riskFlags.isEmpty {
                        Text("风险：\(riskFlags.joined(separator: "、"))")
                            .font(.caption2)
                            .foregroundStyle(.orange)
                    }
                    if let sourceIds = memory.sourceIds,
                       !sourceIds.isEmpty {
                        Text("来源：\(sourceIds.joined(separator: "、"))")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            Spacer()
            if editingMemoryId != memory.memoryId {
                Button("修正") {
                    editingMemoryText = memory.text
                    editingMemoryId = memory.memoryId
                }
                .font(.caption)
                Button("删除") {
                    model.deleteMemory(memory)
                }
                .font(.caption)
            }
        }
        .padding(8)
        .background(Color.secondary.opacity(0.05), in: RoundedRectangle(cornerRadius: 6))
    }

    private func categoryLabel(_ raw: String) -> String {
        MemoryCategoryOption(rawValue: raw)?.label ?? raw
    }

    private func subjectLabel(_ raw: String) -> String {
        switch raw {
        case "self": return "关于我"
        case "contact": return "关于联系人"
        case "shared": return "共同关系"
        default: return raw
        }
    }

    private func adoptionLabel(_ raw: String) -> String {
        raw == "manual" ? "手动" : "自动"
    }

    // 导入页：选择 JSONL → 预览校验 → 选/建联系人 → 提交 → 触发任务。
    private var importView: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Text("历史导入")
                    .font(.headline)
                if let error = model.importError {
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(.red)
                }
                importPathSection
                if let preview = model.importPreview {
                    previewSummary(preview)
                    importCommitSection
                } else {
                    Text("选择一份微信单联系人 JSONL 文件开始。")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Divider()
                taskSection
                Divider()
                ImportedSourcesView(model: model)
            }
            .padding(12)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private var importPathSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("文件路径")
                .font(.subheadline.weight(.semibold))
            HStack {
                TextField("/path/to/chat.jsonl", text: $importPath)
                    .textFieldStyle(.roundedBorder)
                Button("选择…") {
                    chooseImportFile()
                }
                Button("预览校验") {
                    model.previewImport(path: importPath)
                }
                .disabled(
                    model.importInFlight
                        || importPath.trimmingCharacters(in: .whitespaces).isEmpty
                )
            }
        }
        .padding(10)
        .background(Color.secondary.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
    }

    private func previewSummary(_ preview: ImportPreview) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("校验通过：\(preview.fileName)")
                .font(.subheadline.weight(.semibold))
            Text("消息 \(preview.recordCount) 条；类型分布：\(kindSummary(preview))")
                .font(.caption)
            if let owner = preview.ownerChannelIdentity {
                Text("本人：\(owner.observedName)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if let contact = preview.contactChannelIdentity {
                Text("联系人：\(contact.observedName)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(10)
        .background(Color.secondary.opacity(0.05), in: RoundedRectangle(cornerRadius: 8))
    }

    private var importCommitSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("导入到")
                .font(.subheadline.weight(.semibold))
            Picker("联系人", selection: $importTargetContact) {
                ForEach(model.contacts) { contact in
                    Text(contact.displayName).tag(contact.contactId)
                }
            }
            .pickerStyle(.menu)
            TextField("或新建联系人名称", text: $newImportContactName)
                .textFieldStyle(.roundedBorder)
            HStack {
                Button("选择既有联系人导入") {
                    model.commitImport(
                        path: importPath,
                        contactId: importTargetContact,
                        newContactName: nil
                    )
                }
                .disabled(model.importInFlight || importTargetContact.isEmpty)
                Button("新建联系人导入") {
                    model.commitImport(
                        path: importPath,
                        contactId: nil,
                        newContactName: newImportContactName
                    )
                }
                .disabled(
                    model.importInFlight
                        || newImportContactName.trimmingCharacters(in: .whitespaces).isEmpty
                )
            }
        }
        .padding(10)
        .background(Color.secondary.opacity(0.05), in: RoundedRectangle(cornerRadius: 8))
    }

    // 任务：触发当前联系人的记忆提取；进度展示（事件推送 + 轮询兜底）。
    private var taskSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("记忆提取任务")
                .font(.subheadline.weight(.semibold))
            HStack {
                Button("触发当前联系人任务") {
                    model.startTask()
                }
                .disabled(model.selectedContactId == nil)
                if let state = model.taskState {
                    Text("状态：\(state)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            if let progress = model.taskProgress {
                VStack(alignment: .leading, spacing: 2) {
                    Text("步骤：\(stepLabel(progress.step))")
                        .font(.caption)
                    Text("处理 \(progress.processedCount) · 尝试 \(progress.attemptCount) · 重试 \(progress.retryCount)")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    if let errorCode = progress.errorCode, !errorCode.isEmpty {
                        Text("失败分类：\(errorCode)")
                            .font(.caption2)
                            .foregroundStyle(.red)
                    }
                }
                .padding(8)
                .background(Color.secondary.opacity(0.05), in: RoundedRectangle(cornerRadius: 6))
            }
        }
        .padding(10)
        .background(Color.secondary.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
    }

    private func chooseImportFile() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.json]
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        if panel.runModal() == .OK, let url = panel.url {
            importPath = url.path
            model.previewImport(path: url.path)
        }
    }

    private func kindSummary(_ preview: ImportPreview) -> String {
        preview.kindCounts
            .sorted { $0.key < $1.key }
            .map { "\($0.key):\($0.value)" }
            .joined(separator: " ")
    }

    private func stepLabel(_ raw: String) -> String {
        switch raw {
        case "parse": return "解析"
        case "normalize": return "规范化"
        case "extract_memory": return "提取记忆"
        case "index": return "建立索引"
        case "verify": return "校验"
        case "claiming": return "等待执行"
        default: return raw
        }
    }

    // Skill 库管理页：导入、启用/停用、删除与台账概览。
    private var skillLibraryView: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Text("Skill 库")
                    .font(.headline)
                if let error = model.skillError {
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(.red)
                }
                skillImportSection
                Divider()
                skillListSection
                Divider()
                ledgerSection
            }
            .padding(12)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private var skillImportSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("导入 Skill 包")
                .font(.subheadline.weight(.semibold))
            HStack {
                TextField("/path/to/skill-dir", text: $skillPackagePath)
                    .textFieldStyle(.roundedBorder)
                Button("选择…") {
                    chooseSkillPackage()
                }
                Button("导入") {
                    model.importSkill(packagePath: skillPackagePath)
                }
                .disabled(
                    model.skillInFlight
                        || skillPackagePath.trimmingCharacters(in: .whitespaces).isEmpty
                )
            }
        }
        .padding(10)
        .background(Color.secondary.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
    }

    private var skillListSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("已安装 Skill")
                .font(.subheadline.weight(.semibold))
            if model.skills.isEmpty {
                Text("还没有 Skill。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(model.skills) { skill in
                    skillRow(skill)
                }
            }
        }
    }

    private func skillRow(_ skill: SkillEntry) -> some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 2) {
                Text(skill.name)
                    .font(.callout.weight(.medium))
                Text(skill.description)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text("v\(skill.currentVersionNumber ?? 1) · \(skill.status)")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            Spacer()
            Button("预览") {
                model.previewSkill(skill)
            }
            .font(.caption)
            Button(skill.enabled ? "停用" : "启用") {
                model.toggleSkill(skill)
            }
            .font(.caption)
            Button("删除") {
                model.deleteSkill(skill)
            }
            .font(.caption)
            .foregroundStyle(.red)
        }
        .padding(8)
        .background(Color.secondary.opacity(0.05), in: RoundedRectangle(cornerRadius: 6))
        .sheet(isPresented: skillPreviewBinding(for: skill)) {
            skillPreviewSheet(skill)
        }
    }

    // 预览 sheet 展示当前版本内容与资源清单（无联系人资料）。
    private func skillPreviewBinding(for skill: SkillEntry) -> Binding<Bool> {
        Binding(
            get: { model.skillPreview?.skillId == skill.skillId },
            set: { newValue in
                if !newValue {
                    model.skillPreview = nil
                }
            }
        )
    }

    private func skillPreviewSheet(_ skill: SkillEntry) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("\(skill.name) v\(model.skillPreview?.versionNumber ?? 1)")
                .font(.headline)
            if let preview = model.skillPreview {
                ScrollView {
                    Text(preview.document)
                        .font(.body.monospaced())
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                Text("辅助资源：\(preview.resources.joined(separator: "、"))")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            HStack {
                Spacer()
                Button("关闭") {
                    model.skillPreview = nil
                }
                .keyboardShortcut(.cancelAction)
            }
        }
        .padding(20)
        .frame(width: 520, height: 420)
    }

    // 出站台账概览：只含元数据，不含正文。
    private var ledgerSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("出站台账概览")
                .font(.subheadline.weight(.semibold))
            if let summary = model.ledgerSummary {
                Text("调用 \(summary.totalCalls) 次 · 输入 \(summary.totalInputTokens) tokens · 输出 \(summary.totalOutputTokens) tokens")
                    .font(.caption)
                Text("供应商：\(summary.providerCounts.map { "\($0.key):\($0.value)" }.joined(separator: " "))")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                Text("结果：\(summary.outcomeCounts.map { "\($0.key):\($0.value)" }.joined(separator: " "))")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            } else {
                Text("暂无台账记录。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(10)
        .background(Color.secondary.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
    }

    private func chooseSkillPackage() {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = true
        panel.canChooseFiles = true
        if panel.runModal() == .OK, let url = panel.url {
            skillPackagePath = url.path
        }
    }

    // MARK: - Follow 人工验证

    // Issue 04 的产品入口：所有微信动作仍由用户完成，App 只驱动本地诊断
    // 接缝并显示阶段、计数、水位和错误码，不显示聊天正文。
    private var followSmokeView: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                cliBindingManagementCard
                Divider()
                Text("前台同步人工验证")
                    .font(.headline)
                Text("这是 Issue 04 的 App 内验证向导。开始后切到微信并保持目标会话可见；验证期间不需要切回此窗口，使用菜单栏 NotAlone 或全局快捷键记录检查点。App 只记录本地元数据，不切换微信、不滚动会话、不发送消息。")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)

                if let error = model.followSmokeError {
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(.red)
                }

                if model.status?.syncMode != "cli_background",
                   let candidates = model.status?.candidates,
                   !candidates.isEmpty {
                    pendingBindingCard(candidates)
                }

                followSmokeControlCard
                if let smoke = model.followSmoke {
                    followSmokeStatusCard(smoke)
                    if smoke.active {
                        followSmokeActionCard(smoke)
                    }
                    followSmokeCheckpointsCard(smoke)
                } else {
                    ProgressView("正在读取验证状态…")
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .padding(12)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private var cliBindingManagementCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("已确认联系人的后台同步")
                .font(.headline)
            Text("请选择需要同步的一对一会话，首次不会预选。确认绑定并开启同步后，应用运行期间会在后台读取所选联系人的文字消息，不要求微信保持前台。关闭同步或退出应用即可停止；重新开启后会补齐绑定之后的可检测缺口。不会自动发送消息。")
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            if let status = model.status,
               status.syncMode == "cli_background",
               let failure = status.cliBackfillFailureCode ?? status.cliFailureCode {
                syncInfoRow("最近读取问题", value: cliFailureLabel(failure), color: .orange)
            }

            HStack {
                Button("刷新微信私聊列表") {
                    model.loadCliSessions()
                }
                .disabled(model.cliSessionsInFlight || model.cliBindingsInFlight)
                if model.cliSessionsInFlight {
                    ProgressView()
                        .controlSize(.small)
                }
                Spacer()
                Text("已选 \(selectedCliCount) / \(unboundCliCount)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            if let error = model.cliSessionsError {
                Text("读取 CLI 私聊列表失败：\(error)")
                    .font(.caption)
                    .foregroundStyle(.red)
            }
            if let error = model.cliBindingError {
                Text("批量绑定失败：\(error)")
                    .font(.caption)
                    .foregroundStyle(.red)
            }

            if model.cliSessions.isEmpty {
                Text("还没有读到 CLI 私聊会话；请确认微信 CLI 可用后刷新。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                HStack {
                    Button("全选当前未绑定会话") {
                        selectedCliLocators = Set(model.cliSessions
                            .filter { $0.boundContactId == nil }
                            .map(\.username))
                    }
                    .disabled(unboundCliCount == 0)
                    Button("清空选择") {
                        selectedCliLocators.removeAll()
                    }
                    .disabled(selectedCliCount == 0)
                }
                .disabled(model.cliSessionsInFlight || model.cliBindingsInFlight)
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(model.cliSessions) { candidate in
                        cliSessionRow(candidate)
                    }
                }
                .padding(8)
                .background(Color.secondary.opacity(0.05), in: RoundedRectangle(cornerRadius: 6))
            }

            Button("确认绑定所选会话") {
                model.confirmCliBindings(selectedCliSelections())
            }
            .buttonStyle(.borderedProminent)
            .disabled(
                selectedCliCount == 0
                    || model.cliSessionsInFlight
                    || model.cliBindingsInFlight
            )

            if let status = model.status, status.syncMode == "cli_background" {
                Divider()
                Text("后台运行状态")
                    .font(.subheadline.weight(.semibold))
                syncInfoRow(
                    "CLI 阶段",
                    value: cliSyncPhaseLabel(
                        status.cliSyncPhase,
                        streamActive: status.cliStreamActive == true,
                        streamMode: status.cliSyncMode
                    )
                )
                syncInfoRow("CLI 流", value: status.cliStreamActive == true ? "全局流运行中" : "有界轮询")
                syncInfoRow("已绑定会话", value: String(status.cliBoundCount ?? 0))
                syncInfoRow("本轮新增", value: String(status.cliBatchMessageCount ?? 0))
                syncInfoRow("前台 OCR", value: foregroundPhaseLabel(status.foregroundPhase))
                if let failure = status.cliFailureCode {
                    syncInfoRow("CLI 错误", value: cliFailureLabel(failure), color: .red)
                }
                if let failure = status.foregroundFailureCode {
                    syncInfoRow("前台错误码", value: failure, color: .orange)
                }
            }
            backfillCoverageCard
        }
        .padding(10)
        .background(Color.green.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
        .onChange(of: model.cliSessions) { _, sessions in
            syncCliSelection(sessions)
        }
    }

    @ViewBuilder
    private var backfillCoverageCard: some View {
        if let status = model.status, status.syncMode == "cli_background" {
            VStack(alignment: .leading, spacing: 8) {
                Divider()
                Text("后台补齐覆盖")
                    .font(.subheadline.weight(.semibold))
                Text("补齐只读取已确认的一对一会话，并展示阶段、计数和可靠游标等元数据，不显示聊天正文。暂停、失败或无法确认完整性都不会标记为完成。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)

                syncInfoRow(
                    "补齐阶段",
                    value: BackfillStatusPresentation.phaseLabel(status.cliBackfillPhase),
                    color: backfillPhaseColor(status.cliBackfillPhase)
                )
                syncInfoRow(
                    "当前联系人",
                    value: contactDisplayName(for: status.cliBackfillContactId)
                )

                if let progress = BackfillStatusPresentation.progress(
                    completed: status.cliBackfillCompletedContacts,
                    total: status.cliBackfillTotalContacts
                ) {
                    ProgressView(value: progress)
                        .progressViewStyle(.linear)
                    syncInfoRow(
                        "联系人进度",
                        value: "\(status.cliBackfillCompletedContacts ?? 0) / \(status.cliBackfillTotalContacts ?? 0)"
                    )
                } else {
                    syncInfoRow("联系人进度", value: "暂无待处理会话")
                }

                syncInfoRow(
                    "成功 / 跳过",
                    value: "\(status.cliBackfillSucceededContacts ?? 0) / \(status.cliBackfillSkippedContacts ?? 0)"
                )
                syncInfoRow(
                    "失败 / 无法确认",
                    value: "\(status.cliBackfillFailedContacts ?? 0) / \(status.cliBackfillIncompleteContacts ?? 0)",
                    color: (status.cliBackfillFailedContacts ?? 0) > 0
                        || (status.cliBackfillIncompleteContacts ?? 0) > 0
                        ? .orange
                        : .secondary
                )
                syncInfoRow(
                    "文本 / 非文字事件",
                    value: "\(status.cliBackfillTotalMessageCount ?? 0) / \(status.cliBackfillTotalNonTextCount ?? 0)"
                )
                syncInfoRow(
                    "当前批次",
                    value: "\(status.cliBackfillMessageCount ?? 0) 条文本 · \(status.cliBackfillNonTextCount ?? 0) 个非文字事件"
                )

                if let cursor = status.cliBackfillLastCursor {
                    syncInfoRow("最后可靠游标", value: cursor)
                }
                if let failure = status.cliBackfillFailureCode ?? status.cliFailureCode {
                    syncInfoRow("最近原因", value: cliFailureLabel(failure), color: .orange)
                }

                HStack(spacing: 8) {
                    if BackfillStatusPresentation.shouldOfferPause(status.cliBackfillPhase) {
                        Button("暂停补齐") {
                            model.pauseBackfill()
                        }
                    }
                    if BackfillStatusPresentation.shouldOfferRetry(status.cliBackfillPhase) {
                        Button(status.cliBackfillPhase == "paused" ? "恢复补齐" : "重试补齐") {
                            model.retryBackfill()
                        }
                    }
                    if model.backfillControlInFlight {
                        ProgressView()
                            .controlSize(.small)
                    }
                }
                .font(.caption)
                .disabled(model.clientUnavailable || model.backfillControlInFlight)
            }
        }
    }

    @ViewBuilder
    private func cliSessionRow(_ candidate: CliSessionCandidate) -> some View {
        if let boundContactId = candidate.boundContactId {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(.green)
                VStack(alignment: .leading, spacing: 2) {
                    Text(candidate.displayName)
                    Text("已绑定联系人：\(boundContactId)")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                if let timestamp = candidate.lastTimestamp {
                    Text(shortTimestamp(timestamp))
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }
        } else {
            VStack(alignment: .leading, spacing: 4) {
                Toggle(isOn: cliSelectionBinding(for: candidate.username)) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(candidate.displayName)
                        Text(candidate.username)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
                .toggleStyle(.checkbox)
                if selectedCliLocators.contains(candidate.username) {
                    TextField(
                        "绑定后的联系人名称",
                        text: cliDisplayNameBinding(for: candidate)
                    )
                    .textFieldStyle(.roundedBorder)
                    .padding(.leading, 22)
                }
            }
        }
    }

    private var unboundCliCount: Int {
        model.cliSessions.reduce(into: 0) { count, candidate in
            if candidate.boundContactId == nil { count += 1 }
        }
    }

    private var selectedCliCount: Int {
        model.cliSessions.reduce(into: 0) { count, candidate in
            if candidate.boundContactId == nil && selectedCliLocators.contains(candidate.username) {
                count += 1
            }
        }
    }

    private func syncCliSelection(_ sessions: [CliSessionCandidate]) {
        let available = Set(
            sessions
                .filter { $0.boundContactId == nil }
                .map(\.username)
        )
        // 刷新只保留用户仍有效的选择，新增会话等待用户主动勾选。
        selectedCliLocators.formIntersection(available)
        for candidate in sessions where cliDisplayNames[candidate.username] == nil {
            cliDisplayNames[candidate.username] = candidate.displayName
        }
    }

    private func cliSelectionBinding(for username: String) -> Binding<Bool> {
        Binding(
            get: { selectedCliLocators.contains(username) },
            set: { selected in
                if selected {
                    selectedCliLocators.insert(username)
                } else {
                    selectedCliLocators.remove(username)
                }
            }
        )
    }

    private func cliDisplayNameBinding(for candidate: CliSessionCandidate) -> Binding<String> {
        Binding(
            get: { cliDisplayNames[candidate.username] ?? candidate.displayName },
            set: { cliDisplayNames[candidate.username] = $0 }
        )
    }

    private func selectedCliSelections() -> [CliBindingSelection] {
        model.cliSessions.compactMap { candidate in
            guard candidate.boundContactId == nil,
                  selectedCliLocators.contains(candidate.username) else {
                return nil
            }
            let name = (cliDisplayNames[candidate.username] ?? candidate.displayName)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            return CliBindingSelection(
                locator: candidate.username,
                displayName: name.isEmpty ? candidate.displayName : name
            )
        }
    }

    private func syncInfoRow(
        _ title: String,
        value: String,
        color: Color = .secondary
    ) -> some View {
        HStack {
            Text(title)
                .foregroundStyle(.secondary)
            Spacer()
            Text(value)
                .foregroundStyle(color)
                .textSelection(.enabled)
        }
        .font(.caption)
    }

    private func contactDisplayName(for contactId: String?) -> String {
        guard let contactId, !contactId.isEmpty else { return "—" }
        return model.contacts.first(where: { $0.contactId == contactId })?.displayName
            ?? "未找到已确认联系人"
    }

    private func backfillPhaseColor(_ raw: String?) -> Color {
        switch raw {
        case "complete": return .green
        case "gap_detected", "backfilling": return .blue
        case "paused", "incomplete": return .orange
        case "failed": return .red
        default: return .secondary
        }
    }

    private func cliSyncPhaseLabel(
        _ raw: String?,
        streamActive: Bool = false,
        streamMode: String? = nil
    ) -> String {
        switch raw {
        case "active": return "运行中"
        case "degraded":
            if streamActive, streamMode == "global_follow" {
                return "全局流运行中（部分读取失败）"
            }
            return "降级有界轮询"
        case "waiting_bindings": return "等待绑定"
        case "disabled": return "已关闭"
        default: return raw ?? "未知"
        }
    }

    private func cliFailureLabel(_ raw: String) -> String {
        switch raw {
        case "cli_key_refresh_required":
            return "需要刷新本机微信读取密钥（运行 wxkey setup）"
        case "cli_freshness_unknown":
            return "CLI 未能确认已读取到最新位置"
        case "cli_message_table_missing":
            return "CLI 未找到该会话的本地消息表，无法确认覆盖范围"
        case "cli_invalid_argument":
            return "CLI 参数无效，请重启 NotAlone"
        default:
            return raw
        }
    }

    private func foregroundPhaseLabel(_ raw: String?) -> String {
        switch raw {
        case "active": return "已定位当前微信联系人"
        case "waiting_foreground": return "等待微信前台"
        case "unavailable": return "当前联系人未解析"
        case "failed": return "OCR/探针失败（不影响 CLI 后台）"
        case "sync_disabled": return "未启用"
        default: return raw ?? "未知"
        }
    }

    private func pendingBindingCard(_ candidates: [BindingCandidate]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("发现待确认的微信会话", systemImage: "person.crop.circle.badge.questionmark")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.orange)
            ForEach(candidates, id: \.username) { candidate in
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(candidate.displayName)
                        Text(candidate.username)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    if let timestamp = candidate.lastTimestamp {
                        Text(shortTimestamp(timestamp))
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                }
            }
            Text("候选来自最近一次微信前台观察；不会自动弹出窗口。切回 NotAlone 后主动处理，待确认证据 60 秒内有效。")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Button("处理绑定确认") {
                selectedCandidate = nil
                dismissBindingSheet = false
                showBindingConfirmation = true
            }
            .buttonStyle(.borderedProminent)
        }
        .padding(10)
        .background(Color.orange.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
    }

    private var followSmokeControlCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("开始前")
                .font(.subheadline.weight(.semibold))
            if model.status?.syncEnabled == true {
                Label("正式 联系人后台同步已开启", systemImage: "checkmark.circle.fill")
                    .foregroundStyle(.green)
                    .font(.caption)
            } else {
                Label("请先开启正式 联系人后台同步", systemImage: "exclamationmark.circle")
                    .foregroundStyle(.orange)
                    .font(.caption)
                Button("开启 联系人后台同步") {
                    model.setSyncEnabled(true)
                }
                .disabled(model.followSmokeInFlight)
            }
            Text("开始验证不会替你改变正式 CLI 同步开关；结束验证会把人工 Follow 兜底策略恢复为默认轮询。")
                .font(.caption)
                .foregroundStyle(.secondary)
            Text("操作顺序：在这里点开始 → 切到微信。之后用菜单栏或快捷键操作；主窗口只用于查看结果。")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if model.followSmoke?.active != true {
                Button("开始 Follow 验证") {
                    model.startFollowSmoke()
                }
                .buttonStyle(.borderedProminent)
                .disabled(
                    model.followSmokeInFlight
                        || model.status?.syncEnabled != true
                )
            } else {
                Button("结束验证并恢复轮询") {
                    model.stopFollowSmoke()
                }
                .buttonStyle(.bordered)
                .disabled(model.followSmokeInFlight)
            }
            Text("快捷键：⌃⌥⇧S 开始，E 结束，I 中断；⌃⌥⇧1–8 记录检查点。")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(10)
        .background(Color.secondary.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
    }

    private func followSmokeStatusCard(_ smoke: FollowSmokeStatus) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("运行状态")
                    .font(.subheadline.weight(.semibold))
                Spacer()
                if smoke.active {
                    badge("验证中", color: .blue)
                } else {
                    badge("未开始", color: .secondary)
                }
            }
            followSmokeInfoRow("同步阶段", value: followPhaseLabel(smoke.phase))
            followSmokeInfoRow("当前微信前台", value: boolLabel(smoke.wechatInFront))
            followSmokeInfoRow("探针 / CLI", value: boolLabel(smoke.probeAvailable) + " / " + boolLabel(smoke.cliAvailable))
            followSmokeInfoRow("Follow 流", value: smoke.followStreamActive ? "运行中" : "未运行")
            if let processId = smoke.followProcessId {
                followSmokeInfoRow("Follow PID", value: String(processId))
            }
            followSmokeInfoRow("读取模式", value: smoke.followMode ?? "无")
            followSmokeInfoRow("当前水位", value: smoke.followWatermark.map { String($0) } ?? "无")
            followSmokeInfoRow("本轮新增", value: smoke.batchMessageCount.map { String($0) } ?? "无")
            if let observation = smoke.lastValidObservation {
                followSmokeInfoRow("最近有效观察", value: observation.observedAt)
                followSmokeInfoRow(
                    "有效联系人",
                    value: observation.displayName ?? observation.contactId
                )
                followSmokeInfoRow(
                    "有效水位 / 新增",
                    value: (observation.watermark.map(String.init) ?? "无")
                        + " / " + String(observation.batchMessageCount)
                )
            } else {
                followSmokeInfoRow("最近有效观察", value: "暂无（等待微信前台）")
            }
            if let failure = smoke.failureCode {
                followSmokeInfoRow("错误码", value: failure, color: .red)
            }
        }
        .padding(10)
        .background(Color.secondary.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
    }

    private func followSmokeActionCard(_ smoke: FollowSmokeStatus) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("按人工动作记录")
                .font(.subheadline.weight(.semibold))
            Text("微信保持前台时，优先使用菜单栏或全局快捷键；下面按钮是回到主窗口后的备用入口。")
                .font(.caption)
                .foregroundStyle(.secondary)
            Text("每次按钮只保存固定标签、联系人级计数、观察来源数、水位、最新模式和重复身份数。")
                .font(.caption)
                .foregroundStyle(.secondary)
            Text("建议顺序：先记录基线；保持目标单聊在微信前台并记录前台准备；由你人工产生一条消息后记录实时到达；等待空闲后记录去重；需要异常验证时中断 Follow 流并等待恢复；最后再做后台、关闭/重开同步和最终记录。")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack {
                followCheckpointButton("记录基线", label: "baseline")
                followCheckpointButton("记录前台准备", label: "before_follow")
            }
            HStack {
                followCheckpointButton("记录实时到达", label: "after_live_message")
                followCheckpointButton("记录空闲去重", label: "after_idle")
            }
            HStack {
                Button("中断 Follow 流") {
                    model.interruptFollowSmoke()
                }
                .disabled(model.followSmokeInFlight || !smoke.followStreamActive)
                followCheckpointButton("记录异常恢复", label: "after_follow_restart")
            }
            HStack {
                followCheckpointButton("记录微信后台", label: "wechat_background")
                followCheckpointButton("记录重新开启后", label: "after_reenable")
            }
            HStack {
                Button("手动关闭同步") {
                    model.setSyncEnabled(false)
                }
                Button("手动重新开启同步") {
                    model.setSyncEnabled(true)
                }
            }
            .disabled(model.followSmokeInFlight)
            Button("记录最终结果") {
                model.checkpointFollowSmoke(label: "final")
            }
            .disabled(model.followSmokeInFlight)
        }
        .padding(10)
        .background(Color.blue.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
    }

    private func followCheckpointButton(_ title: String, label: String) -> some View {
        Button(title) {
            model.checkpointFollowSmoke(label: label)
        }
        .disabled(model.followSmokeInFlight)
    }

    private func followSmokeCheckpointsCard(_ smoke: FollowSmokeStatus) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("已记录检查点")
                .font(.subheadline.weight(.semibold))
            followSmokeCheckpointRows(smoke.checkpoints)
            followSmokeCurrentContactRows(smoke.contacts)
        }
        .padding(10)
        .background(Color.secondary.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
    }

    @ViewBuilder
    private func followSmokeCheckpointRows(
        _ checkpoints: [FollowSmokeCheckpoint]
    ) -> some View {
        if checkpoints.isEmpty {
            Text("还没有检查点；开始验证后按人工动作逐项记录。")
                .font(.caption)
                .foregroundStyle(.secondary)
        } else {
            ForEach(checkpoints) { checkpoint in
                followSmokeCheckpointRow(checkpoint)
            }
        }
    }

    private func followSmokeCheckpointRow(
        _ checkpoint: FollowSmokeCheckpoint
    ) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(followCheckpointLabel(checkpoint.label))
                    .font(.caption.weight(.medium))
                Spacer()
                Text(checkpoint.recordedAt)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            ForEach(checkpoint.contacts) { contact in
                Text(followContactSummary(contact: contact))
                    .font(.caption2)
                    .foregroundStyle(contact.duplicateIdentities == 0 ? Color.secondary : Color.red)
            }
        }
        .padding(8)
        .background(Color.secondary.opacity(0.05), in: RoundedRectangle(cornerRadius: 6))
    }

    @ViewBuilder
    private func followSmokeCurrentContactRows(
        _ contacts: [FollowSmokeContact]
    ) -> some View {
        if !contacts.isEmpty {
            Divider()
            Text("当前联系人元数据")
                .font(.caption.weight(.medium))
            ForEach(contacts) { contact in
                Text(followContactSummary(contact: contact, includeBinding: true))
                    .font(.caption2)
                    .foregroundStyle(contact.duplicateIdentities == 0 ? Color.secondary : Color.red)
            }
        }
    }

    private func followContactSummary(
        contact: FollowSmokeContact,
        includeBinding: Bool = false
    ) -> String {
        let binding = includeBinding ? (contact.bound ? "已绑定" : "未绑定") + " · " : ""
        let watermark = contact.watermark.map { String($0) } ?? "无"
        return "联系人：" + binding
            + "消息 " + String(contact.messageCount)
            + " · 来源 " + String(contact.observationRefCount)
            + " · 水位 " + watermark
            + " · 模式 " + contact.latestMode
            + " · 重复身份 " + String(contact.duplicateIdentities)
    }

    private func followSmokeInfoRow(
        _ title: String,
        value: String,
        color: Color = .secondary
    ) -> some View {
        HStack {
            Text(title)
                .foregroundStyle(.secondary)
            Spacer()
            Text(value)
                .foregroundStyle(color)
                .textSelection(.enabled)
        }
        .font(.caption)
    }

    private func boolLabel(_ value: Bool?) -> String {
        guard let value else { return "未知" }
        return value ? "是" : "否"
    }

    private func followPhaseLabel(_ raw: String?) -> String {
        switch raw {
        case "active": return "active（读取中）"
        case "waiting_foreground": return "等待微信前台"
        case "sync_disabled": return "同步已关闭"
        case "unavailable": return "会话不可用"
        case "failed": return "失败退避"
        default: return raw ?? "未知"
        }
    }

    private func followCheckpointLabel(_ raw: String) -> String {
        switch raw {
        case "baseline": return "基线"
        case "before_follow": return "Follow 前"
        case "after_live_message": return "实时到达后"
        case "after_idle": return "空闲去重后"
        case "after_follow_restart": return "异常恢复后"
        case "wechat_background": return "微信后台"
        case "after_reenable": return "重新开启后"
        case "final": return "最终结果"
        default: return raw
        }
    }

    // 设置页：模型凭据状态（不回显密钥）、探针调试窗口、同步参数说明。
    private var settingsView: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Text("设置")
                    .font(.headline)
                credentialsSection
                Divider()
                probeSection
                Divider()
                syncParametersSection
            }
            .padding(12)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    // 模型凭据：只显示是否已配置，不回显任何密钥值。
    private var credentialsSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("模型凭据")
                .font(.subheadline.weight(.semibold))
            Text("DeepSeek API 密钥经环境变量配置；界面只显示配置状态，不显示密钥。")
                .font(.caption)
                .foregroundStyle(.secondary)
            if let status = model.credentialsStatus {
                Text(status.configured ? "\(status.provider) 凭据：已配置" : "\(status.provider) 凭据：未配置（见首启向导）")
                    .font(.caption)
                    .foregroundStyle(status.configured ? Color.green : Color.orange)
            } else {
                Text("凭据状态：查询中…")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(10)
        .background(Color.secondary.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
    }

    // 探针调试窗口：从设置页打开独立探针应用（OCR 文本与裁剪预览）。
    private var probeSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("前台探针")
                .font(.subheadline.weight(.semibold))
            Text("探针独立运行，负责识别当前微信前台会话；调试窗口显示 OCR 文本与裁剪预览。")
                .font(.caption)
                .foregroundStyle(.secondary)
            Button("打开探针调试窗口") {
                openProbeDebugWindow()
            }
        }
        .padding(10)
        .background(Color.secondary.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
    }

    // 同步参数：只读说明，参数由后端启动配置。
    private var syncParametersSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("同步参数")
                .font(.subheadline.weight(.semibold))
            Text("同步心跳间隔由后端启动参数 --sync-interval 决定（默认 3 秒）；绑定确认与失败关闭语义见主窗口提示。")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(10)
        .background(Color.secondary.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
    }

    private func openProbeDebugWindow() {
        // 从仓库相对路径定位探针构建产物；找不到时提示（不阻塞）。
        if let executable = model.probeExecutableURL() {
            do {
                try Process.run(executable, arguments: [])
                model.lastOperationMessage = "已打开探针调试窗口"
            } catch {
                model.lastOperationMessage = "探针启动失败：\(error.localizedDescription)"
            }
        } else {
            model.lastOperationMessage = "未找到探针可执行文件（先构建 macos_sync_probe）"
        }
    }

    private var replyPlaceholder: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("回复工作区")
                .font(.headline)
            Divider()
            if model.selectedReplyMessageId == nil {
                Text("选中一条消息后可针对它生成候选回复。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                Text("已选中消息：回复将针对该消息生成。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if let selectedReplyMessageId = model.selectedReplyMessageId {
                replyToMessageSection(selectedReplyMessageId)
            } else {
                rewriteSection
            }
            Divider()
            skillAndBasisSummary
            candidatesSection
        }
        .padding(12)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .navigationTitle("回复")
    }

    // 针对已选中消息：填写表达方向。
    private func replyToMessageSection(_ messageId: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("表达方向（需要明确、自然）")
                .font(.caption)
                .foregroundStyle(.secondary)
            TextField("例如：自然地答应，并保持轻松", text: $replyDirection)
                .textFieldStyle(.roundedBorder)
            TextField("指定 Skill 版本 ID（可选）", text: $manualSkillVersion)
                .textFieldStyle(.roundedBorder)
                .font(.caption)
            Button("生成候选回复") {
                model.generateReplyToMessage(
                    direction: replyDirection,
                    skillVersionId: manualSkillVersion.isEmpty ? nil : manualSkillVersion
                )
            }
            .disabled(model.replyInFlight || replyDirection.trimmingCharacters(in: .whitespaces).isEmpty)
        }
        .padding(.vertical, 2)
    }

    // 用户原句 + 改写要求。
    private var rewriteSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("自己的原句（可选改写要求）")
                .font(.caption)
                .foregroundStyle(.secondary)
            TextField("输入想改写的原句", text: $rewriteDraft, axis: .vertical)
                .textFieldStyle(.roundedBorder)
                .lineLimit(2...4)
            TextField("改写要求（可选）", text: $rewriteInstruction)
                .textFieldStyle(.roundedBorder)
            TextField("指定 Skill 版本 ID（可选）", text: $manualSkillVersion)
                .textFieldStyle(.roundedBorder)
                .font(.caption)
            Toggle("结合联系人背景资料", isOn: $includeRelationshipContext)
                .font(.caption)
            Button("生成改写候选") {
                model.generateRewrite(
                    draftText: rewriteDraft,
                    instruction: rewriteInstruction.isEmpty ? nil : rewriteInstruction,
                    skillVersionId: manualSkillVersion.isEmpty ? nil : manualSkillVersion,
                    includeRelationshipContext: includeRelationshipContext
                )
            }
            .disabled(
                model.replyInFlight
                    || rewriteDraft.trimmingCharacters(in: .whitespaces).isEmpty
            )
        }
        .padding(.vertical, 2)
    }

    // 本次使用的 Skill 与上下文依据摘要。
    private var skillAndBasisSummary: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let skill = model.lastReplyUsedSkill {
                Text("本次 Skill：\(skill.name)")
                    .font(.caption)
                if let reason = skill.selectionReason, !reason.isEmpty {
                    Text("选择原因：\(reason)")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
            if model.replyEvidenceLoading {
                ProgressView("读取本次依据…")
            }
            if let error = model.replyEvidenceError {
                Text(error).font(.caption).foregroundStyle(.red)
                Button("重试读取依据") { model.loadReplyEvidence() }
            }
            if !model.replyEvidence.isEmpty {
                DisclosureGroup("本次上下文：\(model.replyEvidence.count) 项") {
                    Text("以下是生成时的材料快照；标记为引用的材料被候选明确引用。")
                        .font(.caption2).foregroundStyle(.secondary)
                    ScrollView {
                        VStack(alignment: .leading, spacing: 8) {
                            ForEach(model.replyEvidence) { entry in
                                ReplyEvidenceCard(entry: entry)
                            }
                        }
                    }.frame(maxHeight: 220)
                }
            }
            if let error = model.replyError {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
            }
        }
    }

    // 候选列表：可编辑、可复制；可基于历史候选继续生成。
    private var candidatesSection: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 8) {
                if model.replyInFlight {
                    ProgressView("生成候选…")
                        .frame(maxWidth: .infinity)
                        .padding()
                }
                ForEach(model.replyCandidates) { candidate in
                    candidateCard(candidate)
                }
            }
            .padding(.vertical, 4)
        }
        .frame(maxHeight: 320)
    }

    private func candidateCard(_ candidate: ReplyCandidate) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            // 候选正文可编辑；编辑内容按候选 id 保留于本会话内存，
            // 只影响复制与继续生成，不写回后端（改写/方向只约束本次生成）。
            TextField("候选正文", text: editedTextBinding(for: candidate), axis: .vertical)
                .font(.body)
                .textFieldStyle(.plain)
                .lineLimit(2...6)
            if !candidate.basis.isEmpty {
                Text("依据：\(candidate.basis)")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            if !candidate.riskNotes.isEmpty {
                Text("注意：\(candidate.riskNotes.joined(separator: "；"))")
                    .font(.caption2)
                    .foregroundStyle(.orange)
            }
            if !candidate.citationIds.isEmpty {
                DisclosureGroup("候选引用：\(candidate.citationIds.count) 项") {
                    let entries = model.replyEvidence.filter { candidate.citationIds.contains($0.evidenceId) }
                    ForEach(entries) { entry in ReplyEvidenceCard(entry: entry) }
                    if entries.count < candidate.citationIds.count {
                        Text("部分引用尚未读取，请查看上方依据读取状态。")
                            .font(.caption2).foregroundStyle(.secondary)
                    }
                }
                .font(.caption)
            }
            HStack {
                Button("复制") {
                    copyToPasteboard(currentText(of: candidate))
                    model.lastOperationMessage = "已复制候选回复"
                }
                .font(.caption)
                Button(currentText(of: candidate) == candidate.text ? "基于此继续生成" : "改写当前候选") {
                    continueFrom(candidate)
                }
                .font(.caption)
                Spacer()
            }
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            Color.secondary.opacity(0.06),
            in: RoundedRectangle(cornerRadius: 8)
        )
    }

    // 候选编辑文本按 candidateId 存储，避免 ForEach 复用视图时串值。
    private func editedTextBinding(for candidate: ReplyCandidate) -> Binding<String> {
        Binding(
            get: {
                editedCandidateTexts[candidate.candidateId] ?? candidate.text
            },
            set: { newValue in
                editedCandidateTexts[candidate.candidateId] = newValue
            }
        )
    }

    private func currentText(of candidate: ReplyCandidate) -> String {
        editedCandidateTexts[candidate.candidateId] ?? candidate.text
    }

    private func copyToPasteboard(_ text: String) {
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.setString(text, forType: .string)
    }

    private func continueFrom(_ candidate: ReplyCandidate) {
        // 基于历史候选继续：显式携带候选 id 继续生成（系统不推断
        // "最近未发送候选"；用户显式选择才继续）。
        let editedText = currentText(of: candidate)
        if editedText != candidate.text {
            // 编辑后的正文作为本次草稿；历史候选仍保留原始快照。
            let instruction = model.selectedReplyMessageId != nil
                ? replyDirection : rewriteInstruction
            model.generateRewrite(
                draftText: editedText,
                instruction: instruction.isEmpty ? nil : instruction,
                continuedFromCandidateId: candidate.candidateId,
                skillVersionId: manualSkillVersion.isEmpty ? nil : manualSkillVersion,
                includeRelationshipContext: model.selectedReplyMessageId != nil
                    || includeRelationshipContext
            )
        } else if model.selectedReplyMessageId != nil {
            model.generateReplyToMessage(
                direction: replyDirection,
                continuedFromCandidateId: candidate.candidateId,
                skillVersionId: manualSkillVersion.isEmpty ? nil : manualSkillVersion
            )
        } else {
            model.generateRewrite(
                draftText: rewriteDraft,
                instruction: rewriteInstruction.isEmpty ? nil : rewriteInstruction,
                continuedFromCandidateId: candidate.candidateId,
                skillVersionId: manualSkillVersion.isEmpty ? nil : manualSkillVersion,
                includeRelationshipContext: includeRelationshipContext
            )
        }
    }

    private var windowTitle: String {
        switch model.backendState {
        case .launching:
            return "NotAlone — 启动中"
        case .running:
            return "NotAlone"
        case .failed:
            return "NotAlone — 后端不可用"
        }
    }
}

private extension AppModel {
    var clientUnavailable: Bool {
        if case .running = backendState {
            return false
        }
        return true
    }
}
