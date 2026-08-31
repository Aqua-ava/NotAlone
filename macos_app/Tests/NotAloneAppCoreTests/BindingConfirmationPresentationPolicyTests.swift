import XCTest
import NotAloneAppCore

final class BindingConfirmationPresentationPolicyTests: XCTestCase {
    func testBackgroundCandidateDoesNotAutomaticallyPresentAndStealFocus() {
        XCTAssertFalse(
            BindingConfirmationPresentationPolicy.shouldPresent(
                hasCandidates: true,
                appIsActive: false,
                isDismissed: false
            )
        )
        XCTAssertTrue(
            BindingConfirmationPresentationPolicy.shouldPresent(
                hasCandidates: true,
                appIsActive: true,
                isDismissed: false
            )
        )
        XCTAssertFalse(
            BindingConfirmationPresentationPolicy.shouldPresent(
                hasCandidates: true,
                appIsActive: true,
                isDismissed: true
            )
        )
    }
}
