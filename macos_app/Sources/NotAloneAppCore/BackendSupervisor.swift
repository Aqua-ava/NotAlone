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

    private struct State {
        // 并发 launch 的所有等待者共享同一个结果；resolve/超时/退出时
        // 全部 resume，避免后来者把先入者的 continuation 覆盖掉造成
        // 轮询或重启流程永久挂起。
        var continuations: [CheckedContinuation<BackendConnection, Error>] = []
        var readBuffer = Data()
        var connection: BackendConnection?
        var lastError: String?
        var lastExitCode: Int32?
        var run: BackendRun?
    }

    // Foundation Process 每个实例只能启动一次；重启时进程与管道一同换代。
    private final class BackendRun: @unchecked Sendable {
        let process = Process()
        let stdout = Pipe()
        let stderr = Pipe()
    }

    private let state = Mutex(State())
    // 同一时刻只允许一次 launch：向导重启与轮询循环可能并发进入，
    // 后来者直接等待既有的 launch 结果，不终止刚拉起的进程。
    private struct LaunchFlight: Sendable {
        let id: UUID
        let task: Task<BackendConnection, any Error>
    }

    private let launchTask = Mutex<LaunchFlight?>(nil)

    /// 后端进程是否仍在运行。
    public var isRunning: Bool {
        state.withLock { $0.run }?.process.isRunning ?? false
    }

    /// 最近一次成功握手的连接信息。
    public var connection: BackendConnection? {
        state.withLock { $0.connection }
    }

    /// 最近一次失败描述；尚未运行或启动失败时为 nil。
    public var lastError: String? {
        state.withLock { $0.lastError }
    }

    /// 上次退出码；尚未运行或启动失败时为 nil。
    public var lastExitCode: Int32? {
        state.withLock { $0.lastExitCode }
    }

    public init() {} // 显式公开：由主窗口应用持有并监管后端子进程。

    /// 启动后端；等待握手行后返回连接信息。并发调用共享同一次启动。
    public func launch(
        repoRoot: URL,
        serverBin: URL
    ) async throws -> BackendConnection {
        let flight: LaunchFlight = launchTask.withLock { state in
            if let existing = state {
                return existing
            }
            let created = LaunchFlight(
                id: UUID(),
                task: Task {
                    try await self.performLaunch(repoRoot: repoRoot, serverBin: serverBin)
                }
            )
            state = created
            return created
        }
        defer {
            launchTask.withLock { state in
                if state?.id == flight.id {
                    state = nil
                }
            }
        }
        return try await flight.task.value
    }

    private func performLaunch(
        repoRoot: URL,
        serverBin: URL
    ) async throws -> BackendConnection {
        terminate()
        waitForExit(timeout: 5)
        let run = BackendRun()
        let process = run.process
        state.withLock { state in
            state.run = run
            state.connection = nil
            state.lastError = nil
            state.lastExitCode = nil
            state.readBuffer.removeAll(keepingCapacity: true)
        }
        let pipe = run.stdout

        process.executableURL = serverBin
        process.arguments = []
        process.currentDirectoryURL = repoRoot
        var environment = EnvironmentLocator.backendEnvironment()
        // 探针作为后端子进程运行，路径合并进环境；缺失时后端探针不可用。
        let probePath = repoRoot
            .appendingPathComponent("macos_sync_probe/build/cli/notalone-sync-probe")
            .path
        environment["NOTALONE_SYNC_PROBE"] = probePath
        // 使用随 App 构建的稳定副本，避免 Finder 启动时反复从 PATH
        // 拉起 ad-hoc CLI，导致 macOS 将每个新子进程视为新的数据访问者。
        if let cliPath = EnvironmentLocator.locateBundledCli(repoRoot: repoRoot) {
            environment["NOTALONE_WECHAT_CLI"] = cliPath.path
        }
        if environment["WECHAT_CLI_WCDB_LIB"] == nil,
           let libraryPath = EnvironmentLocator.locateBundledWechatCliRuntimeLibrary(
               repoRoot: repoRoot
           ) {
            environment["WECHAT_CLI_WCDB_LIB"] = libraryPath.path
        }
        environment["PYTHONUNBUFFERED"] = "1"
        process.environment = environment
        process.standardOutput = run.stdout
        process.standardError = run.stderr
        process.terminationHandler = { [weak self, weak run] finished in
            guard let run else { return }
            self?.handleTermination(finished, run: run)
        }

        return try await withCheckedThrowingContinuation { continuation in
            // 先登记 continuation，再安装读取回调并启动进程，避免后端
            // 启动很快时回调先解析握手而把连接结果丢掉。
            state.withLock { $0.continuations.append(continuation) }
            // 读 stdout 直到出现 address= 行；15 秒超时失败关闭。
            pipe.fileHandleForReading.readabilityHandler = { [weak self, weak run] handle in
                guard let self, let run else { return }
                let data = handle.availableData
                guard !data.isEmpty else { return }
                let resolved: BackendConnection? = self.state.withLock { state in
                    guard state.run === run else { return nil }
                    state.readBuffer.append(data)
                    guard
                        let text = String(data: state.readBuffer, encoding: .utf8)
                    else {
                        return nil
                    }
                    return BackendConnection.parseHandshake(text)
                }
                if let resolved {
                    handle.readabilityHandler = nil
                    self.resolve(resolved, run: run)
                }
            }
            do {
                try process.run()
            } catch {
                pipe.fileHandleForReading.readabilityHandler = nil
                state.withLock {
                    guard $0.run === run else { return }
                    $0.lastError = "后端进程启动失败：\(error.localizedDescription)"
                }
                self.failPending(with: SuperviseError.launchFailed, run: run)
                return
            }
            DispatchQueue.global().asyncAfter(deadline: .now() + 15) {
                self.timeoutIfStillWaiting(run: run)
            }
        }
    }

    // 退出时收掉后端子进程；未启动时无操作。
    public func terminate() {
        guard let run = state.withLock({ $0.run }) else { return }
        if run.process.isRunning {
            run.process.terminate()
        }
        run.stdout.fileHandleForReading.readabilityHandler = nil
    }

    public func waitForExit(timeout: TimeInterval = 5) {
        guard let process = state.withLock({ $0.run })?.process else { return }
        if !process.isRunning { return }
        let deadline = Date().addingTimeInterval(timeout)
        while process.isRunning && Date() < deadline {
            RunLoop.current.run(until: Date().addingTimeInterval(0.1))
        }
        if process.isRunning {
            process.terminate()
        }
    }

    // MARK: - 握手收尾

    private func resolve(_ connection: BackendConnection, run: BackendRun) {
        let pending = state.withLock { state in
            guard state.run === run else {
                return [CheckedContinuation<BackendConnection, Error>]()
            }
            state.connection = connection
            let pending = state.continuations
            state.continuations = []
            return pending
        }
        pending.forEach { $0.resume(returning: connection) }
    }

    private func timeoutIfStillWaiting(run: BackendRun) {
        let pending = popPending(run: run)
        guard !pending.isEmpty else { return }
        state.withLock {
            guard $0.run === run else { return }
            $0.lastError = "等待后端握手信息超时。"
        }
        pending.forEach { $0.resume(throwing: SuperviseError.handshakeTimedOut) }
    }

    private func failPending(with error: SuperviseError, run: BackendRun) {
        let pending = popPending(run: run)
        pending.forEach { $0.resume(throwing: error) }
    }

    private func popPending(run: BackendRun) -> [CheckedContinuation<BackendConnection, Error>] {
        state.withLock { state in
            guard state.run === run else { return [] }
            let pending = state.continuations
            state.continuations = []
            return pending
        }
    }

    private func handleTermination(_ finished: Process, run: BackendRun) {
        run.stdout.fileHandleForReading.readabilityHandler = nil
        let status = finished.terminationStatus
        let message = String(data: run.stderr.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let pending = state.withLock { state in
            guard state.run === run else {
                return [CheckedContinuation<BackendConnection, Error>]()
            }
            state.connection = nil
            state.lastExitCode = status
            state.lastError = message.isEmpty
                ? "后端进程意外退出（码 \(status)）。"
                : "后端进程意外退出（码 \(status)）：\(message)"
            let pending = state.continuations
            state.continuations = []
            return pending
        }
        pending.forEach { $0.resume(throwing: SuperviseError.exited(code: status)) }
    }
}

