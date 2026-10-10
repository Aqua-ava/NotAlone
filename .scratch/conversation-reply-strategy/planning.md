# 聊天回复策略：工作流状态

更新日期：2026-10-11。

## 当前阶段

第一版范围与公开测试接缝已获用户确认，已发布[正式 spec](spec.md)，功能尚未实现。已整理[5票提案](ticket-proposal.md)，等待粒度及依赖确认后再发布 issues；不是把多张任务合在一个文件。

## 来源与边界

[原草图](../../architecture/drafts/conversation-reply-strategy.md)保留已确认方向与未来议题；第一版以 spec 为准。OCR、具体邀约 Skill、热梗接入、自动风格学习和长期影响研究不在本轮实现范围。不会因规格发布宣称真实模型质量通过。

## 后续

确认对应提案后，一票一文件发布，初始 State: open、Triage: ready-for-agent；按依赖在独立上下文中 TDD、验证、Standards/Spec 评审与本地提交。当前只推进两份规格和提案，不启动代码实现或外部评测。
