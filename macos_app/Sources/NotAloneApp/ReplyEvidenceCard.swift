import SwiftUI
import NotAloneAppCore

// 只展示生成时的快照，不把当时的状态描述为当前事实。
struct ReplyEvidenceCard: View {
    let entry: ReplyEvidence

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(entry.kindLabel + (entry.cited ? " · 候选引用" : " · 上下文材料"))
                .font(.caption).bold()
            Text(entry.text).font(.caption).textSelection(.enabled)
            if ["message", "confirmed_memory", "owner_memory"].contains(entry.kind) {
                ForEach(MemoryTimePresentation.lines(
                    timing: entry.timing, validAt: entry.validAt, invalidAt: entry.invalidAt
                ), id: \.self) { line in
                    Text(line).font(.caption2).foregroundStyle(.secondary)
                }
            }
            if !entry.selectionReason.isEmpty {
                Text("选入原因：" + entry.selectionReason)
                    .font(.caption2).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(8)
        .background(.quaternary.opacity(0.3), in: RoundedRectangle(cornerRadius: 6))
    }
}
