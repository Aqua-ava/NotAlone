import Foundation
import XCTest
import NotAloneAppCore

final class BackendSupervisorTests: XCTestCase {
    func testLaunchAfterTerminationReceivesNewBackendHandshake() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("notalone-supervisor-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let firstServer = try writeServer(root: root, name: "first", token: "first-token")
        let secondServer = try writeServer(root: root, name: "second", token: "second-token")
        let supervisor = BackendSupervisor()
        defer {
            supervisor.terminate()
            supervisor.waitForExit(timeout: 1)
        }

        let first = try await supervisor.launch(repoRoot: root, serverBin: firstServer)
        XCTAssertEqual(first.token, "first-token")
        supervisor.terminate()
        supervisor.waitForExit(timeout: 1)
        XCTAssertFalse(supervisor.isRunning)

        // 配置向导重启和退出后的轮询恢复都复用同一个 supervisor。
        let second = try await supervisor.launch(repoRoot: root, serverBin: secondServer)

        XCTAssertEqual(second.token, "second-token")
        XCTAssertEqual(supervisor.connection, second)
        XCTAssertTrue(supervisor.isRunning)
        XCTAssertNil(supervisor.lastError)
        XCTAssertNil(supervisor.lastExitCode)
    }

    func testRetriesAfterBackendExitsBeforeHandshake() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("notalone-supervisor-retry-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let failingServer = root.appendingPathComponent("failure.sh")
        try writeExecutable("#!/bin/sh\nexit 7\n", to: failingServer)
        let retryServer = try writeServer(root: root, name: "retry", token: "retry-token")
        let supervisor = BackendSupervisor()
        defer {
            supervisor.terminate()
            supervisor.waitForExit(timeout: 1)
        }

        do {
            _ = try await supervisor.launch(repoRoot: root, serverBin: failingServer)
            XCTFail("未握手就退出的后端不能被标记为已启动。")
        } catch let error as BackendSupervisor.SuperviseError {
            XCTAssertEqual(error, .exited(code: 7))
        }

        let connection = try await supervisor.launch(repoRoot: root, serverBin: retryServer)

        XCTAssertEqual(connection.token, "retry-token")
        XCTAssertTrue(supervisor.isRunning)
        XCTAssertNil(supervisor.lastError)
        XCTAssertNil(supervisor.lastExitCode)
    }

    func testPreviousLaunchTimeoutDoesNotFailNewHandshake() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("notalone-supervisor-timeout-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let firstServer = try writeServer(root: root, name: "first", token: "first-token")
        let delayedServer = try writeServer(
            root: root, name: "delayed", token: "delayed-token", handshakeDelay: 4
        )
        let supervisor = BackendSupervisor()
        defer {
            supervisor.terminate()
            supervisor.waitForExit(timeout: 1)
        }

        _ = try await supervisor.launch(repoRoot: root, serverBin: firstServer)
        // 第一代的 15 秒定时器在第二代仍等待握手时触发。
        try await Task.sleep(for: .seconds(12))
        supervisor.terminate()
        supervisor.waitForExit(timeout: 1)

        let connection = try await supervisor.launch(repoRoot: root, serverBin: delayedServer)

        XCTAssertEqual(connection.token, "delayed-token")
        XCTAssertEqual(supervisor.connection, connection)
        XCTAssertNil(supervisor.lastError)
    }

    private func writeServer(
        root: URL, name: String, token: String, handshakeDelay: Int = 0
    ) throws -> URL {
        let server = root.appendingPathComponent("\(name).sh")
        let delay = handshakeDelay > 0 ? "/bin/sleep \(handshakeDelay)\n" : ""
        let script = "#!/bin/sh\n\(delay)printf 'address=127.0.0.1:54321 token=\(token)\\n'\nexec /bin/sleep 30\n"
        try writeExecutable(script, to: server)
        return server
    }

    private func writeExecutable(_ script: String, to server: URL) throws {
        try Data(script.utf8).write(to: server)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: server.path)
    }
}
