import Foundation

// notalone-front-sync status 输出中的一个待选绑定候选。
// 只携带展示与选择所需字段，不含会话正文。
public struct FrontSyncCandidate: Equatable {
    public let username: String
    public let displayName: String

    public init(username: String, displayName: String) {
        self.username = username
        self.displayName = displayName
    }
}

// notalone-front-sync contacts 输出中的一个联系人条目。
public struct FrontSyncContactEntry: Equatable {
    public let contactId: String
    public let displayName: String

    public init(contactId: String, displayName: String) {
        self.contactId = contactId
        self.displayName = displayName
    }

    // 解析联系人列表输出；display_name 允许包含空格与表情符号。
    public static func parseList(_ output: String) -> [FrontSyncContactEntry] {
        var entries: [FrontSyncContactEntry] = []
        for rawLine in output.split(separator: "\n", omittingEmptySubsequences: true) {
            let line = rawLine.trimmingCharacters(in: .whitespaces)
            guard line.hasPrefix("contact_id="),
                  let marker = line.range(of: " display_name=") else {
                continue
            }
            let idStart = line.index(line.startIndex, offsetBy: "contact_id=".count)
            let contactId = String(line[idStart..<marker.lowerBound])
            let displayName = String(line[marker.upperBound...])
            guard !contactId.isEmpty, !displayName.isEmpty else {
                continue
            }
            entries.append(FrontSyncContactEntry(contactId: contactId, displayName: displayName))
        }
        return entries
    }
}

// notalone-front-sync status 的一次循环报告；命令输出只有状态、计数、
// 展示名称与候选标识，不包含消息正文。
public struct FrontSyncStatusReport: Equatable {
    public let syncEnabled: Bool
    public let phase: String
    public let wechatInFront: Bool
    public let cliAvailable: Bool
    public let failureCode: String?
    public let bindingDisplay: String?
    public let decision: String?
    public let batchMessages: Int
    public let candidates: [FrontSyncCandidate]

    public init(
        syncEnabled: Bool,
        phase: String,
        wechatInFront: Bool,
        cliAvailable: Bool,
        failureCode: String?,
        bindingDisplay: String?,
        decision: String?,
        batchMessages: Int,
        candidates: [FrontSyncCandidate]
    ) {
        self.syncEnabled = syncEnabled
        self.phase = phase
        self.wechatInFront = wechatInFront
        self.cliAvailable = cliAvailable
        self.failureCode = failureCode
        self.bindingDisplay = bindingDisplay
        self.decision = decision
        self.batchMessages = batchMessages
        self.candidates = candidates
    }

    // 解析 status 命令的 key=value 输出；必备字段缺失时返回 nil（失败关闭）。
    public static func parse(statusOutput: String) -> FrontSyncStatusReport? {
        var fields: [String: String] = [:]
        var candidates: [FrontSyncCandidate] = []
        for rawLine in statusOutput.split(separator: "\n", omittingEmptySubsequences: true) {
            let line = rawLine.trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("candidate[") {
                if let candidate = parseCandidateLine(line) {
                    candidates.append(candidate)
                }
                continue
            }
            guard let separator = line.firstIndex(of: "=") else {
                continue
            }
            let key = String(line[..<separator])
            let value = String(line[line.index(after: separator)...])
            fields[key] = value
        }
        guard let sync = fields["sync"],
              let phase = fields["phase"],
              let front = fields["wechat_front"],
              let cli = fields["cli"],
              let batchText = fields["batch_messages"],
              let batchMessages = Int(batchText) else {
            return nil
        }
        return FrontSyncStatusReport(
            syncEnabled: sync == "enabled",
            phase: phase,
            wechatInFront: front == "yes",
            cliAvailable: cli == "ok",
            failureCode: fields["failure"],
            bindingDisplay: fields["binding_display"],
            decision: fields["decision"],
            batchMessages: batchMessages,
            candidates: candidates
        )
    }

    // 候选行形如：candidate[1] username=wxid display=合成 甲 last_active=123。
    // display 可能包含空格与表情符号，因此按固定标记切分而不是按空格拆词。
    private static func parseCandidateLine(_ line: String) -> FrontSyncCandidate? {
        guard let usernameMarker = line.range(of: "username="),
              let displayMarker = line.range(of: " display="),
              let tailMarker = line.range(of: " last_active="),
              usernameMarker.upperBound <= displayMarker.lowerBound,
              displayMarker.upperBound <= tailMarker.lowerBound else {
            return nil
        }
        let username = String(line[usernameMarker.upperBound..<displayMarker.lowerBound])
        let displayName = String(line[displayMarker.upperBound..<tailMarker.lowerBound])
        guard !username.isEmpty else {
            return nil
        }
        return FrontSyncCandidate(username: username, displayName: displayName)
    }
}
