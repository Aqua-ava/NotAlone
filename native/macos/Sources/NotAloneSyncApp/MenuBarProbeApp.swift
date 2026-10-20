// 历史 Swift 菜单栏入口已退役；保留无采集的失败入口，避免旧脚本恢复正文 OCR。
import Foundation

@main
struct RetiredMenuBarProbeApp {
    static func main() {
        fputs("旧 Swift 菜单栏诊断已退役；请使用 npm run dev 的正式桌面入口。\n", stderr)
        exit(EXIT_FAILURE)
    }
}
