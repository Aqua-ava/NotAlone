import XCTest
import NotAloneAppCore

final class FollowSmokeControlTests: XCTestCase {
    func testDefaultShortcutsCoverFollowLifecycleAndAllCheckpoints() {
        let actions = Set(FollowSmokeShortcutCatalog.entries.map(\.action))

        XCTAssertEqual(
            actions,
            Set([
                .start,
                .stop,
                .interrupt,
                .baseline,
                .beforeFollow,
                .afterLiveMessage,
                .afterIdle,
                .afterFollowRestart,
                .wechatBackground,
                .afterReenable,
                .finalResult,
            ])
        )
        XCTAssertEqual(
            FollowSmokeShortcutCatalog.shortcut(for: .start),
            "⌃⌥⇧S"
        )
        XCTAssertEqual(
            FollowSmokeShortcutCatalog.shortcut(for: .finalResult),
            "⌃⌥⇧8"
        )
    }

    func testCheckpointActionsExposeFixedBackendLabels() {
        XCTAssertEqual(FollowSmokeControlAction.baseline.checkpointLabel, "baseline")
        XCTAssertEqual(FollowSmokeControlAction.beforeFollow.checkpointLabel, "before_follow")
        XCTAssertEqual(FollowSmokeControlAction.afterLiveMessage.checkpointLabel, "after_live_message")
        XCTAssertEqual(FollowSmokeControlAction.afterIdle.checkpointLabel, "after_idle")
        XCTAssertEqual(FollowSmokeControlAction.afterFollowRestart.checkpointLabel, "after_follow_restart")
        XCTAssertEqual(FollowSmokeControlAction.wechatBackground.checkpointLabel, "wechat_background")
        XCTAssertEqual(FollowSmokeControlAction.afterReenable.checkpointLabel, "after_reenable")
        XCTAssertEqual(FollowSmokeControlAction.finalResult.checkpointLabel, "final")
        XCTAssertNil(FollowSmokeControlAction.start.checkpointLabel)
    }
}
