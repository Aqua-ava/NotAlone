import Foundation
import Synchronization

// 主窗口应用负责拉起并监管常驻后端子进程：定位 conda 环境与仓库根目录，
// 启动 notalone-server，解析握手信息，退出时一并收掉子进程。
// 屏幕录制权限只授予本应用（其子进程树中的探针随之继承权限）。
public final class BackendSupervisor: @unchecked Sendable {
    public enum SuperviseError: Error, Equatable {
        case launchFailed
        case handshakeTimedOut
        case exited(code: Int32)
    }

    public private(set) var connection: BackendConnection?
    public private(set) var lastError: String?

    public init() {} // 显式公开：由主窗口应用持有并监管后端子进程。

    private struct State {
        var continuation: CheckedContinuation<BackendConnection, Error>?
    }

    private let state = Mutex(State())
    private let process = Process()
    private let stdout = Pipe()
    private let stderr = Pipe()
    private var readBuffer = Data()

    /// 后端进程是否仍在运行。
    public var isRunning: Bool {
        process.isRunning
    }

    /// 上次退出码；尚未运行或启动失败时为 nil。
    public private(set) var lastExitCode: Int32?

    // 启动后端；等待握手行后返回连接信息。重复启动先收掉旧进程。
    public func launch(repoRoot: URL, serverBin: URL) async throws -> BackendConnection {
        terminate()
        lastExitCode = nil
        let pipe = stdout

        process.executableURL = serverBin
        process.arguments = []
        process.currentDirectoryURL = repoRoot
        var environment = ProcessInfo.processInfo.environment
        // 探针作为后端子进程运行，路径合并进环境；缺失时后端探针不可用。
        let probePath = repoRoot
            .appendingPathComponent("macos_sync_probe/build/cli/notalone-sync-probe")
            .path
        environment["NOTALONE_SYNC_PROBE"] = probePath
        environment["PYTHONUNBUFFERED"] = "1"
        process.environment = environment
        process.standardOutput = stdout
        process.standardError = stderr
        process.terminationHandler = { [weak self] finished in
            self?.handleTermination(finished)
        }

        do {
            try process.run()
        } catch {
            lastError = "后端进程启动失败：\(error.localizedDescription)"
            throw SuperviseError.launchFailed
        }

        // 读 stdout 直到出现 address= 行；15 秒超时失败关闭。
        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            guard let self else { return }
            let data = handle.availableData
            guard !data.isEmpty else { return }
            self.readBuffer.append(data)
            if let connection = self.parseConnection(from: self.readBuffer) {
                handle.readabilityHandler = nil
                self.resolve(connection)
            }
        }
        return try await withCheckedThrowingContinuation { continuation in
            state.withLock { $0.continuation = continuation }
            DispatchQueue.global().asyncAfter(deadline: .now() + 15) {
                self.timeoutIfStillWaiting()
            }
        }
    }

    // 退出时收掉后端子进程；未启动时无操作。
    public func terminate() {
        if process.isRunning {
            process.terminate()
        }
        stdout.fileHandleForReading.readabilityHandler = nil
    }

    public func waitForExit(timeout: TimeInterval = 5) {
        if !process.isRunning { return }
        let deadline = Date().addingTimeInterval(timeout)
        while process.isRunning && Date() < deadline {
            RunLoop.current.run(until: Date().addingTimeInterval(0.1))
        }
        if process.isRunning {
            process.terminate()
        }
    }

    // MARK: - 握手解析

    private func parseConnection(from data: Data) -> BackendConnection? {
        guard let text = String(data: data, encoding: .utf8) else {
            return nil
        }
        var address: String?
        var token: String?
        for line in text.split(separator: "\n") {
            let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.hasPrefix("address=") {
                address = String(trimmed.dropFirst("address=".count))
            } else if trimmed.hasPrefix("token=") {
                token = String(trimmed.dropFirst("token=".count))
            }
        }
        guard let address, let token, !address.isEmpty, !token.isEmpty else {
            return nil
        }
        return BackendConnection(address: address, token: token)
    }

    private func resolve(_ connection: BackendConnection) {
        let pending = state.withLock { state in
            let continuation = state.continuation
            state.continuation = nil
            return continuation
        }
        self.connection = connection
        pending?.resume(returning: connection)
    }

    private func timeoutIfStillWaiting() {
        let pending = state.withLock { state in
            let continuation = state.continuation
            state.continuation = nil
            return continuation
        }
        guard let pending else { return }
        lastError = "等待后端握手信息超时。"
        pending.resume(throwing: SuperviseError.handshakeTimedOut)
    }

    private func handleTermination(_ finished: Process) {
        stdout.fileHandleForReading.readabilityHandler = nil
        let status = finished.terminationStatus
        lastExitCode = status
        let pending = state.withLock { state in
            let continuation = state.continuation
            state.continuation = nil
            return continuation
        }
        lastError = "后端进程意外退出（码 \(status)）。"
        let message = String(data: stderr.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !message.isEmpty {
            lastError = "后端进程意外退出（码 \(status)）：\(message)"
        }
        pending?.resume(throwing: SuperviseError.exited(code: status))
    }
}

// 沿用菜单栏应用的 conda 环境路径探测经验；仓库根以 pyproject.toml 为准。
public enum EnvironmentLocator {
    public static func locateServerBin() -> URL? {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let bases = [
            "\(home)/miniconda3",
            "\(home)/anaconda3",
            "/opt/miniconda3",
            "/opt/anaconda3",
        ]
        for base in bases {
            let path = "\(base)/envs/NotAlone/bin/notalone-server"
            if FileManager.default.isExecutableFile(atPath: path) {
                return URL(fileURLWithPath: path)
            }
        }
        return nil
    }

    public static func locateRepoRoot(anchor: URL) -> URL? {
        var directory = anchor.deletingLastPathComponent()
        for _ in 0..<8 {
            let marker = directory.appendingPathComponent("pyproject.toml")
            if FileManager.default.fileExists(atPath: marker.path) {
                return directory
            }
            directory.deleteLastPathComponent()
        }
        return nil
    }
}