import XCTest
@testable import NotAloneSyncCore

final class SessionCaptureSafetyTests: XCTestCase {
    func testSingleFrameCapabilityRequiresJSONSession() throws {
        XCTAssertEqual(try SessionInvocation.parse(
            arguments: ["--session", "--json", "--minimal-region", "--single-frame"])?.json, true)
        for arguments in [["--single-frame"], ["--session", "--single-frame"],
                          ["--session", "--json", "--single-frame", "--watch"],
                          ["--session", "--json", "--single-frame", "--single-frame"]] {
            XCTAssertThrowsError(try SessionInvocation.parse(arguments: arguments))
        }
    }

    func testDefaultAndMinimalSessionShareUnavailablePolicy() throws {
        for arguments in [["--session", "--json"], ["--session", "--json", "--minimal-region"],
                          ["--minimal-region", "--json", "--session"]] {
            XCTAssertEqual(try SessionInvocation.parse(arguments: arguments)?.json, true)
            XCTAssertEqual(SessionCaptureSafety.failureCode, "minimal_region_layout_unverified")
        }
    }

    func testLegacyTextSessionUsesSamePolicy() throws {
        for arguments in [["--session"], ["--session", "--show-text"]] {
            XCTAssertEqual(try SessionInvocation.parse(arguments: arguments)?.json, false)
            XCTAssertEqual(SessionCaptureSafety.failureCode, "minimal_region_layout_unverified")
        }
    }

    func testSessionRejectsInvalidOrMixedArguments() {
        for arguments in [["--minimal-region"], ["--session", "--minimal-region"],
                          ["--session", "--json", "--unknown"], ["--session", "--session"],
                          ["--session", "--json", "--json"], ["--session", "--watch"],
                          ["--session", "--self-test"], ["--session", "--crop", "0,0,1,1"],
                          ["--session", "--interval", "1"], ["--session", "--json", "--show-text"]] {
            XCTAssertThrowsError(try SessionInvocation.parse(arguments: arguments))
        }
    }

    func testLegacyDiagnosticArgumentsAreNotSessionInvocations() throws {
        XCTAssertNil(try SessionInvocation.parse(arguments: ["--watch"]))
        XCTAssertNil(try SessionInvocation.parse(arguments: ["--self-test"]))
    }
}
