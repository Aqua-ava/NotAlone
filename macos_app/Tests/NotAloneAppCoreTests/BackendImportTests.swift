import Foundation
import XCTest
import NotAloneAppCore

final class BackendImportTests: XCTestCase {
    @MainActor
    func testImportCommitFailureHasSafeChineseDescription() async throws {
        let server = try SyntheticImportServer(
            path: "/api/imports/commit",
            status: 409,
            body: #"{"error":"import_commit_failed"}"#
        )
        defer { server.close() }

        do {
            _ = try await BackendClient(connection: server.connection).importCommit(
                path: "/synthetic/history.jsonl",
                contactId: "synthetic-contact"
            )
            XCTFail("导入提交失败不能返回成功。")
        } catch {
            XCTAssertEqual(error as? BackendClient.BackendError, .importCommitFailed)
            if let backendError = error as? BackendClient.BackendError,
               case .replyRejected = backendError {
                XCTFail("导入提交失败不能归为回复拒绝。")
            }
            XCTAssertEqual(
                error.localizedDescription,
                "聊天资料导入失败，请核对文件和联系人后重试。"
            )
        }
    }

    @MainActor
    func testUnknownImportConflictRemainsBadStatus() async throws {
        let server = try SyntheticImportServer(
            path: "/api/imports/commit",
            status: 409,
            body: #"{"error":"synthetic_unknown_conflict","reason":"synthetic-sensitive-response"}"#
        )
        defer { server.close() }

        do {
            _ = try await BackendClient(connection: server.connection).importCommit(
                path: "/synthetic/history.jsonl",
                contactId: "synthetic-contact"
            )
            XCTFail("未知导入冲突不能返回成功。")
        } catch {
            XCTAssertEqual(error as? BackendClient.BackendError, .badStatus(409))
            XCTAssertFalse(error.localizedDescription.contains("synthetic-sensitive-response"))
        }
    }

    @MainActor
    func testMalformedImportConflictsRemainBadStatus() async throws {
        for body in [
            "synthetic-invalid-json",
            #"{}"#,
            #"{"error":null}"#,
            #"{"error":42}"#,
            #"{"error":"import_commit_failed","reason":{"detail":"synthetic-sensitive-response"}}"#,
        ] {
            let server = try SyntheticImportServer(
                path: "/api/imports/commit", status: 409, body: body
            )
            defer { server.close() }

            do {
                _ = try await BackendClient(connection: server.connection).importCommit(
                    path: "/synthetic/history.jsonl",
                    contactId: "synthetic-contact"
                )
                XCTFail("非法导入冲突不能返回成功。")
            } catch {
                XCTAssertEqual(error as? BackendClient.BackendError, .badStatus(409))
                XCTAssertFalse(error.localizedDescription.contains("synthetic-sensitive-response"))
            }
        }
    }

    @MainActor
    func testImportFailureCodeOnPreviewRemainsBadStatus() async throws {
        let server = try SyntheticImportServer(
            path: "/api/imports/preview",
            status: 409,
            body: #"{"error":"import_commit_failed","reason":"synthetic-sensitive-response"}"#
        )
        defer { server.close() }

        do {
            _ = try await BackendClient(connection: server.connection).importPreview(
                path: "/synthetic/history.jsonl"
            )
            XCTFail("其他端点的冲突不能返回成功。")
        } catch {
            XCTAssertEqual(error as? BackendClient.BackendError, .badStatus(409))
            XCTAssertFalse(error.localizedDescription.contains("synthetic-sensitive-response"))
        }
    }

    @MainActor
    func testImportFailureCodeWithoutConflictRemainsBadStatus() async throws {
        for status in [400, 500] {
            let server = try SyntheticImportServer(
                path: "/api/imports/commit",
                status: status,
                body: #"{"error":"import_commit_failed"}"#
            )
            defer { server.close() }

            do {
                _ = try await BackendClient(connection: server.connection).importCommit(
                    path: "/synthetic/history.jsonl",
                    contactId: "synthetic-contact"
                )
                XCTFail("失败状态不能返回成功。")
            } catch {
                XCTAssertEqual(error as? BackendClient.BackendError, .badStatus(status))
            }
        }
    }

    @MainActor
    func testSuccessfulImportCommitPreservesResult() async throws {
        let server = try SyntheticImportServer(
            path: "/api/imports/commit",
            status: 200,
            body: #"{"imported_count":3,"skipped_duplicates":1,"contact_id":"synthetic-contact"}"#
        )
        defer { server.close() }

        let result = try await BackendClient(connection: server.connection).importCommit(
            path: "/synthetic/history.jsonl",
            contactId: "synthetic-contact"
        )

        XCTAssertEqual(result.importedCount, 3)
        XCTAssertEqual(result.skippedDuplicates, 1)
        XCTAssertEqual(result.contactId, "synthetic-contact")
    }

    @MainActor
    func testReplyGenerationKeepsGenuineRejectionReason() async throws {
        let server = try SyntheticImportServer(
            path: "/api/reply/generate",
            status: 409,
            body: #"{"error":"reply_rejected","reason":"scope_mismatch"}"#
        )
        defer { server.close() }

        do {
            _ = try await BackendClient(connection: server.connection).generateReply(
                contactId: "synthetic-contact",
                idempotencyKey: "synthetic-reply-request",
                replyToMessage: (targetMessageId: "synthetic-message", direction: "表达感谢"),
                rewriteDraft: nil
            )
            XCTFail("真正的回复拒绝不能返回成功。")
        } catch {
            XCTAssertEqual(
                error as? BackendClient.BackendError,
                .replyRejected(reason: "scope_mismatch")
            )
        }
    }
}

// Process 启动与回收保持在同一 actor，避免异步测试线程迁移后等待退出通知挂起。
@MainActor
private final class SyntheticImportServer {
    let process = Process()
    let connection: BackendConnection

    init(path: String, status: Int, body: String) throws {
        let output = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["python3", "-u", "-c", """
        import sys
        from http.server import BaseHTTPRequestHandler, HTTPServer
        expected_path, status, body = sys.argv[1], int(sys.argv[2]), sys.argv[3].encode()
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                if self.path != expected_path or self.headers.get('Authorization') != 'Bearer synthetic-token':
                    self.send_response(404)
                    self.end_headers()
                    return
                self.send_response(status)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            def log_message(self, *args):
                pass
        server = HTTPServer(('127.0.0.1', 0), Handler)
        print('address=127.0.0.1:%d token=synthetic-token' % server.server_port)
        server.serve_forever()
        """, path, String(status), body]
        process.standardOutput = output
        try process.run()
        var handshake = Data()
        while !handshake.contains(10) {
            let byte = output.fileHandleForReading.readData(ofLength: 1)
            guard !byte.isEmpty else { throw BackendClient.BackendError.transport }
            handshake.append(byte)
        }
        guard let parsed = BackendConnection.parseHandshake(String(decoding: handshake, as: UTF8.self)) else {
            process.terminate()
            process.waitUntilExit()
            throw BackendClient.BackendError.malformedResponse
        }
        connection = parsed
    }

    func close() {
        if process.isRunning { process.terminate() }
        process.waitUntilExit()
    }
}
