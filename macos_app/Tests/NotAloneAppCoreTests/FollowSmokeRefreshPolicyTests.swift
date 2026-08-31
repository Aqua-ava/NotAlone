import XCTest
import NotAloneAppCore

final class FollowSmokeRefreshPolicyTests: XCTestCase {
    func testMissingInitialStatusRemainsRetryable() {
        XCTAssertTrue(
            FollowSmokeRefreshPolicy.shouldRefresh(
                hasStatus: false,
                isActive: nil
            )
        )
    }

    func testInactiveStatusDoesNotPollContinuously() {
        XCTAssertFalse(
            FollowSmokeRefreshPolicy.shouldRefresh(
                hasStatus: true,
                isActive: false
            )
        )
    }

    func testActiveStatusContinuesRefreshing() {
        XCTAssertTrue(
            FollowSmokeRefreshPolicy.shouldRefresh(
                hasStatus: true,
                isActive: true
            )
        )
    }
}
