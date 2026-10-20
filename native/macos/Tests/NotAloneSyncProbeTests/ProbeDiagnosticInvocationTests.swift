import XCTest
@testable import NotAloneSyncCore

final class ProbeDiagnosticInvocationTests: XCTestCase {
    func testRetiredBodyCaptureArgumentsFailBeforeAnyCapture() {
        for arguments in [["--watch"], ["--crop", "0,0,1,1"], ["--show-text"],
                          ["--interval", "1"], ["--self-test", "--watch"], ["--self-test", "--self-test"]] {
            XCTAssertThrowsError(try ProbeDiagnosticInvocation.parse(arguments: arguments))
        }
    }

    func testDefaultIsHelpAndSelfTestIsExplicit() throws {
        XCTAssertEqual(try ProbeDiagnosticInvocation.parse(arguments: []), .help)
        XCTAssertEqual(try ProbeDiagnosticInvocation.parse(arguments: ["--help"]), .help)
        XCTAssertEqual(try ProbeDiagnosticInvocation.parse(arguments: ["--self-test"]), .selfTest)
    }
}
