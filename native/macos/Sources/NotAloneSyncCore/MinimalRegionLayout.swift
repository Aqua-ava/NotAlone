import CoreGraphics
import Darwin
import Foundation

public enum MinimalSessionError: String, Error {
    case layoutUnverified = "minimal_region_layout_unverified"
    case layoutChanged = "minimal_region_layout_changed"
    case permissionMissing = "screen_capture_permission_missing"
    case weChatNotFrontmost = "wechat_not_in_front"
    case qualityUnverified = "quality_unverified"
    case captureFailed = "minimal_region_capture_failed"
}

// profile只保存已选几何与三个细条摘要；任何未知或不完整输入均不能启动采集。
public struct MinimalRegionLayout {
    public let processId: pid_t
    public let windowId: CGWindowID
    public let frame: CGRect
    public let regions: [String: CGRect]
    public let pixelScale: Double?
    public let sentinelDigests: [String: String]
    let selection: [String: Any]
    static let sentinelFields = ["verticalDivider", "headerDivider", "selectedHighlight"]

    public static func decode(_ data: Data, requireVerified: Bool) throws -> MinimalRegionLayout {
        let baseKeys: Set<String> = ["schemaVersion", "state", "wechatVersion", "wechatBuild", "processId", "windowId", "windowFrame", "regions"]
        let keys = requireVerified ? baseKeys.union(["pixelScale", "sentinelDigests"]) : baseKeys
        guard data.count <= 8192, let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(value.keys) == keys, number(value["schemaVersion"]) == 1,
              value["state"] as? String == (requireVerified ? "verified-minimal-layout" : "selected-awaiting-verification"),
              value["wechatVersion"] as? String == "4.0.6", value["wechatBuild"] as? String == "29387",
              let pid = number(value["processId"]), pid > 0, pid <= Double(Int32.max), pid.rounded() == pid,
              let wid = number(value["windowId"]), wid > 0, wid <= Double(UInt32.max), wid.rounded() == wid,
              let frame = rectangle(value["windowFrame"]), frame.width >= 600, frame.height >= 400,
              frame.width <= 10_000, frame.height <= 10_000,
              let proposed = value["regions"] as? [String: Any], Set(proposed.keys) == Set(calibrationFields) else {
            throw MinimalSessionError.layoutUnverified
        }
        var regions: [String: CGRect] = [:]
        let bounds = CGRect(origin: .zero, size: frame.size)
        for field in calibrationFields {
            guard let region = rectangle(proposed[field]),
                  allowedCalibrationRegion(region, field: field, bounds: bounds, regions: regions) else {
                throw MinimalSessionError.layoutUnverified
            }
            regions[field] = region
        }
        // 已核对的微信版本只允许顶部名字、标题细条及左侧名字，不能把正文作为标题。
        guard regions["displayName"]!.maxY <= 62, regions["headerDivider"]!.maxY <= 90,
              regions["selectedRowName"]!.minY >= 64 else { throw MinimalSessionError.layoutUnverified }
        var scale: Double?
        var digests: [String: String] = [:]
        if requireVerified {
            guard let pixels = number(value["pixelScale"]), pixels >= 1, pixels <= 3,
                  let raw = value["sentinelDigests"] as? [String: String],
                  Set(raw.keys) == Set(sentinelFields),
                  raw.values.allSatisfy({ $0.count == 64 && $0.allSatisfy({ "0123456789abcdef".contains($0) }) }) else {
                throw MinimalSessionError.layoutUnverified
            }
            scale = pixels; digests = raw
        }
        return MinimalRegionLayout(processId: pid_t(pid), windowId: CGWindowID(wid), frame: frame,
                                   regions: regions, pixelScale: scale, sentinelDigests: digests, selection: value)
    }

    func verified(scale: Double, digests: [String: String]) throws -> [String: Any] {
        var result = selection
        result["state"] = "verified-minimal-layout"; result["pixelScale"] = scale; result["sentinelDigests"] = digests
        _ = try Self.decode(JSONSerialization.data(withJSONObject: result), requireVerified: true)
        return result
    }

    @MainActor
    func contextMatches() -> Bool {
        guard let current = CalibrationContext.read(requireForeground: true) else { return false }
        return current.processId == processId && current.windowId == windowId && current.frame == frame
    }

    static func readPrivateFile(_ path: String) throws -> Data {
        guard path.hasPrefix("/"), !path.contains("\0") else { throw MinimalSessionError.layoutUnverified }
        let file = Darwin.open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
        guard file >= 0 else { throw MinimalSessionError.layoutUnverified }
        defer { Darwin.close(file) }
        var before = stat()
        guard fstat(file, &before) == 0, before.st_mode & S_IFMT == S_IFREG,
              before.st_uid == getuid(), before.st_mode & 0o777 == 0o600,
              before.st_size > 0, before.st_size <= 8192 else { throw MinimalSessionError.layoutUnverified }
        var bytes = [UInt8](repeating: 0, count: 8193)
        let length = Darwin.read(file, &bytes, bytes.count)
        var after = stat()
        guard length == before.st_size, fstat(file, &after) == 0,
              before.st_ino == after.st_ino, before.st_size == after.st_size,
              before.st_mtimespec.tv_sec == after.st_mtimespec.tv_sec, before.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec,
              before.st_ctimespec.tv_sec == after.st_ctimespec.tv_sec, before.st_ctimespec.tv_nsec == after.st_ctimespec.tv_nsec else {
            throw MinimalSessionError.layoutUnverified
        }
        return Data(bytes.prefix(length))
    }
}

private func rectangle(_ value: Any?) -> CGRect? {
    guard let value = value as? [String: Any], Set(value.keys) == ["x", "y", "width", "height"],
          let x = number(value["x"]), let y = number(value["y"]),
          let width = number(value["width"]), let height = number(value["height"]),
          abs(x) <= 100_000, abs(y) <= 100_000, width > 0, height > 0 else { return nil }
    return CGRect(x: x, y: y, width: width, height: height)
}
