import Foundation
import XCTest
import NotAloneAppCore

final class BackendConnectionTests: XCTestCase {
    func testBackendEnvironmentIncludesUserLocalBinForUserInstalledCli() {
        let basePath = "/usr/bin:/bin"
        let environment = EnvironmentLocator.backendEnvironment(
            base: ["PATH": basePath]
        )
        let userLocalBin = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".local/bin")
            .path

        XCTAssertEqual(
            environment["PATH"],
            "\(userLocalBin):\(basePath)"
        )
    }

    func testParsesServerHandshakeWrittenOnOneLine() {
        let connection = BackendConnection.parseHandshake(
            "address=127.0.0.1:54321 token=test-token\n"
        )

        XCTAssertEqual(
            connection,
            BackendConnection(address: "127.0.0.1:54321", token: "test-token")
        )
    }

    func testSupervisorReceivesServerHandshakeFromStdout() async throws {
        let scriptURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("notalone-handshake-\(UUID().uuidString).sh")
        let script = "#!/bin/sh\nprintf 'address=127.0.0.1:54321 token=test-token\\n'\nsleep 5\n"
        try Data(script.utf8).write(to: scriptURL)
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o755],
            ofItemAtPath: scriptURL.path
        )
        defer { try? FileManager.default.removeItem(at: scriptURL) }

        let supervisor = BackendSupervisor()
        defer {
            supervisor.terminate()
            supervisor.waitForExit(timeout: 1)
        }

        let connection = try await supervisor.launch(
            repoRoot: FileManager.default.temporaryDirectory,
            serverBin: scriptURL
        )

        XCTAssertEqual(
            connection,
            BackendConnection(address: "127.0.0.1:54321", token: "test-token")
        )
    }
}
