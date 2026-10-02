import AppKit
import SwiftUI

// 主窗口应用的入口；通过 AppDelegate 把进程提升为普通窗口应用，
// 以便在 Dock 中出现并作为屏幕录制权限的责任进程。
@main
struct NotAloneApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        WindowGroup {
            MainWindowView()
                .environmentObject(AppModel.shared)
                .frame(minWidth: 980, minHeight: 560)
        }
        .defaultSize(width: 1080, height: 640)
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var followControls: FollowVerificationControls?
    private var terminationInFlight = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        AppModel.shared.start()
        let controls = FollowVerificationControls(model: AppModel.shared)
        followControls = controls
        controls.start()
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard !terminationInFlight else { return .terminateLater }
        terminationInFlight = true
        followControls?.stop()
        followControls = nil
        // 给已认证后端有界时间正常停读，包括本 App 复用的运行时。
        Task { @MainActor in
            await AppModel.shared.stop()
            sender.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }
}
