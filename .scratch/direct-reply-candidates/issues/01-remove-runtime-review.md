# 01：移除生产回复模型复核并保留确定性边界

Triage: ready-for-agent
State: resolved

来源：[规格](../spec.md)，2026-10-18 用户本轮决定。

## 验收

1. 正式公开生成入口直接返回模型产生的有效结构候选，无 `ReplyFidelityReview` 调用。
2. 同键重放无新增生成；来源删除、越界引用、缓存和不合法结构继续受既有边界约束。
3. 新质量合同绑定直接候选策略与生产接线，不转签旧质量资格。
4. 文档和受影响回归反映新流程，历史证据保持原状。

## Answer

已移除正式 `reply_wiring` 的独立模型复核装配，继续使用原运行时的无复核路径；生成输入、范围／来源复验、结构／引用检查和人工选择发送保持。新质量合同标识 `post_generation_review=disabled` 并包含生产接线，旧证据只按历史协议重放。

验证：

- 公开直接候选用例先在旧接线失败（被复核筛掉两条），移除装配后通过。
- `NOTALONE_DISABLE_DOTENV=1 python -m unittest discover -s backend/tests/unit/reply -t backend`：417 项通过；其中质量合同模块含配置与接线变化失效旧资格的回归。
- `python -m unittest tests.integration.server.test_reply_current_constraints -v`（backend 目录）：5 项通过，覆盖直接候选、来信、重放、无效引用、生成中删除与缓存拒绝。
- 其余 9 个受影响 HTTP 文件的 178 个方法按批次及定点复验通过，覆盖准备／生命周期／继续／讨论预算／偏好／历史依据／本人分层／组合及直接候选；未反复重跑整套。首批的旧 store 参数、跨模块夹具污染和旧 schema 断言失败如实保留，修复或隔离后只重验对应场景。
- `mypy --follow-imports=silent backend/src/notalone/reply/quality.py` 通过。连同 `server/reply_wiring.py` 检查仍发现 `PreparedAssistantContext.build` 缺少 `history_message_ids` 的既有类型不一致；对照变更前文件得到同一错误，本任务不扩改该接口。
- 模块导入带跑的非本任务 `test_overview_prepared_context.py` 仍有旧 schema 5 断言，未改写为已通过。Standards 初审 1 项旧调用数日志已改为真实差值，复审 0 项；Spec 审查 0 项。
- 实际 App 合成验收未完成：首轮测试夹具硬编码旧迁移数；临时修正后已启动隔离实例，但 CUA 选中既有同标识 Electron，未执行任何生成、编辑或发送动作，主动中止并撤回本轮临时原生测试／夹具改动。自有 App、两轮测试库、用户目录和租约均已收尾；既有业务 App 未修改。未认证原生界面或已安装包。

数据影响：无业务数据库迁移、来源删除或既有资料重写；无真实模型请求、微信读取或外部消息发送。所有验证只使用隔离合成资料，正常运行减少生成后那一次模型出站。独立的 L2/L3 整理质量及自动使用资格保持原状态。
