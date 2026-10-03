import XCTest
import NotAloneSyncCore

final class BackendStatusPollingTests: XCTestCase {
    func testInitialAndRepeatedTriggersShareOneRequest() throws {
        var polling = BackendStatusPolling()
        polling.connect(.init(address: "127.0.0.1:9001", token: "synthetic-a"))

        _ = try XCTUnwrap(polling.begin())
        XCTAssertNil(polling.begin())
    }

    func testFinishedRequestAllowsNextTrigger() throws {
        var polling = BackendStatusPolling()
        polling.connect(.init(address: "127.0.0.1:9001", token: "synthetic-a"))
        let first = try XCTUnwrap(polling.begin())

        XCTAssertTrue(polling.finish(first))
        let second = try XCTUnwrap(polling.begin())
        XCTAssertNotEqual(first, second)
    }

    func testTokenChangeAllowsNewRequestAndRejectsOldCleanup() throws {
        var polling = BackendStatusPolling()
        polling.connect(.init(address: "127.0.0.1:9001", token: "synthetic-a"))
        let old = try XCTUnwrap(polling.begin())

        polling.connect(.init(address: "127.0.0.1:9001", token: "synthetic-b"))
        _ = try XCTUnwrap(polling.begin())
        XCTAssertFalse(polling.finish(old))
        XCTAssertNil(polling.begin())
    }

    func testSameConnectionKeepsInFlightRequest() throws {
        let connection = BackendStatusPolling.Connection(
            address: "127.0.0.1:9001", token: "synthetic-a"
        )
        var polling = BackendStatusPolling()
        polling.connect(connection)
        let request = try XCTUnwrap(polling.begin())

        polling.connect(connection)
        XCTAssertNil(polling.begin())
        XCTAssertTrue(polling.finish(request))
    }

    @MainActor
    func testLateSuccessAfterConnectionRoundTripCannotReplaceCurrentState() async throws {
        let caller = SyntheticStatusCaller()
        let oldResponse = SuspendedStatusResponse()
        let currentResponse = SuspendedStatusResponse()
        let connectionA = BackendStatusPolling.Connection(
            address: "127.0.0.1:9001", token: "synthetic-a"
        )
        caller.polling.connect(connectionA)
        let oldTask = try XCTUnwrap(caller.start(oldResponse))
        await oldResponse.waitUntilRequested()
        caller.polling.connect(.init(address: "127.0.0.1:9002", token: "synthetic-b"))
        caller.polling.connect(connectionA)
        let currentTask = try XCTUnwrap(caller.start(currentResponse))
        await currentResponse.waitUntilRequested()

        oldResponse.resolve(.success("旧状态"))
        await oldTask.value
        XCTAssertEqual(caller.visibleState, "等待当前状态")
        XCTAssertNil(caller.polling.begin())

        currentResponse.resolve(.success("当前状态"))
        await currentTask.value
        XCTAssertEqual(caller.visibleState, "当前状态")
    }

    func testStopRejectsLateResultsCleanupAndFutureConnections() throws {
        var polling = BackendStatusPolling()
        polling.connect(.init(address: "127.0.0.1:9001", token: "synthetic-a"))
        let request = try XCTUnwrap(polling.begin())

        polling.stop()
        XCTAssertFalse(polling.isCurrent(request))
        XCTAssertFalse(polling.finish(request))
        polling.connect(.init(address: "127.0.0.1:9002", token: "synthetic-b"))
        XCTAssertNil(polling.begin())
    }

    @MainActor
    func testManualResultInvalidatesEarlierPollWithoutClosingConnection() async throws {
        let caller = SyntheticStatusCaller()
        caller.polling.connect(.init(address: "127.0.0.1:9001", token: "synthetic-a"))
        let scope = try XCTUnwrap(caller.polling.currentScope)
        let oldResponse = SuspendedStatusResponse()
        let oldTask = try XCTUnwrap(caller.start(oldResponse))
        await oldResponse.waitUntilRequested()

        XCTAssertTrue(caller.polling.invalidateRequest(in: scope))
        caller.visibleState = "手动检查完成"
        oldResponse.resolve(.success("旧轮询状态"))
        await oldTask.value

        XCTAssertEqual(caller.visibleState, "手动检查完成")
        XCTAssertNotNil(caller.polling.begin())
    }

