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

    func testRejectsMalformedAndNonLoopbackHandshakeAddresses() {
        let invalidAddresses = [
            "[", "192.0.2.1:54321", "localhost:54321",
            "127.0.0.1", "127.0.0.1:0", "127.0.0.1:65536",
            "127.0.0.1:-1", "127.0.0.1:+80", "127.0.0.1:abc",
            "127.0.0.1:54321/private", "127.0.0.1:54321?private=1",
            "127.0.0.1:54321#private", "user@127.0.0.1:54321",
            "127.0.0.1:54321@192.0.2.1:80",
        ]
        for address in invalidAddresses {
            XCTAssertNil(
                BackendConnection.parseHandshake("address=\(address) token=synthetic-token\n"),
                "损坏或非回环的合成地址应被拒绝：\(address)"
            )
        }
    }

    func testReadsValidMultilineHandshakeAndRejectsDamagedFile() throws {
        let file = FileManager.default.temporaryDirectory
            .appendingPathComponent("notalone-synthetic-connection-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: file) }
        for port in [1, 54321, 65535] {
            try Data("address=127.0.0.1:\(port)\ntoken=synthetic-token\npid=42\n".utf8)
                .write(to: file)
            XCTAssertEqual(
                try BackendConnection.read(from: file),
                BackendConnection(address: "127.0.0.1:\(port)", token: "synthetic-token")
            )
        }
        try Data("address=[\ntoken=synthetic-token\n".utf8).write(to: file)
        XCTAssertNil(try BackendConnection.read(from: file))
    }

    func testDefaultInfoPathExpandsTildeToHomeDirectory() {
        // URL(fileURLWithPath:) 不展开 "~"，Finder 启动时 CWD=/ 会把
        // 默认握手路径解析成 "/~/.notalone/backend.info"，导致复用
        // 既有后端的探测与崩溃恢复整体失效。
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let expected = FileManager.default
            .homeDirectoryForCurrentUser
            .appendingPathComponent(".notalone/backend.info")
            .standardizedFileURL

        XCTAssertEqual(BackendConnection.infoPath(), expected)
        XCTAssertEqual(BackendConnection.infoPath().path, "\(home)/.notalone/backend.info")
    }

    func testTildeOverrideInInfoPathEnvironmentIsExpanded() {
        setenv("NOTALONE_BACKEND_INFO", "~/synthetic-backend.info", 1)
        defer { unsetenv("NOTALONE_BACKEND_INFO") }

        let path = BackendConnection.infoPath().path
        let home = FileManager.default.homeDirectoryForCurrentUser.path

        XCTAssertEqual(path, "\(home)/synthetic-backend.info")
    }

    func testConcurrentLaunchesShareOneHandshakeResult() async throws {
        // 向导重启与轮询循环可能并发进入 launch；两次调用必须共享
        // 同一次启动（同一个握手结果、只启动一个进程），而不是互相
        // terminate 并覆盖对方的 continuation 造成永久挂起。
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

        async let first: BackendConnection = supervisor.launch(
            repoRoot: FileManager.default.temporaryDirectory,
            serverBin: scriptURL
        )
        async let second: BackendConnection = supervisor.launch(
            repoRoot: FileManager.default.temporaryDirectory,
            serverBin: scriptURL
        )
        let firstResult = try await first
        let secondResult = try await second
        let expected = BackendConnection(address: "127.0.0.1:54321", token: "test-token")

        XCTAssertEqual(firstResult, expected)
        XCTAssertEqual(secondResult, expected)
    }

    func testLocatesBundledCliFromRepositoryBuildOutput() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("notalone-cli-root-\(UUID().uuidString)")
        let helpers = root
            .appendingPathComponent("macos_app/build/NotAloneApp.app/Contents/Helpers")
        try FileManager.default.createDirectory(
            at: helpers,
            withIntermediateDirectories: true
        )
        let cli = helpers.appendingPathComponent("wechat-cli")
        let library = helpers.appendingPathComponent("libWCDB.dylib")
        try Data("#!/bin/sh\n".utf8).write(to: cli)
        try Data("synthetic dynamic library\n".utf8).write(to: library)
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o755],
            ofItemAtPath: cli.path
        )
        defer { try? FileManager.default.removeItem(at: root) }

        XCTAssertEqual(
            EnvironmentLocator.locateBundledCli(repoRoot: root),
            cli
        )
    }

    func testIgnoresBundledCliWhenItsRuntimeLibraryIsMissing() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("notalone-cli-incomplete-root-\(UUID().uuidString)")
        let helpers = root
            .appendingPathComponent("macos_app/build/NotAloneApp.app/Contents/Helpers")
        try FileManager.default.createDirectory(
            at: helpers,
            withIntermediateDirectories: true
        )
        let cli = helpers.appendingPathComponent("wechat-cli")
        try Data("#!/bin/sh\n".utf8).write(to: cli)
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o755],
            ofItemAtPath: cli.path
        )
        defer { try? FileManager.default.removeItem(at: root) }

        XCTAssertNil(EnvironmentLocator.locateBundledCli(repoRoot: root))
    }

    func testLocatesBundledWechatCliRuntimeLibraryFromRepositoryBuildOutput() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("notalone-cli-runtime-root-\(UUID().uuidString)")
        let helpers = root
            .appendingPathComponent("macos_app/build/NotAloneApp.app/Contents/Helpers")
        try FileManager.default.createDirectory(
            at: helpers,
            withIntermediateDirectories: true
        )
        let cli = helpers.appendingPathComponent("wechat-cli")
        let library = helpers.appendingPathComponent("libWCDB.dylib")
        try Data("#!/bin/sh\n".utf8).write(to: cli)
        try Data("synthetic dynamic library\n".utf8).write(to: library)
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o755],
            ofItemAtPath: cli.path
        )
        defer { try? FileManager.default.removeItem(at: root) }

        XCTAssertEqual(
            EnvironmentLocator.locateBundledWechatCliRuntimeLibrary(repoRoot: root),
            library
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
