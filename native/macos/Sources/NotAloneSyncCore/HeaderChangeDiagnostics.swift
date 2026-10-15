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
