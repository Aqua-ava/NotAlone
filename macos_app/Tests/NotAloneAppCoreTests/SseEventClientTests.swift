import XCTest
@testable import NotAloneAppCore

private actor SseLineStreamQueue {
    private var streams: [SseEventClient.LineStream]

    init(_ streams: [SseEventClient.LineStream]) {
        self.streams = streams
    }

    func next() -> SseEventClient.LineStream {
        streams.removeFirst()
    }
}

final class SseEventClientTests: XCTestCase {
    func testNormalReconnectEmitsReconciliationEvent() async {
        let first = SseEventClient.LineStream { continuation in
            continuation.finish()
        }
        let second = SseEventClient.LineStream { continuation in
            continuation.finish()
        }
        let queue = SseLineStreamQueue([first, second])
        let reconnected = expectation(description: "重连后发出对账事件")
        let provider: SseEventClient.LineStreamProvider = { _ in
            await queue.next()
        }
        let client = SseEventClient(
            connection: BackendConnection(address: "127.0.0.1:1", token: "test"),
            lineStreamProvider: provider
        ) { event in
            if case .reconnected = event {
                reconnected.fulfill()
            }
        }
        defer { client.stop() }

        client.start()
        await fulfillment(of: [reconnected], timeout: 4.5)
    }
}
