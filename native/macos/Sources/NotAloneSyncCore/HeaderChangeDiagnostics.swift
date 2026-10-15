import Foundation

enum HeaderChangeDiagnosticStage: String, Sendable {
    case run, permission, context
    case initialCapture = "initial_capture"
    case initialLayout = "initial_layout"
    case shareableContent = "shareable_content"
    case window, display
    case sourceRect = "source_rect"
    case streamSetup = "stream_setup"
    case streamStart = "stream_start"
    case streaming
    case streamStop = "stream_stop"
    case finished
}

enum HeaderChangeDiagnosticReason: String, Sendable {
    case begin
    case permissionMissing = "permission_missing"
    case contextUnavailable = "context_unavailable"
    case contextChanged = "context_changed"
    case windowUnavailable = "window_unavailable"
    case displayUnsupported = "display_unsupported"
    case sourceRectInvalid = "source_rect_invalid"
    case firstFrame = "first_frame"
    case outputDimensions = "output_dimensions"
    case pixelFormat = "pixel_format"
    case bufferLock = "buffer_lock"
    case missingBuffer = "missing_buffer"
    case frameLimit = "frame_limit"
    case detectorFailed = "detector_failed"
    case streamError = "stream_error"
    case streamConnectionInvalid = "stream_connection_invalid"
    case streamConnectionInterrupted = "stream_connection_interrupted"
    case streamContextMissing = "stream_context_missing"
    case streamSystemStopped = "stream_system_stopped"
    case streamUserStopped = "stream_user_stopped"
    case streamPermissionDeclined = "stream_permission_declined"
    case streamMissingEntitlements = "stream_missing_entitlements"
    case streamInternal = "stream_internal"
    case streamInvalidParameter = "stream_invalid_parameter"
    case streamStartFailed = "stream_start_failed"
    case operationFailed = "operation_failed"
    case leaseExpired = "lease_expired"
    case stopped
}

enum HeaderChangeContextReason: String, Sendable {
    case instancesAmbiguous = "instances_ambiguous"
    case foregroundUnknown = "foreground_unknown"
    case notWechatForeground = "not_wechat_foreground"
    case versionUnsupported = "version_unsupported"
    case windowListUnavailable = "window_list_unavailable"
    case windowNotVisible = "window_not_visible"
    case windowsAmbiguous = "windows_ambiguous"
    case windowGeometryInvalid = "window_geometry_invalid"
    case contextUnavailable = "context_unavailable"
    case identityMismatch = "identity_mismatch"
}

enum HeaderChangeContextReadFailure: Error, Equatable, Sendable {
    case instancesAmbiguous, foregroundUnknown, notWechatForeground, versionUnsupported
    case windowListUnavailable, windowNotVisible, windowsAmbiguous, windowGeometryInvalid, contextUnavailable

    static func classify(_ failure: CalibrationContextFailure) -> Self {
        switch failure {
        case .instances: return .instancesAmbiguous
        case .foregroundApplicationUnavailable: return .foregroundUnknown
        case .version: return .versionUnsupported
        case .notVisible: return .windowNotVisible
        case .windows: return .windowsAmbiguous
        case .geometry: return .windowGeometryInvalid
        case .unavailable: return .contextUnavailable
        }
    }
}

// 原始身份仅参加内存比较，序列化对象只能由固定投影构造。
struct HeaderChangeContextDiagnosis: Sendable {
    let reason: HeaderChangeContextReason
    let matches: String

    private init(reason: HeaderChangeContextReason, matches: String) {
        self.reason = reason; self.matches = matches
    }

    static func unreadable(_ failure: HeaderChangeContextReadFailure) -> Self {
        let reason: HeaderChangeContextReason
        switch failure {
        case .instancesAmbiguous: reason = .instancesAmbiguous
        case .foregroundUnknown: reason = .foregroundUnknown
        case .notWechatForeground: reason = .notWechatForeground
        case .versionUnsupported: reason = .versionUnsupported
        case .windowListUnavailable: reason = .windowListUnavailable
        case .windowNotVisible: reason = .windowNotVisible
        case .windowsAmbiguous: reason = .windowsAmbiguous
        case .windowGeometryInvalid: reason = .windowGeometryInvalid
        case .contextUnavailable: reason = .contextUnavailable
        }
        return Self(reason: reason, matches: "------")
    }

    static func comparing(_ expected: CalibrationContext, to current: CalibrationContext) -> Self? {
        let matches = [expected.processId == current.processId, expected.windowId == current.windowId,
            expected.frame.origin == current.frame.origin, expected.frame.size == current.frame.size,
            expected.version == current.version, expected.build == current.build]
        guard !matches.allSatisfy({ $0 }) else { return nil }
        return Self(reason: .identityMismatch, matches: matches.map { $0 ? "1" : "0" }.joined())
    }
}

// 只接受固定枚举和单调时间；不接收原始错误、几何、像素或名称。
struct HeaderChangeDiagnostics: Sendable {
    private let enabled: Bool
    private let beganAt: TimeInterval
    private var remaining = 32

    init(environment: [String: String], beganAt: TimeInterval) {
        enabled = environment["NOTALONE_HEADER_CHANGE_DIAGNOSTICS"] == "1"
        self.beganAt = beganAt
    }

    // 对照本机SCError.h和Apple公开错误码；不转发域、数值或原始错误描述。
    static func streamFailure(isScreenCaptureKit: Bool, code: Int) -> HeaderChangeDiagnosticReason {
        guard isScreenCaptureKit else { return .streamError }
        switch code {
        case -3801: return .streamPermissionDeclined
        case -3802: return .streamStartFailed
        case -3803: return .streamMissingEntitlements
        case -3804: return .streamConnectionInvalid
        case -3805: return .streamConnectionInterrupted
        case -3806: return .streamContextMissing
        case -3811: return .streamInternal
        case -3812: return .streamInvalidParameter
        case -3817: return .streamUserStopped
        case -3821: return .streamSystemStopped
        default: return .streamError
        }
    }

    mutating func line(stage: HeaderChangeDiagnosticStage, reason: HeaderChangeDiagnosticReason,
                       at now: TimeInterval) -> String? {
        emit(prefix: "notalone-header-change-v1", body: "\(stage.rawValue) \(reason.rawValue)", at: now)
    }

    mutating func contextLine(_ diagnosis: HeaderChangeContextDiagnosis, at now: TimeInterval) -> String? {
        emit(prefix: "notalone-header-context-v1", body: "\(diagnosis.reason.rawValue) \(diagnosis.matches)", at: now)
    }

    private mutating func emit(prefix: String, body: String, at now: TimeInterval) -> String? {
        guard enabled, remaining > 0, beganAt.isFinite, beganAt >= 0,
              now.isFinite, now >= beganAt else { return nil }
        let elapsed = (now - beganAt) * 1000
        guard elapsed.isFinite else { return nil }
        let output = "\(prefix) \(body) \(elapsed)\n"
        guard output.utf8.count <= 120 else { return nil }
        remaining -= 1
        return output
    }
}
