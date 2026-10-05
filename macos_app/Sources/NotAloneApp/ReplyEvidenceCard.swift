import SwiftUI
import NotAloneAppCore

// 只展示生成时的快照，不把当时的状态描述为当前事实。
// 待确认候选一律按未确认参考展示：带「未确认 · 仅供参考」标注、与已确认资料
// 视觉区分，不展示的正文用删除线保留候选身份（见 ReplyEvidencePresentationPolicy）。
struct ReplyEvidenceCard: View {
    let entry: ReplyEvidence
    let pendingCandidates: [MemoryCandidateEntry]
    let candidatesLoaded: Bool

    private var presentation: ReplyEvidencePresentation {
        ReplyEvidencePresentationPolicy.pendingReference(
            for: entry,
            pendingCandidates: pendingCandidates,
            candidatesLoaded: candidatesLoaded
        )
    }

    var body: some View {
        let presentation = presentation
        VStack(alignment: .leading, spacing: 4) {
            Text(presentation.title)
                .font(.caption).bold()
                .foregroundStyle(presentation.isUnconfirmed ? Color.orange : Color.primary)
            if presentation.isWithheld {
                Text(presentation.body)
                    .font(.caption).italic()
                    .foregroundStyle(.secondary)
                    .strikethrough()
            } else if presentation.isStruckThrough {
                Text(presentation.body)
                    .font(.caption).textSelection(.enabled)
                    .strikethrough()
            } else {
                Text(presentation.body).font(.caption).textSelection(.enabled)
            }
            ForEach(presentation.detailLines, id: \.self) { line in
                Text(line)
                    .font(.caption2)
                    .foregroundStyle(presentation.isUnconfirmed ? Color.orange : Color.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(8)
        .background(.quaternary.opacity(0.3), in: RoundedRectangle(cornerRadius: 6))
        .overlay {
            if presentation.isUnconfirmed {
                RoundedRectangle(cornerRadius: 6).strokeBorder(Color.orange.opacity(0.8), lineWidth: 1)
            }
        }
    }
}
