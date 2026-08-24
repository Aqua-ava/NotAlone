import Foundation
import NotAloneAppCore

// 主窗口应用的状态模型：拉起并监管后端子进程、轮询状态与联系人、
// 暴露同步开关操作。所有数据只来自当前 owner 范围的后端 API。
@MainActor
final class AppModel: ObservableObject {
    static let shared = AppModel()

    enum BackendState: Equatable {
        case launching
        case running
        case failed(String)
    }

    @Published private(set) var backendState: BackendState = .launching
    @Published private(set) var contacts: [ContactEntry] = []
    @Published private(set) var status: SyncStatus?
    @Published var lastOperationMessage: String?

    private let supervisor = BackendSupervisor()
    private var client: BackendClient?
    private var pollTask: Task<Void, Never>?
    private var isToggling = false

    private init() {}

    func start() {
        guard pollTask == nil else { return }
        pollTask = Task { [weak self] in
            await self?.runPollLoop()
        }
    }

    func stop() {
        pollTask?.cancel()
        pollTask = nil
        supervisor.terminate()
    }

    // MARK: - 用户操作

    func toggleSync() {
        guard !isToggling, let client else { return }
        isToggling = true
        let targetEnabled = !(status?.syncEnabled ?? false)
        Task {
            defer { isToggling = false }
            do {
                let updated: SyncStatus = targetEnabled
                    ? try await client.enableSync()
                    : try await client.disableSync()
                status = updated
                lastOperationMessage = targetEnabled ? "已开启前台同步" : "已关闭前台同步"
            } catch {
                lastOperationMessage = "开关失败：\(Self.describe(error))"
            }
        }
    }

    func checkNow() {
        Task {
            await refreshStatus()
        }
    }

    // MARK: - 轮询

    private func runPollLoop() async {
        await ensureBackendLaunched()
        while !Task.isCancelled {
            await refreshStatus()
            await refreshContacts()
            if !supervisor.isRunning {
                // 后端进程崩溃或退出后自动重启，保持"监管"语义。
                await ensureBackendLaunched()
            }
            try? await Task.sleep(nanoseconds: 3_000_000_000)
        }
    }

    private func ensureBackendLaunched() async {
        // 未启动或进程已退出时先探测既有后端：已有实例则复用连接，
        // 避免两个后端实例同时驱动同步（ADR-020 单实例约束）。
        if supervisor.isRunning, let connection = supervisor.connection {
            client = BackendClient(connection: connection)
            backendState = .running
            return
        }
        guard let repoRoot = locateRepoRoot() else {
            backendState = .failed("无法定位仓库根目录（pyproject.toml）。")
            return
        }
        if let existing = await probeExistingBackend() {
            client = BackendClient(connection: existing)
            backendState = .running
            return
        }
        guard let serverBin = EnvironmentLocator.locateServerBin() else {
            backendState = .failed("未找到 conda 环境中的 notalone-server。")
            return
        }
        backendState = .launching
        do {
            let connection = try await supervisor.launch(repoRoot: repoRoot, serverBin: serverBin)
            client = BackendClient(connection: connection)
            backendState = .running
        } catch {
            backendState = .failed(supervisor.lastError ?? Self.describe(error))
        }
    }

    // 握手文件指向的后端仍可连接时直接复用；连接失败视为无既有实例。
    private func probeExistingBackend() async -> BackendConnection? {
        let infoPath = BackendConnection.infoPath()
        guard let recorded = try? BackendConnection.read(from: infoPath) else {
            return nil
        }
        let probe = BackendClient(connection: recorded)
        do {
            _ = try await probe.syncStatus()
            return recorded
        } catch {
            // 文件残留但后端已退出：交给 launch 重新拉起并覆盖握手文件。
            return nil
        }
    }

    private func locateRepoRoot() -> URL? {
        var anchor = Bundle.main.bundleURL
        if anchor.lastPathComponent == "MacOS",
           let executable = Bundle.main.executableURL {
            anchor = executable
        }
        return EnvironmentLocator.locateRepoRoot(anchor: anchor)
    }

    private func refreshStatus() async {
        guard let client else { return }
        do {
            status = try await client.syncStatus()
            // 上次失败后状态一恢复就回到 running，允许界面自动重连。
            backendState = .running
        } catch {
            if case .running = backendState {
                backendState = .failed("后端状态读取失败：\(Self.describe(error))")
            } else if case .launching = backendState {
                backendState = .failed("后端状态读取失败：\(Self.describe(error))")
            }
        }
    }

    private func refreshContacts() async {
        guard let client else { return }
        do {
            contacts = try await client.contacts()
        } catch {
            // 联系人列表失败不打断状态展示；下次轮询重试。
        }
    }

    private static func describe(_ error: Error) -> String {
        if let backendError = error as? BackendClient.BackendError {
            switch backendError {
            case .syncUnavailable:
                return "同步不可用（可能尚未初始化微信渠道身份）"
            case .badStatus(let code):
                return "后端返回错误状态 \(code)"
            case .malformedResponse:
                return "后端响应格式异常"
            case .transport:
                return "无法连接后端"
            }
        }
        return error.localizedDescription
    }
}