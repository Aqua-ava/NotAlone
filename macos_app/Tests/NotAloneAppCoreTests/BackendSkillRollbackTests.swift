import Foundation
import XCTest
import NotAloneAppCore

/// Skill 版本历史与回滚的客户端契约：路径、方法与请求体都要与后端约定一致。
final class BackendSkillRollbackTests: XCTestCase {
    @MainActor
    func testSkillVersionsDecodeHistoryOrder() async throws {
        let skillId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
        let server = try SyntheticSkillServer(routes: [
            "/api/skills/\(skillId)/versions": (
                "GET",
                200,
                """
                {"versions":[
                  {"version_id":"cccccccc-cccc-cccc-cccc-cccccccccccc",
                   "version_number":2,"name":"warm-reply",
                   "description":"温和而明确地回应当前消息",
                   "is_current":true,"enabled":true,
                   "created_at":"2026-10-04T12:00:00+00:00"},
                  {"version_id":"dddddddd-dddd-dddd-dddd-dddddddddddd",
                   "version_number":1,"name":"warm-reply",
                   "description":"温和而明确地回应当前消息",
                   "is_current":false,"enabled":true,
                   "created_at":"2026-10-03T12:00:00+00:00"}
                ]}
                """
            ),
        ])
        defer { server.close() }

        let versions = try await BackendClient(connection: server.connection)
            .skillVersions(skillId: skillId)

        XCTAssertEqual(versions.map(\.versionNumber), [2, 1])
        XCTAssertEqual(versions.map(\.isCurrent), [true, false])
        XCTAssertEqual(versions.first?.id, "cccccccc-cccc-cccc-cccc-cccccccccccc")
    }

    @MainActor
    func testRollbackPostsVersionIdToSkillEndpoint() async throws {
        let skillId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
        let versionId = "dddddddd-dddd-dddd-dddd-dddddddddddd"
        let server = try SyntheticSkillServer(routes: [
            "/api/skills/\(skillId)/rollback": (
                "POST",
                200,
                #"{"skill_id":"\#(skillId)","version_number":1,"status":"active"}"#
            ),
        ])
        defer { server.close() }

        let result = try await BackendClient(connection: server.connection)
            .rollbackSkill(skillId: skillId, versionId: versionId)

        XCTAssertEqual(result.versionNumber, 1)
        XCTAssertEqual(result.status, "active")
        let recorded = try server.recordedRequests()
        XCTAssertEqual(recorded.count, 1)
        XCTAssertEqual(recorded.first?.path, "/api/skills/\(skillId)/rollback")
        XCTAssertEqual(recorded.first?.body["version_id"], versionId)
    }

    @MainActor
    func testRollbackConflictSurfacesAsBadStatus() async throws {
        let skillId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
        let server = try SyntheticSkillServer(routes: [
            "/api/skills/\(skillId)/rollback": (
                "POST",
                409,
                #"{"error":"synthetic_conflict"}"#
            ),
        ])
        defer { server.close() }

        do {
            _ = try await BackendClient(connection: server.connection)
                .rollbackSkill(
                    skillId: skillId,
                    versionId: "dddddddd-dddd-dddd-dddd-dddddddddddd"
                )
            XCTFail("回滚冲突不能返回成功。")
        } catch {
            XCTAssertEqual(error as? BackendClient.BackendError, .badStatus(409))
        }
    }
}

/// 记录请求的合成后端：路由表 + 内存中的请求日志。
private final class SyntheticSkillServer {
    let process = Process()
    let connection: BackendConnection
    private let port: Int

    init(routes: [String: (method: String, status: Int, body: String)]) throws {
        let routesJSON = try JSONSerialization.data(withJSONObject: routes.mapValues {
            ["method": $0.method, "status": $0.status, "body": $0.body]
        })
        let routesText = String(decoding: routesJSON, as: UTF8.self)
        let output = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["python3", "-u", "-c", """
        import json, sys
        from http.server import BaseHTTPRequestHandler, HTTPServer
        routes = json.loads(sys.argv[1])
        requests = []
        class Handler(BaseHTTPRequestHandler):
            def _respond(self):
                if self.path == '/__recorded__':
                    body = json.dumps(requests).encode()
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/json')
                    self.send_header('Content-Length', str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                    return
                length = int(self.headers.get('Content-Length') or 0)
                raw = self.rfile.read(length) if length else b''
                payload = {}
                if raw:
                    try:
                        payload = json.loads(raw)
                    except Exception:
                        payload = {}
                requests.append({'path': self.path, 'method': self.command, 'body': payload})
                route = routes.get(self.path)
                if route is None or route['method'] != self.command:
                    self.send_response(404)
                    self.end_headers()
                    return
                body = route['body'].encode()
                self.send_response(int(route['status']))
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            def do_GET(self):
                self._respond()
            def do_POST(self):
                self._respond()
            def log_message(self, *args):
                pass
        server = HTTPServer(('127.0.0.1', 0), Handler)
        print('address=127.0.0.1:%d token=synthetic-token' % server.server_port)
        server.serve_forever()
        """, routesText]
        process.standardOutput = output
        try process.run()
        var handshake = Data()
        while !handshake.contains(10) {
            let byte = output.fileHandleForReading.readData(ofLength: 1)
            guard !byte.isEmpty else { throw BackendClient.BackendError.transport }
            handshake.append(byte)
        }
        guard let parsed = BackendConnection.parseHandshake(
            String(decoding: handshake, as: UTF8.self)
        ), let port = Int(parsed.address.split(separator: ":").last ?? "") else {
            process.terminate()
            process.waitUntilExit()
            throw BackendClient.BackendError.malformedResponse
        }
        self.connection = parsed
        self.port = port
    }

    struct RecordedRequest: Decodable {
        let path: String
        let method: String
        let body: [String: String]
    }

    func recordedRequests() throws -> [RecordedRequest] {
        let url = URL(string: "http://127.0.0.1:\(port)/__recorded__")!
        let semaphore = DispatchSemaphore(value: 0)
        nonisolated(unsafe) var payload = Data()
        URLSession.shared.dataTask(with: url) { data, _, _ in
            payload = data ?? Data()
            semaphore.signal()
        }.resume()
        _ = semaphore.wait(timeout: .now() + 5)
        return (try? JSONDecoder().decode([RecordedRequest].self, from: payload)) ?? []
    }

    func close() {
        process.terminate()
        process.waitUntilExit()
    }
}
