import Foundation
import XCTest
import NotAloneAppCore

final class BackendRuntimeTests: XCTestCase {
    func testReusedRuntimeStopsWithoutAnOwnedProcess() async throws {
        let server = try SyntheticRuntimeServer()
        defer { server.close() }
        let supervisor = BackendSupervisor()
        XCTAssertFalse(supervisor.isRunning)

        try await supervisor.shutdown(connection: server.connection, timeout: 2)

        let deadline = Date().addingTimeInterval(2)
        while server.process.isRunning && Date() < deadline {
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTAssertFalse(server.process.isRunning)
        XCTAssertFalse(supervisor.isRunning)
    }

    func testShutdownRejectsUnauthenticatedConnectionWithoutStoppingReusedServer() async throws {
        let server = try SyntheticRuntimeServer()
        defer { server.close() }
        let invalid = BackendConnection(address: server.connection.address, token: "wrong-token")
        do {
            try await BackendSupervisor().shutdown(connection: invalid, timeout: 1)
            XCTFail("未认证关闭不能成功。")
        } catch let error as BackendClient.BackendError {
            XCTAssertEqual(error, .badStatus(401))
        }
        XCTAssertTrue(server.process.isRunning)
    }

    func testShutdownTimeoutIsBoundedAndDoesNotClaimReusedRuntimeStopped() async throws {
        let server = try SyntheticRuntimeServer(delay: 3)
        defer { server.close() }
        let started = Date()
        do {
            try await BackendSupervisor().shutdown(connection: server.connection, timeout: 0.2)
            XCTFail("尚未确认停读不能成功。")
        } catch let error as URLError {
            XCTAssertEqual(error.code, .timedOut)
        }
        XCTAssertLessThan(Date().timeIntervalSince(started), 2)
        XCTAssertTrue(server.process.isRunning)
    }

    func testShutdownRejectsNonLoopbackAddress() async throws {
        let connection = BackendConnection(address: "192.0.2.1:54321", token: "synthetic-token")
        do {
            try await BackendClient(connection: connection).shutdownRuntime(timeout: 0.2)
            XCTFail("关闭接口只能操作回环服务。")
        } catch let error as BackendClient.BackendError {
            XCTAssertEqual(error, .transport)
        }
    }
}

private final class SyntheticRuntimeServer {
    let process = Process()
    let connection: BackendConnection

    init(delay: TimeInterval = 0) throws {
        let output = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["python3", "-u", "-c", """
        import json, threading, time
        from http.server import BaseHTTPRequestHandler, HTTPServer
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                if self.path != '/api/runtime/shutdown' or self.headers.get('Authorization') != 'Bearer synthetic-token':
                    self.send_response(401)
                    self.end_headers()
                    return
                time.sleep(\(delay))
                body = json.dumps({'state': 'stopped'}).encode()
                self.send_response(200)
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                try:
                    self.wfile.write(body)
                except BrokenPipeError:
                    pass
                threading.Thread(target=self.server.shutdown).start()
            def log_message(self, *args):
                pass
        server = HTTPServer(('127.0.0.1', 0), Handler)
        print('address=127.0.0.1:%d token=synthetic-token' % server.server_port)
        server.serve_forever()
        server.server_close()
        """]
        process.standardOutput = output
        try process.run()
        var handshake = Data()
        while !handshake.contains(10) {
            let byte = output.fileHandleForReading.readData(ofLength: 1)
            guard !byte.isEmpty else { throw BackendClient.BackendError.transport }
            handshake.append(byte)
        }
        guard let parsed = BackendConnection.parseHandshake(String(decoding: handshake, as: UTF8.self)) else {
            throw BackendClient.BackendError.malformedResponse
        }
        connection = parsed
    }

    func close() {
        if process.isRunning { process.terminate() }
        process.waitUntilExit()
    }
}
