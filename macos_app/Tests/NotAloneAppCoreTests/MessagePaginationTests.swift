import Foundation
import XCTest
import NotAloneAppCore

final class MessagePaginationTests: XCTestCase {
    func testFirstPageKeepsHistoryLazyAndUsesServerOrderWithoutDuplicates() throws {
        var pagination = MessagePagination()
        pagination.reset(contactId: "contact-a")
        let request = try XCTUnwrap(pagination.begin(.firstPage))
        XCTAssertEqual(request.limit, 50)
        XCTAssertNil(request.before)
        XCTAssertNil(pagination.begin(.history))

        _ = pagination.complete(request, page: try page(["third", "first", "third", "second"], next: "older"))

        XCTAssertEqual(pagination.messages.map(\.messageId), ["third", "first", "second"])
        let history = try XCTUnwrap(pagination.begin(.history))
        XCTAssertEqual(history.before, "older")
    }

    func testHistoryExtendsTheDisplayedTailAndAdvancesOnlyItsOwnCursor() throws {
        var pagination = MessagePagination()
        pagination.reset(contactId: "contact-a")
        let first = try XCTUnwrap(pagination.begin(.firstPage))
        _ = pagination.complete(first, page: try page(["new", "middle"], next: "before-middle"))
        let history = try XCTUnwrap(pagination.begin(.history))
        _ = pagination.complete(history, page: try page(["middle", "old", "old", "oldest"], next: "before-oldest"))

        XCTAssertEqual(pagination.messages.map(\.messageId), ["new", "middle", "old", "oldest"])
        XCTAssertEqual(try XCTUnwrap(pagination.begin(.history)).before, "before-oldest")
    }

    func testReconciliationJoinsMoreThanOneNewPageBeforeDisplayingAndKeepsHistoryCursor() throws {
        var pagination = MessagePagination()
        pagination.reset(contactId: "contact-a")
        let first = try XCTUnwrap(pagination.begin(.firstPage))
        _ = pagination.complete(first, page: try page(ids(from: 100, through: 51), next: "before-51"))
        let latest = try XCTUnwrap(pagination.begin(.reconcile))
        let second = try XCTUnwrap(pagination.complete(latest, page: try page(ids(from: 220, through: 171), next: "before-171"))?.nextRequest)
        XCTAssertEqual(pagination.messages.map(\.messageId), ids(from: 100, through: 51))
        XCTAssertEqual(second.before, "before-171")
        let third = try XCTUnwrap(pagination.complete(second, page: try page(ids(from: 170, through: 121), next: "before-121"))?.nextRequest)
        let joined = try XCTUnwrap(pagination.complete(third, page: try page(ids(from: 120, through: 71), next: "before-71")))

        XCTAssertNil(joined.nextRequest)
        XCTAssertEqual(joined.reconciledCount, 120)
        XCTAssertEqual(pagination.messages.map(\.messageId), ids(from: 220, through: 51))
        let history = try XCTUnwrap(pagination.begin(.history))
        XCTAssertEqual(history.before, "before-51")
        _ = pagination.complete(history, page: try page(ids(from: 50, through: 1)))
        XCTAssertEqual(pagination.messages.map(\.messageId), ids(from: 220, through: 1))
    }

    func testReconciliationStopsEachRoundAtTenPagesThenContinuesTheBufferedInterval() throws {
        var pagination = MessagePagination()
        pagination.reset(contactId: "contact-a")
        _ = pagination.complete(try XCTUnwrap(pagination.begin(.firstPage)), page: try page(["anchor"], next: "history-1"))
        var request = try XCTUnwrap(pagination.begin(.reconcile))
        for number in 1...10 {
            let completed = try XCTUnwrap(pagination.complete(request, page: try page(["new-\(number)"], next: "scan-\(number)")))
            if number < 10 {
                request = try XCTUnwrap(completed.nextRequest)
            } else {
                XCTAssertNil(completed.nextRequest)
            }
        }
        XCTAssertEqual(pagination.messages.map(\.messageId), ["anchor"])
        let continued = try XCTUnwrap(pagination.begin(.reconcile))
        XCTAssertEqual(continued.before, "scan-10")
        let joined = try XCTUnwrap(pagination.complete(continued, page: try page(["new-10", "new-11", "anchor"], next: "ignored-history")))
        XCTAssertEqual(joined.reconciledCount, 11)
        XCTAssertEqual(pagination.messages.map(\.messageId), ["new-1", "new-2", "new-3", "new-4", "new-5", "new-6", "new-7", "new-8", "new-9", "new-10", "new-11", "anchor"])
        let history = try XCTUnwrap(pagination.begin(.history))
        XCTAssertEqual(history.before, "history-1")
        _ = pagination.complete(history, page: try page(["older"], next: "history-2"))
        let repeated = try XCTUnwrap(pagination.begin(.reconcile))
        XCTAssertEqual(pagination.complete(repeated, page: try page(["new-1", "new-2"], next: "latest-cursor"))?.reconciledCount, 0)
        XCTAssertEqual(try XCTUnwrap(pagination.begin(.history)).before, "history-2")
    }

