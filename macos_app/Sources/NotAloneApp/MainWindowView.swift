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
    // 候选出现时自动弹出一次；用户手动关闭后本会话不再自动弹出，
    // 同步保持暂停，直到用户再次打开确认入口。
    @State private var dismissBindingSheet = false
    // 回复工作区输入
    @State private var replyDirection = ""
    @State private var rewriteDraft = ""
    @State private var rewriteInstruction = ""
    @State private var manualSkillVersion = ""
    @State private var includeRelationshipContext = false
    // 候选正文的会话内编辑内容（按 candidateId）
    @State private var editedCandidateTexts: [String: String] = [:]
    // 右栏切换：0 = 回复工作区，1 = 记忆管理
    @State private var detailTab = 0
    // 记忆管理输入
    @State private var newMemoryText = ""
    @State private var newMemoryCategory = MemoryCategoryOption.preference.rawValue
    // 记忆行内修正编辑状态（按 memoryId）
    @State private var editingMemoryId: String?
    @State private var editingMemoryText = ""

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
                }
                .pickerStyle(.segmented)
                .padding(8)
                Divider()
                if detailTab == 0 {
                    replyPlaceholder
                } else {
                    memoryManagementView
                        .onAppear {
                            model.loadMemories()
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
        .onChange(of: model.status?.candidates.isEmpty) { _, isEmpty in
            guard isEmpty == false, !dismissBindingSheet else { return }
            selectedCandidate = nil
            showBindingConfirmation = true
        }
    }

    @State private var showBindingConfirmation = false

    // 有待确认候选绑定时弹出一次性选择列表；确认前同步保持暂停。
    // 用户手动关闭后本会话不再自动弹出（dismissBindingSheet 标记），
    // 确认后候选清空自动收起。
    private var bindingConfirmationSheet: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(selectedCandidate == nil ? "确认绑定到哪位联系人？" : "为「\(selectedCandidate?.displayName ?? "")」选择联系人")
                .font(.headline)
            Text("同步已暂停；选择后才会写入绑定并恢复读取。")
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
                model.confirmBinding(
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
        .help(model.status?.syncEnabled == true ? "关闭前台同步" : "开启前台同步")
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
            Button("立即检查一次") {
                model.checkNow()
            }
            .font(.caption)
            .disabled(model.clientUnavailable)
        }
        .padding(10)
    }

    private var statusText: String {
        switch (model.status?.syncEnabled, model.status?.phase) {
        case (false, _):
            return "同步已关闭"
        case (true, "active"):
            let name = model.status?.activeBindingDisplayName ?? "未知联系人"
            return "同步中：\(name)"
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

    private func adoptionLabel(_ raw: String) -> String {
        raw == "manual" ? "手动" : "自动"
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
            if !model.lastReplyContextEvidence.isEmpty {
                Text("上下文依据：\(model.lastReplyContextEvidence.count) 项")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
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
            HStack {
                Button("复制") {
                    copyToPasteboard(currentText(of: candidate))
                    model.lastOperationMessage = "已复制候选回复"
                }
                .font(.caption)
                Button("基于此继续生成") {
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
        if model.selectedReplyMessageId != nil {
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