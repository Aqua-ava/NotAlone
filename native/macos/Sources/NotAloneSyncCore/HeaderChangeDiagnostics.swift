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
        guard enabled, remaining > 0, beganAt.isFinite, beganAt >= 0,
              now.isFinite, now >= beganAt else { return nil }
        let elapsed = (now - beganAt) * 1000
        guard elapsed.isFinite else { return nil }
        let output = "notalone-header-change-v1 \(stage.rawValue) \(reason.rawValue) \(elapsed)\n"
        guard output.utf8.count <= 120 else { return nil }
        remaining -= 1
        return output
    }
}
