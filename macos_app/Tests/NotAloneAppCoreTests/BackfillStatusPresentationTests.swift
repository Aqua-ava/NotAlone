import XCTest
import NotAloneAppCore

final class BackfillStatusPresentationTests: XCTestCase {
    func testNonSuccessfulPhasesNeverPresentAsComplete() {
        for phase in ["gap_detected", "backfilling", "paused", "failed", "incomplete"] {
            XCTAssertFalse(BackfillStatusPresentation.isSuccessful(phase))
        }
        XCTAssertTrue(BackfillStatusPresentation.isSuccessful("complete"))
    }

    func testProgressIsBoundedAndUnavailableWithoutWork() {
        XCTAssertEqual(
            BackfillStatusPresentation.progress(completed: 2, total: 4),
            0.5
        )
        XCTAssertEqual(
            BackfillStatusPresentation.progress(completed: 10, total: 4),
            1.0
        )
        XCTAssertNil(BackfillStatusPresentation.progress(completed: 1, total: 0))
    }

    func testRetryAndPauseActionsMatchNonTerminalPhases() {
        XCTAssertTrue(BackfillStatusPresentation.shouldOfferPause("backfilling"))
        XCTAssertFalse(BackfillStatusPresentation.shouldOfferPause("complete"))
        XCTAssertTrue(BackfillStatusPresentation.shouldOfferRetry("paused"))
        XCTAssertTrue(BackfillStatusPresentation.shouldOfferRetry("incomplete"))
        XCTAssertFalse(BackfillStatusPresentation.shouldOfferRetry("complete"))
    }
}
