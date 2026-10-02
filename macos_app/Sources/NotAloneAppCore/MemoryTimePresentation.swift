import Foundation

/// 独立展示聊天来源、保存时间与有效期；不推断事件发生时间。
public enum MemoryTimePresentation {
    public static func lines(
        timing: MemoryTimingEntry?,
        adoptionMethod: String? = nil,
        validAt: String? = nil,
        invalidAt: String? = nil,
        timeZone: TimeZone = .current
    ) -> [String] {
        var lines = ["来源聊天时间：" + sourceText(timing, timeZone: timeZone)]
        let recordedLabel = adoptionMethod == "manual" ? "录入时间" : "保存时间"
        lines.append(recordedLabel + "：" + formatted(timing?.recordedAt, timeZone: timeZone))
        if let validAt {
            lines.append("生效时间：" + formatted(validAt, timeZone: timeZone))
        }
        if let invalidAt {
            lines.append("失效时间：" + formatted(invalidAt, timeZone: timeZone))
        }
        return lines
    }

    private static func sourceText(_ timing: MemoryTimingEntry?, timeZone: TimeZone) -> String {
        guard let timing,
              let start = parse(timing.sourceStartedAt),
              let end = parse(timing.sourceEndedAt), start <= end else {
            return "未知"
        }
        let startText = format(start, timeZone: timeZone)
        let range = start == end ? startText : startText + " 至 " + format(end, timeZone: timeZone)
        return range + (timing.sourceTimeComplete ? "" : "（部分来源时间未知）")
    }

    private static func formatted(_ raw: String?, timeZone: TimeZone) -> String {
        guard let date = parse(raw) else { return "未知" }
        return format(date, timeZone: timeZone)
    }

    private static func parse(_ raw: String?) -> Date? {
        guard let raw,
              raw.range(of: #"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?(?:Z|[+-][0-9]{2}:[0-9]{2})$"#, options: .regularExpression) != nil else {
            return nil
        }
        let offset = raw.hasSuffix("Z") ? "Z" : String(raw.suffix(6))
        let sourceZone: TimeZone?
        if offset == "Z" {
            sourceZone = TimeZone(secondsFromGMT: 0)
        } else {
            guard let hours = Int(offset.dropFirst().prefix(2)), hours <= 23,
                  let minutes = Int(offset.suffix(2)), minutes <= 59 else { return nil }
            let seconds = (hours * 60 + minutes) * 60
            sourceZone = TimeZone(secondsFromGMT: offset.hasPrefix("-") ? -seconds : seconds)
        }
        guard let sourceZone else { return nil }
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var date = parser.date(from: raw)
        if date == nil {
            parser.formatOptions = [.withInternetDateTime]
            date = parser.date(from: raw)
        }
        guard let date else { return nil }
        // Foundation 会把 2 月 30 日等非法日期归一化；回读必须仍等于原日期。
        let check = DateFormatter()
        check.locale = Locale(identifier: "en_US_POSIX")
        check.calendar = Calendar(identifier: .gregorian)
        check.timeZone = sourceZone
        check.dateFormat = "yyyy-MM-dd'T'HH:mm:ss"
        return check.string(from: date) == String(raw.prefix(19)) ? date : nil
    }

    private static func format(_ date: Date, timeZone: TimeZone) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = timeZone
        formatter.dateFormat = "yyyy-MM-dd HH:mm:ss XXX"
        return formatter.string(from: date)
    }
}
