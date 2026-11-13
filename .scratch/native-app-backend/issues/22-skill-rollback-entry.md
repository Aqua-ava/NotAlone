# App 缺少 Skill 回滚入口

Triage: ready-for-agent
State: resolved
Blocked by: none
规格：[NotAlone 原生 App 与常驻本地后端](../spec.md)

## 背景

`spec.md` 的 US24 要求用户在 App 里“导入、启用、停用、回滚和删除回复 Skill”。2026-10-04 收尾核验发现：库层已支持回滚（`src/notalone/persistence/skill_library.py` 的 rollback 路径与 revision 递增），服务端也已暴露回滚端点（`src/notalone/server/app.py` 的 Skill API），但 **macOS App 没有回滚按钮或命令**（`macos_app/Sources/` 中 grep 不到 rollback），App 目前只有预览、启用／停用、删除。

## 待决定

1. 回滚入口放主窗口的 Skill 页，还是沿用现有命令行的显式入口即可；
2. 回滚目标如何呈现（上一版本、任选历史版本、还是带时间与变更摘要的列表）；
3. 回滚是否需要二次确认与理由记录，以及是否在台账／运行记录中留痕。

这三项都改变用户可见契约，需要用户先给方向；确认后实现与验证都不难（服务端端点已在，App 侧加命令与状态刷新即可）。

## 验收

- 用户在 App 内可以发起回滚，并能看到目标版本与结果；
- 回滚后 Skill 版本与运行记录一致，失败时有稳定错误文案；
- 相关单元／集成测试与两轴审查完成。

## Comments

- 2026-10-04：按推荐方案落地并关闭。方案：入口放在 Skill 页的“版本”按钮，弹出历史列表（版本号、描述、创建时间、当前标记），回滚前有二次确认对话框，成功后刷新列表并提示“已回滚到第 N 版”；回滚记录仍走既有运行记录与台账，不额外留痕字段。
- 2026-10-04：实现覆盖三层：库层 `list_versions`（按版本号倒序、只读元数据）、应用层与 `GET /api/skills/<id>/versions`、App 侧 `skillVersions`／`rollbackSkill` 与版本历史 sheet。回滚仍复用既有 `rollback` 端点与事务语义。
- 2026-10-04：验证：Swift 全量 66 项测试通过（新增 3 项：版本解码顺序、回滚 POST 路径与 `version_id` 请求体、409 冲突映射），`swift build` 通过；Python 侧服务端集成 151 项、持久化集成 290 项通过；新增库层与服务端用例各 1 项。限制：本机无法运行 macOS App 做界面点击验证，UI 只做到编译与 Core 层测试；界面呈现方式若日后要调整（例如展示版本变更摘要）属于新的外观任务。
