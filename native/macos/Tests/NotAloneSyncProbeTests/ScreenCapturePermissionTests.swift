import Foundation
import XCTest
@testable import NotAloneSyncCore

final class ScreenCapturePermissionTests: XCTestCase {
    func testCheckOnlyReportsPreflightWithoutRequestingAccess() throws {
        for granted in [false, true] {
            var operations: [String] = []
            let result = try XCTUnwrap(ScreenCapturePermissionCommand.run(
                arguments: ["--screen-capture-permission", "--json"],
                preflight: { operations.append("preflight"); return granted },
                request: { operations.append("request"); return true }
            ))

            XCTAssertEqual(result as NSDictionary, ["ok": true, "granted": granted] as NSDictionary)
            XCTAssertEqual(operations, ["preflight"])
        }
    }

    func testExplicitRequestReportsSubsequentPreflightRatherThanRequestReturn() throws {
        for (requestResult, granted) in [(false, true), (true, false)] {
            var operations: [String] = []
            let result = try XCTUnwrap(ScreenCapturePermissionCommand.run(
                arguments: ["--screen-capture-permission", "--json", "--request"],
                preflight: { operations.append("preflight"); return granted },
                request: { operations.append("request"); return requestResult }
            ))

            XCTAssertEqual(result as NSDictionary, ["ok": true, "granted": granted] as NSDictionary)
            XCTAssertEqual(operations, ["request", "preflight"])
        }
    }

    func testInvalidPermissionArgumentsAreRejectedBeforeAnyPermissionAPI() {
        let invalidArguments = [
            ["--screen-capture-permission"],
            ["--request"],
            ["--request", "--json"],
            ["--screen-capture-permission", "--request"],
            ["--json", "--screen-capture-permission"],
            ["--screen-capture-permission", "--request", "--json"],
            ["--screen-capture-permission", "--json", "--json"],
            ["--screen-capture-permission", "--json", "--request", "--request"],
            ["--screen-capture-permission", "--json", "--unknown"],
            ["--screen-capture-permission", "--json", "--session"],
            ["--screen-capture-permission", "--json", "--request", "--single-frame"],
            ["--screen-capture-permission", "--json", "--watch"],
            ["--screen-capture-permission", "--json", "--crop", "0,0,1,1"],
            ["--screen-capture-permission", "--json", "--foreground-status"],
            ["--session", "--json", "--request"]
        ]
        for arguments in invalidArguments {
            var operations: [String] = []
            XCTAssertThrowsError(try ScreenCapturePermissionCommand.run(
                arguments: arguments,
                preflight: { operations.append("preflight"); return false },
                request: { operations.append("request"); return false }
            ), "\(arguments)")
            XCTAssertTrue(operations.isEmpty, "\(arguments)")
        }
    }

    func testSessionAndOtherExistingInvocationsDoNotEnterPermissionCommand() throws {
        for arguments in [["--session", "--json", "--single-frame"],
                          ["--header-change-source", "--json"], ["--foreground-status", "--json"],
                          ["--self-test"], ["--preview-session"], []] {
            var operations: [String] = []
            XCTAssertNil(try ScreenCapturePermissionCommand.run(
                arguments: arguments,
                preflight: { operations.append("preflight"); return false },
                request: { operations.append("request"); return false }
            ))
            XCTAssertTrue(operations.isEmpty)
        }
    }
}
