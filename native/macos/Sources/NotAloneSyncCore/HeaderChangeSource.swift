import AppKit
import CoreMedia
import CoreVideo
import Darwin
@preconcurrency import ScreenCaptureKit

// 与正式单帧观察分离的有限辅助源；没有Vision、AX文字、磁盘或网络接口。
@MainActor
public enum HeaderChangeSource {
    public static func run() async -> Bool {
        let source = HeaderChangeStream()
        return await source.run()
    }
}

@MainActor
private final class HeaderChangeStream: NSObject, @preconcurrency SCStreamOutput, SCStreamDelegate {
    private var context: CalibrationContext?
    private var detector = HeaderChangeDetector()
    private var active = true
    private var frames = 0
    private var width = 0
    private var height = 0
    private var lastFrameAt: TimeInterval = -.infinity
    private var diagnostics: HeaderChangeDiagnostics?
    private var diagnosticStage: HeaderChangeDiagnosticStage = .run
    private var stopReason: HeaderChangeDiagnosticReason?

    func run() async -> Bool {
        let began = ProcessInfo.processInfo.systemUptime
        diagnostics = HeaderChangeDiagnostics(environment: ProcessInfo.processInfo.environment, beganAt: began)
        // 全局队列兜底包含权限/布局/系统异步调用挂起；不依赖宿主仍存活或主队列可运行。
        let deadline = DispatchSource.makeTimerSource(queue: .global())
        deadline.schedule(deadline: .now() + 60)
        deadline.setEventHandler { _exit(EXIT_FAILURE) }
        deadline.resume()
        enter(.run)
        var stream: SCStream?
        let workspace = NSWorkspace.shared.notificationCenter
        let activation = workspace.addObserver(forName: NSWorkspace.didActivateApplicationNotification,
            object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.invalidateIfContextChanged() }
            }
        defer {
            workspace.removeObserver(activation)
            active = false; detector.reset(); context = nil
            record(stage: .finished, reason: stopReason ?? .stopped)
            deadline.cancel()
            emit("paused")
        }
        do {
            enter(.permission)
            guard CGPreflightScreenCaptureAccess() else {
                failure(.permissionMissing)
                throw HeaderChangeFailure.contextChanged
            }
            enter(.context)
            guard let current = readContext() else {
                failure(.contextUnavailable)
                throw HeaderChangeFailure.contextChanged
            }
            context = current
            // 初始整窗帧仅用来复用可拒绝布局定位；辅助源另计一次，绝非正式观察帧。
            let geometry = try await locateHeader(current)
            guard active, readContext(comparedTo: current) == current else {
                failure(.contextChanged)
                throw HeaderChangeFailure.contextChanged
            }
            enter(.shareableContent)
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            guard active, readContext(comparedTo: current) == current else {
                failure(.contextChanged)
                throw HeaderChangeFailure.unsupportedGeometry
            }
            enter(.window)
            guard let window = content.windows.first(where: { $0.windowID == current.windowId
                      && $0.owningApplication?.processID == current.processId && $0.frame == current.frame
                      && $0.owningApplication?.bundleIdentifier == "com.tencent.xinWeChat" }) else {
                failure(.windowUnavailable)
                throw HeaderChangeFailure.unsupportedGeometry
            }
            enter(.display)
            guard let display = content.displays.first(where: { $0.frame.origin == .zero && $0.frame.contains(current.frame) }) else {
                failure(.displayUnsupported)
                throw HeaderChangeFailure.unsupportedGeometry
            }
            enter(.sourceRect)
            let sourceRect = try HeaderChangeGeometry.sourceRect(headerPixels: geometry.rectangle,
                scale: geometry.scale, window: current.frame, display: display.frame)
            enter(.streamSetup)
            // 单窗独立过滤器的sourceRect被Apple文档说明为无效；必须用显示器仅含该窗过滤器。
            let filter = SCContentFilter(display: display, including: [window])
            filter.includeMenuBar = false
            let configuration = SCStreamConfiguration()
            configuration.sourceRect = sourceRect
            width = Int(geometry.rectangle.width); height = Int(geometry.rectangle.height)
            configuration.width = width; configuration.height = height
            configuration.minimumFrameInterval = CMTime(value: 1, timescale: 4)
            configuration.queueDepth = 3
            configuration.pixelFormat = kCVPixelFormatType_32BGRA
            configuration.showsCursor = false; configuration.showMouseClicks = false
            configuration.capturesAudio = false; configuration.captureMicrophone = false
            configuration.includeChildWindows = false
            configuration.preservesAspectRatio = false
            let capture = SCStream(filter: filter, configuration: configuration, delegate: self)
            stream = capture
            try capture.addStreamOutput(self, type: .screen, sampleHandlerQueue: .main)
            guard active, readContext(comparedTo: current) == current else {
                failure(.contextChanged)
                throw HeaderChangeFailure.contextChanged
            }
            enter(.streamStart)
            try await capture.startCapture()
            enter(.streaming)
            // 给stopCapture留出五秒，正常续租与最终强制退出边界分开。
            while active && ProcessInfo.processInfo.systemUptime - began < 55 {
                try await Task.sleep(for: .milliseconds(100))
                invalidateIfContextChanged()
            }
            let expired = active && ProcessInfo.processInfo.systemUptime - began >= 55
            active = false; detector.reset()
            enter(.streamStop)
            try await capture.stopCapture()
            if expired { stopReason = .leaseExpired }
            return expired
        } catch {
            failure(diagnosticStage == .sourceRect ? .sourceRectInvalid : .operationFailed)
            active = false; detector.reset()
            try? await stream?.stopCapture()
            return false
        }
    }

    private func locateHeader(_ current: CalibrationContext) async throws -> (rectangle: CGRect, scale: CGFloat) {
        // 不让整窗CGImage或布局的整窗亮度数组跨越初始化保存。
        enter(.initialCapture)
        let image = try await AutomaticSessionCapture.captureWindow(current)
        enter(.initialLayout)
        let layout = try AutomaticSessionRegions.headerLayout(image, windowSize: current.frame.size)
        return (layout.rectangle, layout.scale)
    }

    private func invalidateIfContextChanged() {
        guard active, let context else { return }
        if readContext(comparedTo: context) != context {
            failure(.contextChanged); active = false; detector.reset()
        }
    }

    private func readContext(comparedTo expected: CalibrationContext? = nil) -> CalibrationContext? {
        let diagnosis: HeaderChangeContextDiagnosis?
        let current: CalibrationContext?
        switch CalibrationContext.readForHeaderChange() {
        case .success(let value):
            current = value
            diagnosis = expected.flatMap { HeaderChangeContextDiagnosis.comparing($0, to: value) }
        case .failure(let failure):
            current = nil; diagnosis = .unreadable(failure)
        }
        if let diagnosis, let line = diagnostics?.contextLine(diagnosis, at: ProcessInfo.processInfo.systemUptime) {
            FileHandle.standardError.write(Data(line.utf8))
        }
        return current
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
                            of type: SCStreamOutputType) {
        // 采集回调显式注册到主队列，先核对前台上下文，后访问局部像素。
        receive(sampleBuffer, type: type)
    }

    private func receive(_ sample: CMSampleBuffer, type: SCStreamOutputType) {
        invalidateIfContextChanged()
        guard active, type == .screen, sample.isValid else { return }
        guard let info = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let status = info.first?[.status] as? Int,
              status == SCFrameStatus.complete.rawValue else { return }
        let now = ProcessInfo.processInfo.systemUptime
        guard now - lastFrameAt >= 0.25 else { return }
        lastFrameAt = now
        // 输出尺寸不匹配即停，不在内存二次裁整屏来掩盖sourceRect无效。
        guard frames < 240 else {
            failure(.frameLimit); active = false; detector.reset(); return
        }
        guard let image = sample.imageBuffer else {
            failure(.missingBuffer); active = false; detector.reset(); return
        }
        guard (try? HeaderChangeGeometry.validateOutput(width: CVPixelBufferGetWidth(image),
            height: CVPixelBufferGetHeight(image), expectedWidth: width, expectedHeight: height)) != nil else {
            failure(.outputDimensions); active = false; detector.reset(); return
        }
        guard CVPixelBufferGetPixelFormatType(image) == kCVPixelFormatType_32BGRA else {
            failure(.pixelFormat); active = false; detector.reset(); return
        }
        guard CVPixelBufferLockBaseAddress(image, .readOnly) == kCVReturnSuccess else {
            failure(.bufferLock)
            active = false; detector.reset(); return
        }
        defer { CVPixelBufferUnlockBaseAddress(image, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddress(image) else {
            failure(.missingBuffer); active = false; detector.reset(); return
        }
        frames += 1
        let stride = CVPixelBufferGetBytesPerRow(image)
        let bytes = base.assumingMemoryBound(to: UInt8.self)
        var pixels = [UInt8](repeating: 0, count: width * height)
        for y in 0..<height { for x in 0..<width {
            let offset = y * stride + x * 4
            pixels[y * width + x] = UInt8((Int(bytes[offset]) + 2 * Int(bytes[offset + 1]) + Int(bytes[offset + 2])) / 4)
        } }
        do {
            if try detector.accept(pixels, width: width, height: height) { emit("changed") }
            if frames == 1 { record(stage: .streaming, reason: .firstFrame) }
        } catch { failure(.detectorFailed); active = false; detector.reset() }
    }

    nonisolated func stream(_ stream: SCStream, didStopWithError error: any Error) {
        let value = error as NSError
        let reason = HeaderChangeDiagnostics.streamFailure(
            isScreenCaptureKit: value.domain == SCStreamErrorDomain, code: value.code)
        Task { @MainActor [weak self] in
            self?.failure(reason); self?.active = false; self?.detector.reset()
        }
    }

    private func enter(_ stage: HeaderChangeDiagnosticStage) {
        diagnosticStage = stage
        record(stage: stage, reason: .begin)
    }

    private func failure(_ reason: HeaderChangeDiagnosticReason) {
        guard stopReason == nil else { return }
        stopReason = reason
        record(stage: diagnosticStage, reason: reason)
    }

    private func record(stage: HeaderChangeDiagnosticStage, reason: HeaderChangeDiagnosticReason) {
        if let line = diagnostics?.line(stage: stage, reason: reason, at: ProcessInfo.processInfo.systemUptime) {
            // 仅显式启用，最多32行、每行120字节；硬截止不依赖诊断I/O。
            FileHandle.standardError.write(Data(line.utf8))
        }
    }

    private func emit(_ event: String) {
        // 固定枚举JSONL；不输出姓名、坐标、图像、像素摘要或原始错误。
        FileHandle.standardOutput.write(Data("{\"event\":\"\(event)\"}\n".utf8))
    }
}