    @MainActor
    func testSlowSuccessBlocksRepeatedTriggersThenAllowsNextRequest() async throws {
        let caller = SyntheticStatusCaller()
        let connection = BackendStatusPolling.Connection(
            address: "127.0.0.1:9001", token: "synthetic-a"
        )
        caller.polling.connect(connection)
        let response = SuspendedStatusResponse()
        let task = try XCTUnwrap(caller.start(response))
        await response.waitUntilRequested()

        caller.polling.connect(connection)
        XCTAssertNil(caller.start(SuspendedStatusResponse()))
        XCTAssertNil(caller.start(SuspendedStatusResponse()))
        response.resolve(.success("同步已开启"))
        await task.value

        XCTAssertEqual(caller.visibleState, "同步已开启")
        XCTAssertNotNil(caller.polling.begin())
    }

    @MainActor
    func testFailedAsyncRequestAllowsSuccessfulRetry() async throws {
        let caller = SyntheticStatusCaller()
        caller.polling.connect(.init(address: "127.0.0.1:9001", token: "synthetic-a"))
        let failedResponse = SuspendedStatusResponse()
        let failedTask = try XCTUnwrap(caller.start(failedResponse))
        await failedResponse.waitUntilRequested()
        failedResponse.resolve(.failure(SyntheticStatusFailure.failed))
        await failedTask.value
        XCTAssertEqual(caller.visibleState, "后端不可用")

        let retryResponse = SuspendedStatusResponse()
        let retryTask = try XCTUnwrap(caller.start(retryResponse))
        await retryResponse.waitUntilRequested()
        retryResponse.resolve(.success("同步已关闭"))
        await retryTask.value
        XCTAssertEqual(caller.visibleState, "同步已关闭")
    }

    @MainActor
    func testLateErrorAfterConnectionRoundTripCannotReleaseNewRequest() async throws {
        let caller = SyntheticStatusCaller()
        let connectionA = BackendStatusPolling.Connection(
            address: "127.0.0.1:9001", token: "synthetic-a"
        )
        caller.polling.connect(connectionA)
        let oldResponse = SuspendedStatusResponse()
        let oldTask = try XCTUnwrap(caller.start(oldResponse))
        await oldResponse.waitUntilRequested()
        caller.polling.connect(.init(address: "127.0.0.1:9002", token: "synthetic-b"))
        caller.polling.connect(connectionA)
        let currentResponse = SuspendedStatusResponse()
        let currentTask = try XCTUnwrap(caller.start(currentResponse))
        await currentResponse.waitUntilRequested()

        oldResponse.resolve(.failure(SyntheticStatusFailure.failed))
        await oldTask.value
        XCTAssertEqual(caller.visibleState, "等待当前状态")
        XCTAssertNil(caller.polling.begin())

        currentResponse.resolve(.success("当前连接仍可用"))
        await currentTask.value
        XCTAssertEqual(caller.visibleState, "当前连接仍可用")
    }

    @MainActor
    func testMissingHandshakeRejectsLateSuccessAndErrorThenReconnects() async throws {
        let results: [Result<String, any Error>] = [
            .success("旧状态"), .failure(SyntheticStatusFailure.failed),
        ]
        for result in results {
            let caller = SyntheticStatusCaller()
            let connection = BackendStatusPolling.Connection(
                address: "127.0.0.1:9001", token: "synthetic-a"
            )
            caller.polling.connect(connection)
            let response = SuspendedStatusResponse()
            let task = try XCTUnwrap(caller.start(response))
            await response.waitUntilRequested()

            caller.polling.connect(nil)
            caller.visibleState = "握手缺失"
            XCTAssertNil(caller.polling.begin())
            response.resolve(result)
            await task.value
            XCTAssertEqual(caller.visibleState, "握手缺失")

            caller.polling.connect(connection)
            XCTAssertNotNil(caller.polling.begin())
        }
    }

