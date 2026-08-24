import SwiftUI
import NotAloneAppCore

// 主窗口三栏骨架：左栏联系人列表与同步开关；中栏与右栏为后续
// 消息流（06）与回复工作区（08）占位。保持 owner 范围隔离：
// 联系人数据只来自后端当前 owner 的 API。
struct MainWindowView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        NavigationSplitView {
            sidebar
        } content: {
            messageStreamPlaceholder
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
            List(model.contacts) { contact in
                contactRow(contact)
            }
            .listStyle(.inset)
            Divider()
            statusFooter
        }
        .navigationSplitViewColumnWidth(min: 240, ideal: 280)
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

    // MARK: - 中栏与右栏占位

    private var messageStreamPlaceholder: some View {
        VStack {
            Spacer()
            Image(systemName: "bubble.left.and.bubble.right")
                .font(.largeTitle)
                .foregroundStyle(.tertiary)
            Text("消息流将在后续版本提供")
                .foregroundStyle(.secondary)
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .navigationTitle("消息流")
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