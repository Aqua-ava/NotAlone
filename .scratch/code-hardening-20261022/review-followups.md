# 复核遗留项（2026-10-22）

以下为两轮独立审查（Standards / Spec）后仍未在本轮处理的事项，不属于已完成的 A+B 范围

1. **真实 App/微信验收未执行**：05/15 的 UI 接线、首帧重试、概览展开与撤销入口尚未在 `npm run dev` 下实机验证；headless 场景（打开版本历史→撤销自动更新）也因本机未装 Playwright 浏览器未运行。
2. **新状态字段的展示面**：sync `health`、import `processing_deferred`/`processing_unavailable`/`degraded`、reply `context_receipt.*_read_failed`、`skill_files` 健康已有后端/HTTP 投影，但桌面尚未展示；需要产品确认展示位置与文案。
3. **Skill catalog 待清理排除语义**：当前仍把待清理/待同步工作副本的技能整体排除（fail-closed）。是否改为「列出但标记不可用+原因」需产品确认，涉及 catalog 契约与界面。
4. **`OwnerLayeredMemoryPanel` 未接线**：本人主题资料自管理面板仍无生产入口，保留为产品决策项。
5. **Standards 遗留低优先级重复**：`_timed_memories`/`_timed_rows` 行列绑定重复、memory_conditions/memory_events 批量分组骨架重复、initial-read 首帧站点各写包装；需要单独重构 ticket。
6. **历史提交正文**：`fe0e40b2`/`ee282510`/`c6445b25` 的提交正文含字面 `\n`（当时工具写入问题），不回写历史；后续提交已纠正。
7. **C 项**：`app.py` 路由表化、`session.ts` 拆分、评测/实验包迁移、仓库大文件清理、CI/测试 runner 门禁，均需另立 spec。
