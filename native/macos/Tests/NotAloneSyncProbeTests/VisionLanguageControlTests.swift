import CoreGraphics
import CoreText
import CryptoKit
import Darwin
import Foundation
import Vision
import XCTest
@testable import NotAloneSyncCore

// 此观察场只接受一次专属端侧公开合成计划；普通测试没有激活收据时不运行 Vision。
final class VisionLanguageControlTests: XCTestCase {
    private let root = URL(fileURLWithPath: "/private/tmp/notalone-ocr-vision-language-20261013-df6ab753-1eae-4d1b-a870-304689750ed3")
    private let runId = "df6ab753-1eae-4d1b-a870-304689750ed3"
    private let revision = 3
    private let limit = 72
    private let seconds = 180

    func testFixedPublicSyntheticLanguageControl() throws {
        guard FileManager.default.fileExists(atPath: root.appendingPathComponent("plan.json").path) else {
            throw XCTSkip("finite_control_not_preregistered")
        }
        try privateDirectory(root)
        let planData = try privateData("plan.json")
        let plan = try JSONDecoder().decode(Plan.self, from: planData)
        if FileManager.default.fileExists(atPath: root.appendingPathComponent("completion.json").path) {
            let closed = try JSONDecoder().decode(ClosedReceipt.self, from: privateData("completion.json"))
            let ids = closed.completedCases.map(\.caseId) + closed.unknownCaseIds + closed.unrunCaseIds
            guard plan.runId == runId, closed.runId == runId, closed.closed,
                  ["completed", "stopped"].contains(closed.status), !closed.reason.isEmpty,
                  closed.limit == plan.requestLimit, closed.limit > 0,
                  closed.reservedPerform >= 0, closed.reservedPerform <= closed.limit,
                  closed.elapsedSeconds.isFinite, closed.elapsedSeconds >= 0,
                  closed.completedCases.allSatisfy({ $0.baselineMin.isFinite && $0.candidateMin.isFinite
                    && (0...1).contains($0.baselineMin) && (0...1).contains($0.candidateMin) }),
                  !closed.realCapture, !closed.rawImagesPersisted, !closed.productionPolicyChanged,
                  !closed.causeCertified, Set(ids).count == ids.count, Set(ids) == Set(plan.caseIds),
                  closed.status != "completed" || (closed.reason == "none" && closed.reservedPerform == closed.limit
                    && closed.completedCases.count == plan.caseIds.count) else { throw Failure.storageInvalid }
            throw XCTSkip("finite_control_closed_no_new_perform")
        }
        guard !FileManager.default.fileExists(atPath: root.appendingPathComponent("attempts.jsonl").path) else {
            throw Failure.storageInvalid
        }
        let repository = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        guard plan.runId == runId, plan.requestLimit == limit, plan.sceneSeconds == seconds,
              plan.revision == revision, plan.caseIds == cases.map(\.id),
              plan.baselineAuto == false, plan.candidateAuto == true,
              plan.sourceSHA == sha(try Data(contentsOf: repository.appendingPathComponent(plan.sourcePath))),
              plan.testSHA == sha(try Data(contentsOf: URL(fileURLWithPath: #filePath))) else {
            throw Failure.freezeChanged
        }
        let manifestURL = root.appendingPathComponent("fixture-manifest.json")
        let activationURL = root.appendingPathComponent("activation.json")
        if !FileManager.default.fileExists(atPath: activationURL.path),
           FileManager.default.fileExists(atPath: manifestURL.path) {
            throw XCTSkip("finite_control_prepared_not_activated")
        }
        FileHandle.standardError.write(Data("notalone_synthetic_test_pid:\(getpid())\n".utf8))
        let runtime = try runtimeConfiguration()
        let fixtures = try cases.map(prepare)
        let manifest: [String: Any] = ["run_id": runId, "plan_sha256": sha(planData),
            "runtime": runtime, "cases": fixtures.map(\.metadata), "Vision_perform": 0,
            "raw_images_persisted": false, "real_capture": false]
        let manifestData = try json(manifest)
        guard FileManager.default.fileExists(atPath: activationURL.path) else {
            try exclusive("fixture-manifest.json", manifestData)
            throw XCTSkip("fixture_preparation_only_zero_perform")
        }
        guard try privateData("fixture-manifest.json") == manifestData else { throw Failure.fixtureChanged }
        let activation = try JSONDecoder().decode(Activation.self, from: privateData("activation.json"))
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard activation.runId == runId, activation.planSHA == sha(planData),
              activation.fixtureSHA == sha(manifestData), activation.sourceSHA == plan.sourceSHA,
              activation.testSHA == plan.testSHA, activation.requestLimit == limit,
              activation.sceneSeconds == seconds, let start = parser.date(from: activation.startUTC),
              let end = parser.date(from: activation.endUTC), end.timeIntervalSince(start) == Double(seconds),
              Date() >= start, Date() < end else { throw Failure.activationInvalid }
        let started = ContinuousClock.now
        let remaining = min(Double(seconds), end.timeIntervalSinceNow)
        let log = try Journal(root.appendingPathComponent("attempts.jsonl"), limit: limit,
                              started: started, remaining: remaining)
        var summaries: [[String: Any]] = []
        do {
            for fixture in fixtures {
                var baseline: [Name] = [], candidate: [Name] = []
                for (index, frame) in fixture.frames.enumerated() {
                    for auto in [false, true] {
                        let request = VNRecognizeTextRequest()
                        request.revision = revision
                        try log.reserve(caseId: fixture.control.id, frame: index, auto: auto)
                        let name: Name
                        do { name = try recognize(frame.image, automaticallyDetectsLanguage: auto, request: request) }
                        catch { try log.record(["event": "request_failed", "error": "vision_request_failed"]); throw Failure.visionFailed }
                        try log.checkDeadline()
                        guard request.revision == revision, request.recognitionLevel == .accurate,
                              request.recognitionLanguages == ["zh-Hans", "en-US"],
                              request.usesLanguageCorrection == false,
                              request.automaticallyDetectsLanguage == auto,
                              request.minimumTextHeight == 0, request.customWords.isEmpty else {
                            throw Failure.requestChanged
                        }
                        let observations = request.results ?? []
                        let raw = observations.compactMap { $0.topCandidates(1).first }
                        guard name.confidence.isFinite, (0...1).contains(name.confidence),
                              raw.allSatisfy({ $0.confidence.isFinite && (0...1).contains($0.confidence) }) else {
                            throw Failure.confidenceInvalid
                        }
                        let exact = name.text == frame.expected.first && frame.expected.count == 1
                        try log.record(["event": "returned", "case_id": fixture.control.id,
                            "frame": index, "auto": auto, "observation_count": observations.count,
                            "raw_confidences": raw.map { Double($0.confidence) },
                            "raw_exact": raw.map { frame.expected.contains($0.string) },
                            "name_present": name.text != nil, "name_exact": exact,
                            "gate_input_confidence": name.confidence])
                        guard !raw.contains(where: { $0.confidence >= 0.90 && !frame.expected.contains($0.string) }) else {
                            throw Failure.wrongHighConfidence
                        }
                        if auto {
                            if fixture.control.family != "latin", fixture.control.positive,
                               baseline[index].text == frame.expected.first,
                               !exact || (baseline[index].confidence >= 0.90 && name.confidence < 0.90) {
                                throw Failure.nonLatinRegression
                            }
                            candidate.append(name)
                        } else { baseline.append(name) }
                    }
                }
                let before = gate(baseline), after = gate(candidate)
                if !fixture.control.positive, before.accepted || after.accepted { throw Failure.negativeAccepted }
                if fixture.control.family != "latin", fixture.control.positive,
                   before.accepted && !after.accepted { throw Failure.nonLatinRegression }
                let allBeforeExact = zip(baseline, fixture.frames).allSatisfy { $0.text == $1.expected.first }
                let allAfterExact = zip(candidate, fixture.frames).allSatisfy { $0.text == $1.expected.first }
                summaries.append(["case_id": fixture.control.id, "positive": fixture.control.positive,
                    "family": fixture.control.family, "baseline_exact": allBeforeExact,
                    "candidate_exact": allAfterExact, "baseline_accepted": before.accepted,
                    "candidate_accepted": after.accepted, "baseline_error": before.code,
                    "candidate_error": after.code, "baseline_min": baseline.map(\.confidence).min() ?? 0,
                    "candidate_min": candidate.map(\.confidence).min() ?? 0])
                try log.record(["event": "case_completed", "case_id": fixture.control.id])
            }
            try log.checkDeadline()
            try finish(log, summaries: summaries, status: "completed", reason: "none")
        } catch {
            let reason = (error as? Failure)?.rawValue ?? "storage_or_unknown_failure"
            do { try finish(log, summaries: summaries, status: "stopped", reason: reason) }
            catch { XCTFail("finite_control_receipt_failed") }
            throw error
        }
    }

    private struct Plan: Decodable {
        let runId: String, sourcePath: String, sourceSHA: String, testSHA: String
        let requestLimit: Int, sceneSeconds: Int, revision: Int
        let caseIds: [String], baselineAuto: Bool, candidateAuto: Bool
    }
    private struct Activation: Decodable {
        let runId: String, planSHA: String, fixtureSHA: String, sourceSHA: String, testSHA: String
        let requestLimit: Int, sceneSeconds: Int, startUTC: String, endUTC: String
    }
    private struct CompletedCase: Decodable {
        let caseId: String
        let family: String, positive: Bool, baselineExact: Bool, candidateExact: Bool
        let baselineAccepted: Bool, candidateAccepted: Bool, baselineError: String, candidateError: String
        let baselineMin: Double, candidateMin: Double
        enum CodingKeys: String, CodingKey {
            case caseId = "case_id", family, positive
            case baselineExact = "baseline_exact", candidateExact = "candidate_exact"
            case baselineAccepted = "baseline_accepted", candidateAccepted = "candidate_accepted"
            case baselineError = "baseline_error", candidateError = "candidate_error"
            case baselineMin = "baseline_min", candidateMin = "candidate_min"
        }
    }
    private struct ClosedReceipt: Decodable {
        let runId: String, closed: Bool, status: String, reason: String
        let limit: Int, reservedPerform: Int, elapsedSeconds: Double
        let completedCases: [CompletedCase], unknownCaseIds: [String], unrunCaseIds: [String]
        let realCapture: Bool, rawImagesPersisted: Bool, productionPolicyChanged: Bool, causeCertified: Bool
        enum CodingKeys: String, CodingKey {
            case runId = "run_id", closed, status, reason, limit
            case reservedPerform = "reserved_perform", elapsedSeconds = "elapsed_seconds"
            case completedCases = "completed_cases", unknownCaseIds = "unknown_case_ids", unrunCaseIds = "unrun_case_ids"
            case realCapture = "real_capture", rawImagesPersisted = "raw_images_persisted"
            case productionPolicyChanged = "production_policy_changed", causeCertified = "F_cause_certified"
        }
    }
    private struct Control {
        let id: String, family: String, text: String, row: String?, paint: String
        let positive: Bool
    }
    private var cases: [Control] { [
        Control(id: "L01", family: "latin", text: "Nora", row: nil, paint: "single", positive: true),
        Control(id: "L02", family: "latin", text: "Ray", row: nil, paint: "single", positive: true),
        Control(id: "L03", family: "latin", text: "AB", row: nil, paint: "single", positive: true),
        Control(id: "L04", family: "latin", text: "Q7", row: nil, paint: "single", positive: true),
        Control(id: "C01", family: "chinese", text: "朋友甲", row: nil, paint: "single", positive: true),
        Control(id: "C02", family: "chinese", text: "联系人乙", row: nil, paint: "single", positive: true),
        Control(id: "M01", family: "mixed", text: "甲A1", row: nil, paint: "single", positive: true),
        Control(id: "M02", family: "mixed", text: "A1乙", row: nil, paint: "single", positive: true),
        Control(id: "N01", family: "negative", text: "Nora", row: nil, paint: "blank_header", positive: false),
        Control(id: "N02", family: "negative", text: "Nora", row: "Ray", paint: "single", positive: false),
        Control(id: "N03", family: "negative", text: "Nora", row: nil, paint: "multiline", positive: false),
        Control(id: "N04", family: "negative", text: "A1", row: nil, paint: "left_edge", positive: false)
    ] }
    private struct Frame { let image: CGImage, expected: [String], metadata: [String: Any] }
    private struct Fixture { let control: Control, frames: [Frame], metadata: [String: Any] }

    private func prepare(_ control: Control) throws -> Fixture {
        var frames: [Frame] = []
        for index in 0..<3 {
            let width = index == 1 ? 160 : 180, height = index == 1 ? 40 : 50
            let size: CGFloat = control.paint == "multiline" ? 14 : (index == 1 ? 22 : 24)
            let fontName = control.family == "chinese" || control.family == "mixed" ? "PingFangSC-Regular" : "Helvetica"
            let font = CTFontCreateWithName(fontName as CFString, size, nil)
            guard CTFontCopyPostScriptName(font) as String == fontName,
                  let fontURL = CTFontCopyAttribute(font, kCTFontURLAttribute) as? URL,
                  fontURL.path.hasPrefix("/System/Library/"),
                  let version = CTFontCopyName(font, kCTFontVersionNameKey) as String?,
                  !version.isEmpty else { throw Failure.fontInvalid }
            let fontInfo: [String: Any] = ["postscript": fontName, "size": Double(size),
                "version": version,
                "file_sha256": sha(try Data(contentsOf: fontURL))]
            guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8,
                bytesPerRow: width * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue) else {
                throw Failure.fixtureInvalid
            }
            context.setFillColor(red: 1, green: 1, blue: 1, alpha: 1)
            context.fill(CGRect(x: 0, y: 0, width: width, height: height))
            context.setShouldAntialias(true); context.setFillColor(red: 0, green: 0, blue: 0, alpha: 1)
            let expected = control.paint == "blank_header" && index != 1 ? [] :
                (control.paint == "multiline" ? ["Nora", "Ray"] : [index == 1 ? control.row ?? control.text : control.text])
            for (lineIndex, text) in expected.enumerated() {
                let attributes = [NSAttributedString.Key(kCTFontAttributeName as String): font]
                let line = CTLineCreateWithAttributedString(NSAttributedString(string: text, attributes: attributes))
                let lineWidth = CTLineGetTypographicBounds(line, nil, nil, nil)
                let x = control.paint == "left_edge" ? -2 : floor((Double(width) - lineWidth) / 2)
                let y = expected.count == 2 ? Double(height) - 17 - Double(lineIndex * 17) :
                    (Double(height) - Double(CTFontGetAscent(font) + CTFontGetDescent(font))) / 2 + Double(CTFontGetDescent(font))
                context.textMatrix = .identity; context.textPosition = CGPoint(x: x, y: y)
                CTLineDraw(line, context)
            }
            guard let image = context.makeImage(), let pixels = context.data else { throw Failure.fixtureInvalid }
            let pixelData = Data(bytes: pixels, count: width * height * 4)
            let metadata: [String: Any] = ["ordinal": index, "width": width, "height": height,
                "pixel_sha256": sha(pixelData), "font": fontInfo, "paint": control.paint,
                "expected": expected, "pixel_scale": 2, "raw_image_saved": false]
            frames.append(Frame(image: image, expected: expected, metadata: metadata))
        }
        return Fixture(control: control, frames: frames, metadata: ["case_id": control.id,
            "family": control.family, "positive": control.positive, "frames": frames.map(\.metadata)])
    }

    private func runtimeConfiguration() throws -> [String: Any] {
        let request = VNRecognizeTextRequest()
        let defaults: [String: Any] = ["revision": request.revision,
            "auto": request.automaticallyDetectsLanguage, "minimum_text_height": request.minimumTextHeight,
            "correction": request.usesLanguageCorrection, "languages": request.recognitionLanguages,
            "level": request.recognitionLevel.rawValue]
        guard request.revision == revision, VNRecognizeTextRequest.supportedRevisions.contains(revision),
              request.automaticallyDetectsLanguage == false, request.minimumTextHeight == 0,
              request.customWords.isEmpty else { throw Failure.runtimeUnsupported }
        request.revision = revision; request.recognitionLevel = .accurate
        let supported = try request.supportedRecognitionLanguages()
        guard supported.contains("zh-Hans"), supported.contains("en-US") else { throw Failure.runtimeUnsupported }
        let os = ProcessInfo.processInfo.operatingSystemVersion
        return ["default_request": defaults, "fixed_revision": revision,
            "current_revision": VNRecognizeTextRequest.currentRevision,
            "supported_revisions": Array(VNRecognizeTextRequest.supportedRevisions),
            "supported_languages": supported, "os": [os.majorVersion, os.minorVersion, os.patchVersion]]
    }

    private func gate(_ values: [Name]) -> (accepted: Bool, code: String) {
        do {
            guard values[0].text == values[2].text else { return (false, "session_layout_changed") }
            try Names(header: values[0], row: values[1], repeatedHeader: values[2]).validate()
            return (true, "none")
        } catch { return (false, (error as? MinimalSessionError)?.rawValue ?? "unknown_gate_error") }
    }
    private func finish(_ log: Journal, summaries: [[String: Any]], status: String, reason: String) throws {
        try log.record(["event": "closed", "status": status, "reason": reason])
        try log.close()
        let completed = Set(summaries.compactMap { $0["case_id"] as? String })
        try exclusive("completion.json", try json(["run_id": runId, "closed": true, "status": status,
            "reason": reason, "reserved_perform": log.count, "limit": limit,
            "completed_cases": summaries,
            "unknown_case_ids": cases.map(\.id).filter { log.startedCaseIds.contains($0) && !completed.contains($0) },
            "unrun_case_ids": cases.map(\.id).filter { !log.startedCaseIds.contains($0) },
            "elapsed_seconds": log.elapsed, "real_capture": false, "raw_images_persisted": false,
            "production_policy_changed": false, "F_cause_certified": false,
            "owned_pid": getpid(), "owned_parent_pid": getppid(), "owned_group": getpgrp()]))
    }
    private func privateDirectory(_ url: URL) throws {
        let a = try FileManager.default.attributesOfItem(atPath: url.path)
        guard a[.type] as? FileAttributeType == .typeDirectory,
              a[.posixPermissions] as? Int == 0o700, a[.ownerAccountID] as? Int == Int(getuid()) else { throw Failure.storageInvalid }
    }
    private func privateData(_ name: String) throws -> Data {
        let url = root.appendingPathComponent(name), a = try FileManager.default.attributesOfItem(atPath: url.path)
        guard a[.type] as? FileAttributeType == .typeRegular, a[.posixPermissions] as? Int == 0o600,
              a[.ownerAccountID] as? Int == Int(getuid()) else { throw Failure.storageInvalid }
        return try Data(contentsOf: url)
    }
    private func exclusive(_ name: String, _ data: Data) throws {
        let fd = open(root.appendingPathComponent(name).path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
        guard fd >= 0 else { throw Failure.storageInvalid }
        let file = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        try file.write(contentsOf: data); try file.synchronize(); try file.close()
    }
    private func sha(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    private func json(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) }

    private enum Failure: String, Error {
        case freezeChanged, fixtureChanged, activationInvalid, runtimeUnsupported, fontInvalid, fixtureInvalid
        case storageInvalid, deadline, budgetLimit, visionFailed, confidenceInvalid
        case wrongHighConfidence, negativeAccepted, nonLatinRegression, requestChanged
    }
    private final class Journal {
        let limit: Int, started: ContinuousClock.Instant, remaining: Double
        let file: FileHandle
        private(set) var count = 0
        private(set) var startedCaseIds: Set<String> = []
        var elapsed: Double {
            let c = started.duration(to: .now).components
            return Double(c.seconds) + Double(c.attoseconds) / 1e18
        }
        init(_ url: URL, limit: Int, started: ContinuousClock.Instant, remaining: Double) throws {
            self.limit = limit; self.started = started; self.remaining = remaining
            let fd = open(url.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
            guard fd >= 0 else { throw Failure.storageInvalid }
            file = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        }
        func checkDeadline() throws { guard elapsed < remaining else { throw Failure.deadline } }
        func reserve(caseId: String, frame: Int, auto: Bool) throws {
            try checkDeadline(); guard count < limit else { throw Failure.budgetLimit }
            try record(["event": "reserved", "sequence": count + 1, "case_id": caseId, "frame": frame, "auto": auto])
            count += 1
            startedCaseIds.insert(caseId)
        }
        func record(_ record: [String: Any]) throws {
            var item = record; item["elapsed_seconds"] = elapsed
            var data = try JSONSerialization.data(withJSONObject: item, options: [.sortedKeys]); data.append(10)
            try file.write(contentsOf: data); try file.synchronize()
        }
        func close() throws { try file.synchronize(); try file.close() }
    }
}
