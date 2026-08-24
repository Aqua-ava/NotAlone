import SwiftUI
import NotAloneAppCore

// 主窗口三栏骨架：左栏联系人列表与同步开关；中栏与右栏为后续
// 消息流（06）与回复工作区（08）占位。保持 owner 范围隔离：
// 联系人数据只来自后端当前 owner 的 API。
struct MainWindowView: View {
    @EnvironmentObject private var model: AppModel
    @State private var selectedContact: String?
    @State private var scrollProxy: ScrollViewProxy?

    var body: some View {
        NavigationSplitView {
            sidebar
        } content: {
            messageStreamView
        } detail: {
            replyPlaceholder
        }
        .navigationTitle(windowTitle)
        .toolbar {
            ToolbarItem(placement: .navigation) {
                syncToggleButton
            }
        }
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

    private var replyPlaceholder: some View {
        VStack {
            Spacer()
            Image(systemName: "square.and.pencil")
                .font(.largeTitle)
                .foregroundStyle(.tertiary)
            Text("回复工作区将在后续版本提供")
                .foregroundStyle(.secondary)
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .navigationTitle("回复")
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