import Foundation
import XCTest
@testable import NotAloneSyncCore

final class SessionObservationWorkerTests: XCTestCase {
    @MainActor
    func testReadyDoesNotObserveAndEachRequestProducesAFreshResult() async throws {
        let ids = ["d4bba738-9f99-4578-9f6d-b16bd6f3367a", "8ec1e8ac-3383-4452-8420-5c32d0daf967"]
        var incoming = ids.map { SessionWorkerInput.line(request($0)) } + [.end]
        var lines: [[String: Any]] = []
        var observations = 0
        let success = await SessionObservationWorker.run(read: { incoming.removeFirst() }, write: { data in
            lines.append(try self.object(data))
            if lines.count == 1 { XCTAssertEqual(observations, 0, "ready 不得采集") }
        }, observe: {
            observations += 1
            return ["ok": true, "display_name": observations == 1 ? "合成甲" : "合成乙"]
        })
        XCTAssertTrue(success)
        XCTAssertEqual(observations, 2)
        XCTAssertEqual(lines.count, 3)
        XCTAssertEqual(Set(lines[0].keys), Set(["version", "event"]))
        XCTAssertEqual(lines[0]["event"] as? String, "ready")
        for index in 0..<2 {
            XCTAssertEqual(lines[index + 1]["request_id"] as? String, ids[index])
            XCTAssertEqual(Set(lines[index + 1].keys), Set(["version", "request_id", "result"]))
        }
        XCTAssertEqual((lines[1]["result"] as? [String: Any])?["display_name"] as? String, "合成甲")
        XCTAssertEqual((lines[2]["result"] as? [String: Any])?["display_name"] as? String, "合成乙")
    }

    @MainActor
    func testInvalidRequestsExitWithoutObservationOrEchoingTheRequest() async {
        let valid = String(decoding: request("d4bba738-9f99-4578-9f6d-b16bd6f3367a"), as: UTF8.self)
        let invalid = [
            "", "[]", "not-json", valid + "{}",
            valid.replacingOccurrences(of: "\"version\":1", with: "\"version\":true"),
            valid.replacingOccurrences(of: "\"version\":1", with: "\"version\":2"),
            valid.replacingOccurrences(of: "\"version\":1", with: "\"version\":1,\"version\":1"),
            valid.replacingOccurrences(of: "observe", with: "watch"),
            valid.replacingOccurrences(of: "d4bba738", with: "D4BBA738"),
            valid.replacingOccurrences(of: "d4bba738-9f99-4578-9f6d-b16bd6f3367a", with: "not-a-uuid"),
            valid.replacingOccurrences(of: "\"operation\":", with: "\"extra\":7,\"operation\":"),
            valid.replacingOccurrences(of: "\"operation\":\"observe\"", with: "\"operation\":{\"name\":\"合成私密\"}"),
            String(repeating: " ", count: 4097) + valid,
        ]
        for value in invalid {
            var reads = 0
            var writes = 0
            var errors: [String] = []
            let success = await SessionObservationWorker.run(read: {
                reads += 1
                return reads == 1 ? .line(Data(value.utf8)) : .end
            }, write: { _ in writes += 1 }, observe: {
                XCTFail("非法请求不得调用观察")
                return [:]
            }, reportError: { errors.append($0) })
            XCTAssertFalse(success, value)
            XCTAssertEqual(writes, 1, "仅 ready 可输出")
            XCTAssertEqual(errors, ["session_worker_invalid_request"])
        }
    }

    func testWorkerInvocationIsAnExactEntryAndCannotMixOtherOperations() throws {
        XCTAssertTrue(try SessionObservationWorker.accepts(arguments: ["--session-worker", "--json"]))
        XCTAssertFalse(try SessionObservationWorker.accepts(arguments: ["--session", "--json"]))
        for arguments in [["--session-worker"], ["--json", "--session-worker"],
                          ["--session-worker", "--json", "--watch"],
                          ["--session-worker", "--json", "--json"],
                          ["--session-worker", "--screen-capture-permission", "--json"]] {
            XCTAssertThrowsError(try SessionObservationWorker.accepts(arguments: arguments))
        }
    }

