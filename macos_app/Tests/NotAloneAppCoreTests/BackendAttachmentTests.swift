import XCTest
import NotAloneAppCore

final class BackendAttachmentTests: XCTestCase {
    func testRepeatedConnectionInitializesOnceAndDisconnectAllowsRecovery() {
        var attachment = BackendAttachment()
        let reused = BackendConnection(address: "127.0.0.1:54321", token: "synthetic-token")
        var initializationCount = 0

        for _ in 0..<4 {
            if attachment.attach(reused) { initializationCount += 1 }
        }
        XCTAssertEqual(initializationCount, 1)
        XCTAssertEqual(attachment.connection, reused)

        attachment.disconnect()
        XCTAssertNil(attachment.connection)
        XCTAssertEqual(attachment.shutdownConnection, reused)
        if attachment.attach(reused) { initializationCount += 1 }
        XCTAssertEqual(initializationCount, 2)

        let restarted = BackendConnection(address: "127.0.0.1:54322", token: "new-token")
        XCTAssertTrue(attachment.attach(restarted))
        XCTAssertEqual(attachment.connection, restarted)
    }
}