// 沿用菜单栏应用的 conda 环境路径探测经验；仓库根以 pyproject.toml 为准。
public enum EnvironmentLocator {
    /// 为后端补齐通过用户级安装器安装的本地 CLI 搜索路径。
    ///
    /// macOS 从 Finder/Launch Services 启动 App 时通常不会继承 shell 的
    /// `~/.local/bin`，但后端默认按 PATH 查找 `wechat-cli`。只扩展子进程
    /// 环境，不修改 App 或用户的全局环境变量。
    public static func backendEnvironment(
        base: [String: String] = ProcessInfo.processInfo.environment
    ) -> [String: String] {
        var environment = base
        let userLocalBin = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".local/bin")
            .path
        let path = environment["PATH"] ?? ""
        let entries = path.split(separator: ":", omittingEmptySubsequences: false)
            .map(String.init)
        guard !entries.contains(userLocalBin) else {
            return environment
        }
        environment["PATH"] = ([userLocalBin] + entries).joined(separator: ":")
        return environment
    }

    /// 查找随 App 构建的 CLI 副本；开发环境没有副本时返回 nil，
    /// 后端继续按 PATH 使用用户自行安装的 CLI。
    public static func locateBundledCli(repoRoot: URL) -> URL? {
        let candidates = [
            Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/wechat-cli"),
            repoRoot.appendingPathComponent(
                "macos_app/build/NotAloneApp.app/Contents/Helpers/wechat-cli"
            ),
        ]
        var seen: Set<String> = []
        for candidate in candidates where seen.insert(candidate.path).inserted {
            let runtimeLibrary = candidate
                .deletingLastPathComponent()
                .appendingPathComponent("libWCDB.dylib")
            if FileManager.default.isExecutableFile(atPath: candidate.path),
               FileManager.default.isReadableFile(atPath: runtimeLibrary.path) {
                return candidate
            }
        }
        return nil
    }

    /// 查找随 App 构建的 wechat-cli 运行时动态库。
    ///
    /// wechat-cli 通过运行时加载 WCDB；仅复制可执行文件会让 App 启动的
    /// CLI 立即退出。路径由后端显式传入，避免依赖 Finder 启动时的工作目录。
    public static func locateBundledWechatCliRuntimeLibrary(repoRoot: URL) -> URL? {
        let candidates = [
            Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/libWCDB.dylib"),
            repoRoot.appendingPathComponent(
                "macos_app/build/NotAloneApp.app/Contents/Helpers/libWCDB.dylib"
            ),
        ]
        var seen: Set<String> = []
        for candidate in candidates where seen.insert(candidate.path).inserted {
            if FileManager.default.isReadableFile(atPath: candidate.path) {
                return candidate
            }
        }
        return nil
    }

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
