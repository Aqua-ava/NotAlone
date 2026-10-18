# 验证记录

- 基线：7afa5b17。仅使用现有 npm run dev 开发实例，无打包、无消息发送。
- TDD：切人额外状态请求计数、途经联系人立即恢复、过时未绑定/歧义结果阻止最新可靠联系人，均先失败后通过。
- 最终组合：foreground-change-source-http、contact-restore-coalescing、manual-foreground-resume 共14项通过。
- 另验：连续跟随/群聊/单帧HTTP共12项通过，原删除门禁4项通过；TypeScript检查通过。
- npm test：164项中163通过；既有headless命令测试因needs-owner-verification租约而失败，未清理未知占用。
- 原contact-content-restore HTTP测试未进入行为阶段：夹具固定001–072，但当前正式迁移已至087。未修改旧迁移场景或掩盖失败。
- Standards独立审查：0项。Spec独立审查：0项代码问题，实机高频耗时待验证。
- 已用Computer Use打开本轮更新小窗；微信聊天区坐标点击受AXError.notImplemented限制，由用户切换补充体验验收。
- 不把此前单次674ms识别测量视为本轮端到端P95；尚不承诺每次低于一秒。
- 无新增身份缓存，原始帧不落盘或上传；草稿缓存和权威内容删除复验保持。

## 启动状态恢复修复
- 实机连续两次启动出现同步状态loading→unavailable，随后后端状态接口已200但前端不恢复；因SyncHost首轮快照晚于连接就绪，返回503 sync_status_unavailable。
- 新增仅只读状态的1/2/4/8秒封顶退避，成功/断连/刷新/退出取消；不会重放开关等写操作。
- 修复后开发实例实际记录：首次暂不可用后1003ms自动ready且enabled=true；不等同于联系人端到端耗时。
- sync-status-recovery先红后绿6项；与foreground-change-source-http、manual-foreground-resume组合17项通过；typecheck、diff检查通过。首次HTTP测试环境变量不完整，补齐Conda NotAlone路径及名称后通过。
- 独立代码审查无问题。窗口panel对照未改善，且隐藏恢复存在抢焦点风险，已完整撤回；临时DEBUG-follow-gates日志代码已清除。
- 另外确认后台同步与前台观察共享engine锁，busy可能造成4/8秒退避；尚未改锁架构，实机联系人加速体验待本轮确认。
- 无数据迁移、无消息发送、无新增授权；使用原开发实例，未打包。
