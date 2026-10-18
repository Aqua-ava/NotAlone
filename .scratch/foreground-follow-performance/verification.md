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
