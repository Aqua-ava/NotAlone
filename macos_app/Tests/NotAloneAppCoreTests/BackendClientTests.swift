import Foundation
import XCTest
import NotAloneAppCore

final class BackendClientTests: XCTestCase {
    func testDirectInvalidConnectionFailsWithSafeErrorBeforeRequest() async {
        for address in ["[", "127.0.0.1:0", "192.0.2.1:54321", "127.0.0.1:54321/private"] {
            let client = BackendClient(connection: BackendConnection(
                address: address, token: "synthetic-token"
            ))
            await assertSafeConnectionFailure { _ = try await client.setupStatus() }
        }
    }

    func testAllRequestKindsRejectInvalidConnection() async {
        let client = BackendClient(connection: BackendConnection(
            address: "[", token: "synthetic-token"
        ))
        await assertSafeConnectionFailure { _ = try await client.importPreview(path: "synthetic.jsonl") }
        await assertSafeConnectionFailure {
            _ = try await client.confirmPendingBinding(contactId: "synthetic", locator: "synthetic")
        }
        await assertSafeConnectionFailure {
            _ = try await client.generateReply(
                contactId: "synthetic", idempotencyKey: "synthetic",
                replyToMessage: ("synthetic", ""), rewriteDraft: nil
            )
        }
        await assertSafeConnectionFailure { _ = try await client.confirmCliBindings(selections: []) }
        await assertSafeConnectionFailure { _ = try await client.followSmokeStatus() }
        await assertSafeConnectionFailure { try await client.shutdownRuntime(timeout: 0.2) }
    }

    private func assertSafeConnectionFailure(_ operation: () async throws -> Void) async {
        do {
            try await operation()
            XCTFail("非法连接不能发起请求。")
        } catch {
            XCTAssertEqual(error as? BackendClient.BackendError, .transport)
        }
    }
}
