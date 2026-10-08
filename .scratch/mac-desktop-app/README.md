# 本机 Mac App 任务索引

规格见 [spec.md](spec.md)。用户于 2026-10-08 确认以下二十张任务及依赖。
每张任务单独记录验收条件、执行状态及完成证据；本索引仅用于导航，状态以任务文件为准。

| 编号 | 任务 | Blocked by |
| --- | --- | --- |
| 01 | [双窗口 App 与品牌外观](issues/01-dual-window-app.md) | 无 |
| 02 | [后端连接与认证退出停读](issues/02-backend-lifecycle.md) | 01 |
| 03 | [本机环境诊断与启动恢复](issues/03-startup-diagnostics.md) | 02 |
| 04 | [快捷键与小窗桌面操作](issues/04-window-shortcuts.md) | 01 |
| 05 | [首启身份与模型配置](issues/05-first-run-setup.md) | 02 |
| 06 | [联系人选择与双窗口隔离](issues/06-contact-session.md) | 02 |
| 07 | [单联系人历史预览](issues/07-import-preview.md) | 05、06 |
| 08 | [导入提交、处理进度与重试](issues/08-import-submit-progress.md) | 07 |
| 09 | [草稿改写与候选编辑](issues/09-draft-rewrite.md) | 06 |
| 10 | [真实复制与复制后隐藏](issues/10-candidate-copy.md) | 09 |
| 11 | [按明确方向回复消息](issues/11-directed-reply.md) | 09 |
| 12 | [候选依据与上下文核对](issues/12-reply-evidence.md) | 09 |
| 13 | [关系资料查看与来源回溯](issues/13-memory-reading.md) | 06 |
| 14 | [资料补充、修正与撤销](issues/14-memory-editing.md) | 13 |
| 15 | [来源删除到不可检索](issues/15-source-deletion.md) | 08、12、13 |
| 16 | [首次会话选择与绑定授权](issues/16-binding-consent.md) | 06 |
| 17 | [同步开关、停读与补齐](issues/17-sync-control.md) | 16 |
| 18 | [前台定位与人工消歧](issues/18-foreground-locator.md) | 09、16 |
| 19 | [新消息事件与编辑保护](issues/19-message-events.md) | 11、12 |
| 20 | [本机 App 打包与完整交付验收](issues/20-mac-app-delivery.md) | 03、04、10、14、15、17、18、19 |

优先处理全部前置已完成的任务。同一轮只实施当前任务，完成评审后再推进下一个任务；最后一张验收覆盖全部实现分支。