    @MainActor
    func testStoppedCallerIgnoresLateSuccessAndError() async throws {
        let results: [Result<String, any Error>] = [
            .success("旧状态"), .failure(SyntheticStatusFailure.failed),
        ]
        for result in results {
            let caller = SyntheticStatusCaller()
            caller.polling.connect(.init(address: "127.0.0.1:9001", token: "synthetic-a"))
            let response = SuspendedStatusResponse()
            let task = try XCTUnwrap(caller.start(response))
            await response.waitUntilRequested()

            caller.polling.stop()
            response.resolve(result)
            await task.value

            XCTAssertEqual(caller.visibleState, "等待当前状态")
            XCTAssertNil(caller.polling.begin())
        }
    }

    func testOldManualScopeCannotInvalidateChangedOrStoppedConnection() throws {
        var polling = BackendStatusPolling()
        let connectionA = BackendStatusPolling.Connection(
            address: "127.0.0.1:9001", token: "synthetic-a"
        )
        polling.connect(connectionA)
        let oldScope = try XCTUnwrap(polling.currentScope)
        let oldRequest = try XCTUnwrap(polling.begin())

        polling.connect(.init(address: "127.0.0.1:9002", token: "synthetic-a"))
        let requestB = try XCTUnwrap(polling.begin())
        XCTAssertFalse(polling.isCurrent(oldRequest))
        XCTAssertFalse(polling.invalidateRequest(in: oldScope))
        XCTAssertTrue(polling.isCurrent(requestB))

        polling.connect(connectionA)
        let newRequestA = try XCTUnwrap(polling.begin())
        XCTAssertFalse(polling.invalidateRequest(in: oldScope))
        XCTAssertTrue(polling.isCurrent(newRequestA))
        polling.stop()
        XCTAssertFalse(polling.invalidateRequest(in: oldScope))
    }

    @MainActor
    func testManualResultRejectsLateErrorAndKeepsNewPollInFlight() async throws {
        let caller = SyntheticStatusCaller()
        caller.polling.connect(.init(address: "127.0.0.1:9001", token: "synthetic-a"))
        let scope = try XCTUnwrap(caller.polling.currentScope)
        let oldResponse = SuspendedStatusResponse()
        let oldTask = try XCTUnwrap(caller.start(oldResponse))
        await oldResponse.waitUntilRequested()
        XCTAssertTrue(caller.polling.invalidateRequest(in: scope))
        caller.visibleState = "手动关闭完成"
        let newResponse = SuspendedStatusResponse()
        let newTask = try XCTUnwrap(caller.start(newResponse))
        await newResponse.waitUntilRequested()

        oldResponse.resolve(.failure(SyntheticStatusFailure.failed))
        await oldTask.value
        XCTAssertEqual(caller.visibleState, "手动关闭完成")
        XCTAssertNil(caller.polling.begin())

        newResponse.resolve(.success("同步已关闭"))
        await newTask.value
        XCTAssertEqual(caller.visibleState, "同步已关闭")
    }
}

private enum SyntheticStatusFailure: Error {
    case failed
}

// 仅用合成异步响应驱动公开资格 Interface；不访问 App 私有方法或网络。
@MainActor
private final class SyntheticStatusCaller {
    var polling = BackendStatusPolling()
    var visibleState = "等待当前状态"

    func start(_ response: SuspendedStatusResponse) -> Task<Void, Never>? {
        guard let request = polling.begin() else {
            return nil
        }
        return Task {
            defer { polling.finish(request) }
            do {
                let value = try await response.value()
                guard polling.isCurrent(request) else { return }
                visibleState = value
            } catch {
                guard polling.isCurrent(request) else { return }
                visibleState = "后端不可用"
            }
        }
    }
}

@MainActor
private final class SuspendedStatusResponse {
    private var continuation: CheckedContinuation<String, any Error>?
    private var ready: CheckedContinuation<Void, Never>?

    func value() async throws -> String {
        try await withCheckedThrowingContinuation {
            continuation = $0
            ready?.resume()
            ready = nil
        }
    }

    func waitUntilRequested() async {
        guard continuation == nil else { return }
        await withCheckedContinuation { ready = $0 }
    }

    func resolve(_ result: Result<String, any Error>) {
        continuation?.resume(with: result)
        continuation = nil
    }
}
