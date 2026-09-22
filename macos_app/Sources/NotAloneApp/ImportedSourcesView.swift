import SwiftUI
import NotAloneAppCore

struct ImportedSourcesView: View {
    @ObservedObject var model: AppModel
    @State private var pendingDeletion: ImportedSource?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("已导入的聊天资料").font(.headline)
                Spacer()
                Button("刷新") { model.loadImportedSources() }
                    .disabled(model.sourceRequestInFlight)
            }
            if model.selectedContactId == nil {
                Text("先选择联系人，查看其导入资料。")
            } else if model.importedSources.isEmpty {
                Text("当前联系人暂无导入资料。")
            }
            if let error = model.sourceError { Text(error).foregroundStyle(.red) }
            ForEach(model.importedSources) { source in
                HStack {
                    VStack(alignment: .leading) {
                        Text(source.fileName ?? "已删除的导入")
                        Text(source.statusLabel).font(.caption).foregroundStyle(.secondary)
                        if source.taskId != nil && !source.deletionComplete {
                            Text(source.stepLabel).font(.caption2)
                        }
                        if let reason = source.failureLabel {
                            Text(reason).font(.caption2).foregroundStyle(.red)
                        }
                    }
                    Spacer()
                    if !source.deletionComplete && source.errorCode != "legacy_deletion_unverified" {
                        Button(source.status == "active" ? "删除…" : "继续删除") {
                            if source.status == "active" { pendingDeletion = source }
                            else { model.deleteImportedSource(source) }
                        }
                        .disabled(model.sourceRequestInFlight)
                    }
                }
            }
            if model.sourceRequestInFlight { ProgressView("正在确认删除状态…") }
        }
        .font(.caption)
        .task(id: model.selectedContactId) { model.loadImportedSources() }
        .alert("删除这份导入资料？", isPresented: Binding(
            get: { pendingDeletion != nil },
            set: { if !$0 { pendingDeletion = nil } }
        )) {
            Button("删除", role: .destructive) {
                if let source = pendingDeletion { model.deleteImportedSource(source) }
                pendingDeletion = nil
            }
            Button("取消", role: .cancel) { pendingDeletion = nil }
        } message: {
            Text("清除 NotAlone 中这份导入及仅由它支持的聊天、记忆和回复依据。其他来源支持的资料与不含正文的 AI 调用记录保留。微信聊天和你原来的文件不变；外部模型副本需按供应商规则另行删除。")
        }
    }
}
