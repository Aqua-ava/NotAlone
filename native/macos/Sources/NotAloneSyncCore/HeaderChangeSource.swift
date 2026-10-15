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

    func run() async -> Bool {
        let began = ProcessInfo.processInfo.systemUptime
        // 全局队列兜底包含权限/布局/系统异步调用挂起；不依赖宿主仍存活或主队列可运行。
        let deadline = DispatchSource.makeTimerSource(queue: .global())
        deadline.schedule(deadline: .now() + 60)
        deadline.setEventHandler { _exit(EXIT_FAILURE) }
        deadline.resume()
        var stream: SCStream?
        let workspace = NSWorkspace.shared.notificationCenter
        let activation = workspace.addObserver(forName: NSWorkspace.didActivateApplicationNotification,
            object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.invalidateIfContextChanged() }
            }
        defer {
            deadline.cancel()
            workspace.removeObserver(activation)
            active = false; detector.reset(); context = nil
            emit("paused")
        }
        do {
            guard CGPreflightScreenCaptureAccess(),
                  let current = CalibrationContext.read(requireForeground: true) else {
                throw HeaderChangeFailure.contextChanged
            }
            context = current
            // 初始整窗帧仅用来复用可拒绝布局定位；辅助源另计一次，绝非正式观察帧。
            let geometry = try await locateHeader(current)
            guard active, CalibrationContext.read(requireForeground: true) == current else {
                throw HeaderChangeFailure.contextChanged
            }
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            guard active, CalibrationContext.read(requireForeground: true) == current,
                  let window = content.windows.first(where: { $0.windowID == current.windowId
                      && $0.owningApplication?.processID == current.processId && $0.frame == current.frame
                      && $0.owningApplication?.bundleIdentifier == "com.tencent.xinWeChat" }),
                  let display = content.displays.first(where: { $0.frame.origin == .zero && $0.frame.contains(current.frame) }) else {
                throw HeaderChangeFailure.unsupportedGeometry
            }
            let sourceRect = try HeaderChangeGeometry.sourceRect(headerPixels: geometry.rectangle,
                scale: geometry.scale, window: current.frame, display: display.frame)
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
            guard active, CalibrationContext.read(requireForeground: true) == current else {
                throw HeaderChangeFailure.contextChanged
            }
            try await capture.startCapture()
            // 给stopCapture留出五秒，正常续租与最终强制退出边界分开。
            while active && ProcessInfo.processInfo.systemUptime - began < 55 {
                try await Task.sleep(for: .milliseconds(100))
                invalidateIfContextChanged()
            }
            let expired = active && ProcessInfo.processInfo.systemUptime - began >= 55
            active = false; detector.reset()
            try await capture.stopCapture()
            return expired
        } catch {
            active = false; detector.reset()
            try? await stream?.stopCapture()
            return false
        }
    }

    private func locateHeader(_ current: CalibrationContext) async throws -> (rectangle: CGRect, scale: CGFloat) {
        // 不让整窗CGImage或布局的整窗亮度数组跨越初始化保存。
        let image = try await AutomaticSessionCapture.captureWindow(current)
        let layout = try AutomaticSessionRegions.headerLayout(image, windowSize: current.frame.size)
        return (layout.rectangle, layout.scale)
    }

    private func invalidateIfContextChanged() {
        guard active, let context else { return }
        if CalibrationContext.read(requireForeground: true) != context { active = false; detector.reset() }
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
        guard frames < 240, let image = sample.imageBuffer,
              (try? HeaderChangeGeometry.validateOutput(width: CVPixelBufferGetWidth(image),
                  height: CVPixelBufferGetHeight(image), expectedWidth: width, expectedHeight: height)) != nil,
              CVPixelBufferGetPixelFormatType(image) == kCVPixelFormatType_32BGRA,
              CVPixelBufferLockBaseAddress(image, .readOnly) == kCVReturnSuccess else {
            active = false; detector.reset(); return
        }
        defer { CVPixelBufferUnlockBaseAddress(image, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddress(image) else { active = false; detector.reset(); return }
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
        } catch { active = false; detector.reset() }
    }

    nonisolated func stream(_ stream: SCStream, didStopWithError error: any Error) {
        Task { @MainActor [weak self] in self?.active = false; self?.detector.reset() }
    }

    private func emit(_ event: String) {
        // 固定枚举JSONL；不输出姓名、坐标、图像、像素摘要或原始错误。
        FileHandle.standardOutput.write(Data("{\"event\":\"\(event)\"}\n".utf8))
    }
}
