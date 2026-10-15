import XCTest
@testable import SessionEventDiagnostics

final class SessionEventEvidenceTests: XCTestCase {
    func testForegroundTransitionsAreSeparateFromWechatInterfaceNotifications() {
        var evidence = SessionEventEvidence()
        evidence.recordForegroundTransition()
        evidence.recordNotification(category: "title", elapsedMilliseconds: 1200)
        XCTAssertEqual(evidence.foregroundTransitions, 1)
        XCTAssertEqual(evidence.notificationCount, 1)
        XCTAssertEqual(evidence.recentNotifications.first?.label, "标题变化")
    }

    func testHumanFeedbackNeverCertifiesSwitchCoverageAndStopsAfterClosing() {
        var evidence = SessionEventEvidence()
        evidence.recordHumanObservation(hadPrompt: true)
        evidence.recordHumanObservation(hadPrompt: false)
        evidence.close()
        evidence.recordHumanObservation(hadPrompt: true)
        evidence.recordNotification(category: "title", elapsedMilliseconds: 3000)
        evidence.recordForegroundTransition()
        let summary = evidence.summary()
        XCTAssertEqual(summary["human_with_prompt"] as? Int, 1)
        XCTAssertEqual(summary["human_without_prompt"] as? Int, 1)
        XCTAssertEqual(summary["received_events"] as? Int, 0)
        XCTAssertEqual(summary["foreground_transitions"] as? Int, 0)
        XCTAssertEqual(summary["contact_switch_coverage_verified"] as? Bool, false)
        XCTAssertEqual(summary["captures"] as? Int, 0)
        XCTAssertEqual(summary["text_reads"] as? Int, 0)
    }

    func testOnlyFixedNotificationsEnterTheBoundedVisibleHistory() {
        var evidence = SessionEventEvidence()
        evidence.recordNotification(category: "PRIVATE_WINDOW_TITLE", elapsedMilliseconds: 10)
        evidence.recordNotification(category: "title", elapsedMilliseconds: -1)
        XCTAssertEqual(evidence.notificationCount, 0)
        for index in 1...20 {
            evidence.recordNotification(category: "selection", elapsedMilliseconds: index * 100)
        }
        XCTAssertEqual(evidence.notificationCount, 20)
        XCTAssertEqual(evidence.recentNotifications.count, 5)
        XCTAssertEqual(evidence.recentNotifications.first?.elapsedMilliseconds, 2000)
        XCTAssertEqual(evidence.recentNotifications.last?.elapsedMilliseconds, 1600)
    }
}