    func testFailedReconciliationRetriesTheFailedPageAndPreservesBufferedPagesAndHistory() throws {
        var pagination = MessagePagination()
        pagination.reset(contactId: "contact-a")
        _ = pagination.complete(try XCTUnwrap(pagination.begin(.firstPage)), page: try page(["anchor"], next: "history-1"))
        _ = pagination.complete(try XCTUnwrap(pagination.begin(.history)), page: try page(["older"], next: "history-2"))
        let newest = try XCTUnwrap(pagination.begin(.reconcile))
        let failed = try XCTUnwrap(pagination.complete(newest, page: try page(["newest"], next: "failed-page"))?.nextRequest)
        XCTAssertTrue(pagination.fail(failed, description: "合成网络错误"))
        XCTAssertEqual(pagination.messages.map(\.messageId), ["anchor", "older"])
        let history = try XCTUnwrap(pagination.begin(.history))
        XCTAssertEqual(history.before, "history-2")
        _ = pagination.complete(history, page: try page(["oldest"], next: "history-3"))
        let retry = try XCTUnwrap(pagination.begin(.reconcile))
        XCTAssertEqual(retry.before, "failed-page")
        let joined = try XCTUnwrap(pagination.complete(retry, page: try page(["newest", "new", "anchor"], next: "unrelated-latest")))
        XCTAssertEqual(joined.reconciledCount, 2)
        XCTAssertEqual(pagination.messages.map(\.messageId), ["newest", "new", "anchor", "older", "oldest"])
        XCTAssertEqual(try XCTUnwrap(pagination.begin(.history)).before, "history-3")
    }

    func testTwentyPageBudgetStopsAutomaticReconciliationUntilAnExplicitReload() throws {
        var pagination = MessagePagination()
        pagination.reset(contactId: "contact-a")
        _ = pagination.complete(try XCTUnwrap(pagination.begin(.firstPage)), page: try page(["anchor"], next: "history"))
        for round in 0..<2 {
            var request = try XCTUnwrap(pagination.begin(.reconcile))
            for offset in 1...10 {
                let number = round * 10 + offset
                let result = try XCTUnwrap(pagination.complete(request, page: try page(["new-\(number)"], next: "scan-\(number)")))
                if offset < 10 { request = try XCTUnwrap(result.nextRequest) }
                else { XCTAssertNil(result.nextRequest) }
            }
        }
        XCTAssertEqual(pagination.messages.map(\.messageId), ["anchor"])
        XCTAssertEqual(pagination.state, .failed("消息暂时无法接续，请重新加载。"))
        XCTAssertNil(pagination.begin(.reconcile))
        pagination.reset(contactId: "contact-a")
        _ = pagination.complete(try XCTUnwrap(pagination.begin(.firstPage)), page: try page(["reloaded"], next: "new-history"))
        XCTAssertEqual(pagination.state, .loaded)
        XCTAssertEqual(pagination.messages.map(\.messageId), ["reloaded"])
        XCTAssertEqual(try XCTUnwrap(pagination.begin(.history)).before, "new-history")
    }

    func testMissingAnchorAtEndOrNonAdvancingCursorStopsWithoutPublishingTheGap() throws {
        let cursorSequences: [[String?]] = [[nil], [""], ["same", "same"], ["one", "two", "one"]]
        for cursors in cursorSequences {
            var pagination = MessagePagination()
            pagination.reset(contactId: "contact-a")
            _ = pagination.complete(try XCTUnwrap(pagination.begin(.firstPage)), page: try page(["anchor"], next: "history"))
            var request = try XCTUnwrap(pagination.begin(.reconcile))
            for (index, cursor) in cursors.enumerated() {
                let result = try XCTUnwrap(pagination.complete(request, page: try page(["unjoined-\(index)"], next: cursor)))
                if index < cursors.count - 1 {
                    request = try XCTUnwrap(result.nextRequest)
                } else {
                    XCTAssertNil(result.nextRequest)
                }
            }
            XCTAssertEqual(pagination.state, .failed("消息暂时无法接续，请重新加载。"))
            XCTAssertEqual(pagination.messages.map(\.messageId), ["anchor"])
            XCTAssertNil(pagination.begin(.reconcile))
        }
    }

    func testConnectionInvalidationDiscardsPendingPagesAndLateResultsWithoutLosingHistoryOrNewGate() throws {
        var pagination = MessagePagination()
        pagination.reset(contactId: "contact-a")
        _ = pagination.complete(try XCTUnwrap(pagination.begin(.firstPage)), page: try page(["anchor"], next: "history-1"))
        _ = pagination.complete(try XCTUnwrap(pagination.begin(.history)), page: try page(["older"], next: "history-2"))
        let latest = try XCTUnwrap(pagination.begin(.reconcile))
        let late = try XCTUnwrap(pagination.complete(latest, page: try page(["buffered"], next: "pending"))?.nextRequest)
        XCTAssertNil(pagination.begin(.history))
        pagination.invalidateRequests()
        XCTAssertEqual(pagination.messages.map(\.messageId), ["anchor", "older"])
        let current = try XCTUnwrap(pagination.begin(.reconcile))
        XCTAssertNil(current.before)
        XCTAssertNil(pagination.complete(late, page: try page(["late", "anchor"])))
        XCTAssertFalse(pagination.fail(late, description: "旧错误"))
        XCTAssertNil(pagination.begin(.history))
        _ = pagination.complete(current, page: try page(["current", "anchor"], next: "latest"))
        XCTAssertEqual(pagination.messages.map(\.messageId), ["current", "anchor", "older"])
        XCTAssertEqual(try XCTUnwrap(pagination.begin(.history)).before, "history-2")
    }