    @MainActor
    func testPipeWaitYieldsMainActorAndReadsNoMoreThanOneLine() async throws {
        let pipe = Pipe()
        defer { try? pipe.fileHandleForReading.close(); try? pipe.fileHandleForWriting.close() }
        let reader = Task { await SessionWorkerPipe.readLine(descriptor: pipe.fileHandleForReading.fileDescriptor, timeout: 1) }
        await Task.yield()
        try pipe.fileHandleForWriting.write(contentsOf: Data("first\nsecond\n".utf8))
        switch await reader.value {
        case .line(let data): XCTAssertEqual(String(decoding: data, as: UTF8.self), "first")
        default: XCTFail("应取得第一行")
        }
        switch await SessionWorkerPipe.readLine(descriptor: pipe.fileHandleForReading.fileDescriptor, timeout: 1) {
        case .line(let data): XCTAssertEqual(String(decoding: data, as: UTF8.self), "second")
        default: XCTFail("不得提前消费第二行")
        }
    }

    @MainActor
    func testPipeHasBoundedIdleEOFAndRequestSize() async throws {
        let empty = Pipe()
        defer { try? empty.fileHandleForReading.close(); try? empty.fileHandleForWriting.close() }
        switch await SessionWorkerPipe.readLine(descriptor: empty.fileHandleForReading.fileDescriptor, timeout: 0.02) {
        case .idle: break
        default: XCTFail("空闲应有界退出")
        }
        try empty.fileHandleForWriting.write(contentsOf: Data("partial".utf8))
        try empty.fileHandleForWriting.close()
        switch await SessionWorkerPipe.readLine(descriptor: empty.fileHandleForReading.fileDescriptor, timeout: 1) {
        case .failure(.request): break
        default: XCTFail("EOF 不得接受未结束请求")
        }
        switch await SessionWorkerPipe.readLine(descriptor: empty.fileHandleForReading.fileDescriptor, timeout: 1) {
        case .end: break
        default: XCTFail("无待处理行的 EOF 应正常退出")
        }
        let large = Pipe()
        defer { try? large.fileHandleForReading.close(); try? large.fileHandleForWriting.close() }
        try large.fileHandleForWriting.write(contentsOf: Data(repeating: 0x20, count: 4097))
        switch await SessionWorkerPipe.readLine(descriptor: large.fileHandleForReading.fileDescriptor, timeout: 1) {
        case .failure(.request): break
        default: XCTFail("超长请求必须立即拒绝")
        }
    }

    @MainActor
    func testResultIsReleasedBeforeWaitingAndInvalidOutputFailsClosed() async {
        weak var released: NSObject?
        var reads = 0
        var observations = 0
        var errors: [String] = []
        let success = await SessionObservationWorker.run(read: {
            reads += 1
            if reads == 2 { XCTAssertNil(released, "上一轮结果不得保留在 worker 中") }
            return reads == 1 ? .line(self.request("d4bba738-9f99-4578-9f6d-b16bd6f3367a")) : .end
        }, write: { _ in }, observe: {
            observations += 1
            return ["value": String(repeating: "x", count: 65536)]
        }, reportError: { errors.append($0) })
        XCTAssertFalse(success)
        XCTAssertEqual(observations, 1)
        XCTAssertEqual(errors, ["session_worker_invalid_response"])

        reads = 0
        let normal = await SessionObservationWorker.run(read: {
            reads += 1
            if reads == 2 { XCTAssertNil(released) }
            return reads == 1 ? .line(self.request("d4bba738-9f99-4578-9f6d-b16bd6f3367a")) : .end
        }, write: { _ in }, observe: {
            let value = NSMutableString(string: "合成值")
            released = value
            return ["value": value]
        })
        XCTAssertTrue(normal)
        XCTAssertNil(released)
    }

    private func request(_ id: String) -> Data {
        Data("{\"version\":1,\"request_id\":\"\(id)\",\"operation\":\"observe\"}".utf8)
    }

    private func object(_ data: Data) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }
}
