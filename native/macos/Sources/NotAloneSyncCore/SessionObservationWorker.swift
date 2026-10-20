import Foundation
import Darwin
import CoreFoundation

// 只复用进程及系统 OCR 初始化状态；没有定时采集、旧帧、名称或身份缓存。
@MainActor
public enum SessionObservationWorker {
    static let requestLimit = 4096
    static let responseLimit = 65536

    public static func run() async -> Bool {
        await run(read: { await SessionWorkerPipe.readLine(descriptor: STDIN_FILENO, timeout: 60) },
                  write: { try await SessionWorkerPipe.write($0, descriptor: STDOUT_FILENO) },
                  observe: AutomaticSessionCapture.observe,
                  reportError: { code in FileHandle.standardError.write(Data((code + "\n").utf8)) })
    }

    public nonisolated static func accepts(arguments: [String]) throws -> Bool {
        guard arguments.contains("--session-worker") else { return false }
        guard arguments == ["--session-worker", "--json"] else {
            throw ProbeError.invalidArguments("session_worker_invalid_arguments")
        }
        return true
    }

    static func run(read: @MainActor () async -> SessionWorkerInput,
                    write: @MainActor (Data) async throws -> Void,
                    observe: @MainActor () async -> [String: Any],
                    reportError: @MainActor (String) -> Void = { _ in }) async -> Bool {
        do {
            try await write(encoded(["version": 1, "event": "ready"]))
            while true {
                switch await read() {
                case .end, .idle:
                    return true
                case .failure(let failure):
                    throw failure
                case .line(let data):
                    try await respond(data, write: write, observe: observe)
                }
            }
        } catch let failure as SessionWorkerFailure {
            reportError(failure.rawValue)
        } catch {
            reportError(SessionWorkerFailure.io.rawValue)
        }
        return false
    }

    private static func respond(_ request: Data, write: @MainActor (Data) async throws -> Void,
                                observe: @MainActor () async -> [String: Any]) async throws {
        let identifier = try autoreleasepool { try requestID(request) }
        let result = await observe()
        let response = try autoreleasepool {
            try encoded(["version": 1, "request_id": identifier, "result": result])
        }
        try await write(response)
        // 结果及编码仅属于本轮；进入下次 stdin 等待前释放。
    }

    private static func requestID(_ data: Data) throws -> String {
        guard data.count <= requestLimit, String(data: data, encoding: .utf8) != nil,
              topLevelMembers(data) == 3,
              let object = try? JSONSerialization.jsonObject(with: data),
              let request = object as? [String: Any],
              Set(request.keys) == Set(["version", "request_id", "operation"]),
              let version = request["version"] as? NSNumber,
              CFGetTypeID(version) != CFBooleanGetTypeID(),
              ["i", "q", "s", "l"].contains(String(cString: version.objCType)),
              version.intValue == 1,
              request["operation"] as? String == "observe",
              let identifier = request["request_id"] as? String,
              let uuid = UUID(uuidString: identifier), uuid.uuidString.lowercased() == identifier else {
            throw SessionWorkerFailure.request
        }
        return identifier
    }

    // JSONSerialization 会折叠重复键，另计顶层成员以拒绝重复字段。
    private static func topLevelMembers(_ data: Data) -> Int {
        var depth = 0, members = 0
        var quoted = false, escaped = false
        for byte in data {
            if quoted {
                if escaped { escaped = false }
                else if byte == 0x5C { escaped = true }
                else if byte == 0x22 { quoted = false }
            } else {
                switch byte {
                case 0x22: quoted = true
                case 0x7B, 0x5B: depth += 1
                case 0x7D, 0x5D: depth -= 1
                case 0x3A: if depth == 1 { members += 1 }
                default: break
                }
            }
        }
        return members
    }

    private static func encoded(_ object: [String: Any]) throws -> Data {
        guard JSONSerialization.isValidJSONObject(object),
              var data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
              data.count < responseLimit else { throw SessionWorkerFailure.response }
        data.append(0x0A)
        return data
    }
}

enum SessionWorkerInput: Sendable {
    case line(Data), end, idle, failure(SessionWorkerFailure)
}

enum SessionWorkerFailure: String, Error, Sendable {
    case request = "session_worker_invalid_request"
    case response = "session_worker_invalid_response"
    case io = "session_worker_io_failed"
}

// poll 只阻塞专用等待工作，不占用主 actor；NSWorkspace 等前台状态可在等待期间刷新。
enum SessionWorkerPipe {
    static func readLine(descriptor: Int32, timeout: TimeInterval) async -> SessionWorkerInput {
        await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                continuation.resume(returning: blockingReadLine(descriptor: descriptor, timeout: timeout))
            }
        }
    }

    private static func blockingReadLine(descriptor: Int32, timeout: TimeInterval) -> SessionWorkerInput {
        let deadline = ProcessInfo.processInfo.systemUptime + timeout
        var data = Data()
        while true {
            let remaining = deadline - ProcessInfo.processInfo.systemUptime
            guard remaining > 0 else { return data.isEmpty ? .idle : .failure(.request) }
            var descriptorState = pollfd(fd: descriptor, events: Int16(POLLIN), revents: 0)
            let milliseconds = Int32(min(Double(Int32.max), ceil(remaining * 1000)))
            let ready = Darwin.poll(&descriptorState, 1, milliseconds)
            if ready == 0 { return data.isEmpty ? .idle : .failure(.request) }
            if ready < 0 {
                if errno == EINTR { continue }
                return .failure(.io)
            }
            guard descriptorState.revents & Int16(POLLNVAL) == 0 else { return .failure(.io) }
            var byte: UInt8 = 0
            let count = Darwin.read(descriptor, &byte, 1)
            if count == 0 { return data.isEmpty ? .end : .failure(.request) }
            if count < 0 {
                if errno == EINTR { continue }
                return .failure(.io)
            }
            if byte == 0x0A { return .line(data) }
            guard data.count < 4096 else { return .failure(.request) }
            data.append(byte)
        }
    }

    static func write(_ data: Data, descriptor: Int32) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            DispatchQueue.global(qos: .userInitiated).async {
                do {
                    try data.withUnsafeBytes { buffer in
                        var offset = 0
                        while offset < buffer.count {
                            let count = Darwin.write(descriptor, buffer.baseAddress!.advanced(by: offset), buffer.count - offset)
                            if count < 0, errno == EINTR { continue }
                            guard count > 0 else { throw SessionWorkerFailure.io }
                            offset += count
                        }
                    }
                    continuation.resume()
                } catch {
                    continuation.resume(throwing: SessionWorkerFailure.io)
                }
            }
        }
    }
}