    func testContactSwitchReturnAndSourceClearRejectLateResultsAndErrorsUntilFreshFirstPage() throws {
        var pagination = MessagePagination()
        pagination.reset(contactId: "contact-a")
        let oldA = try XCTUnwrap(pagination.begin(.firstPage))
        pagination.reset(contactId: "contact-b")
        let oldB = try XCTUnwrap(pagination.begin(.firstPage))
        pagination.reset(contactId: "contact-a")
        let currentA = try XCTUnwrap(pagination.begin(.firstPage))
        XCTAssertNil(pagination.complete(oldA, page: try page(["old-a"])))
        XCTAssertFalse(pagination.fail(oldB, description: "旧联系人错误"))
        XCTAssertEqual(pagination.state, .loadingFirstPage)
        XCTAssertNil(pagination.begin(.firstPage))
        _ = pagination.complete(currentA, page: try page(["current-a"], next: "history"))
        let latest = try XCTUnwrap(pagination.begin(.reconcile))
        let beforeDeletion = try XCTUnwrap(pagination.complete(latest, page: try page(["pending-delete"], next: "scan"))?.nextRequest)
        pagination.reset(contactId: "contact-a")
        XCTAssertNil(pagination.complete(beforeDeletion, page: try page(["deleted", "current-a"])))
        XCTAssertFalse(pagination.fail(beforeDeletion, description: "旧删除范围错误"))
        XCTAssertTrue(pagination.messages.isEmpty)
        XCTAssertEqual(pagination.state, .idle)
        XCTAssertNil(pagination.begin(.reconcile))
        XCTAssertNil(pagination.begin(.history))
        let afterDeletion = try XCTUnwrap(pagination.begin(.firstPage))
        _ = pagination.complete(afterDeletion, page: try page(["remaining-source"]))
        XCTAssertEqual(pagination.messages.map(\.messageId), ["remaining-source"])
        pagination.invalidateRequests()
        XCTAssertNil(pagination.complete(afterDeletion, page: try page(["late-after-stop"])))
    }

    @MainActor
    func testDelayedSuccessAndFailureCannotChangeNewScopeOrReleaseItsRequestGate() async throws {
        for fails in [false, true] {
            var pagination = MessagePagination()
            pagination.reset(contactId: "contact-a")
            let oldRequest = try XCTUnwrap(pagination.begin(.firstPage))
            let delayed = DelayedPage()
            let oldTask = Task { @MainActor in
                do {
                    let result = try await delayed.read()
                    return pagination.complete(oldRequest, page: result) != nil
                } catch {
                    return pagination.fail(oldRequest, description: "合成旧请求错误")
                }
            }
            await delayed.waitUntilRequested()
            pagination.reset(contactId: "contact-b")
            pagination.reset(contactId: "contact-a")
            let current = try XCTUnwrap(pagination.begin(.firstPage))
            if fails { delayed.release(.failure(SyntheticFailure.delayed)) }
            else { delayed.release(.success(try page(["late"]))) }
            let accepted = await oldTask.value
            XCTAssertFalse(accepted)
            XCTAssertEqual(pagination.state, .loadingFirstPage)
            XCTAssertTrue(pagination.messages.isEmpty)
            XCTAssertNil(pagination.begin(.firstPage))
            _ = pagination.complete(current, page: try page(["current"]))
            XCTAssertEqual(pagination.messages.map(\.messageId), ["current"])
        }
    }

    private func ids(from newest: Int, through oldest: Int) -> [String] {
        stride(from: newest, through: oldest, by: -1).map(String.init)
    }

    private func page(_ ids: [String], next: String? = nil) throws -> MessagePage {
        let messages = ids.map { id in
            ["message_id": id, "speaker": "contact", "message_type": "text", "text": "合成消息"]
        }
        var object: [String: Any] = ["messages": messages]
        if let next { object["next_cursor"] = next }
        let data = try JSONSerialization.data(withJSONObject: object)
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try decoder.decode(MessagePage.self, from: data)
    }
}

private enum SyntheticFailure: Error {
    case delayed
}

@MainActor
private final class DelayedPage {
    private var pending: CheckedContinuation<MessagePage, any Error>?
    private var started: CheckedContinuation<Void, Never>?

    func read() async throws -> MessagePage {
        try await withCheckedThrowingContinuation { continuation in
            pending = continuation
            started?.resume()
            started = nil
        }
    }

    func waitUntilRequested() async {
        guard pending == nil else { return }
        await withCheckedContinuation { started = $0 }
    }

    func release(_ result: Result<MessagePage, any Error>) {
        pending?.resume(with: result)
        pending = nil
    }
}
