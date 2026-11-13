# 03 起草 ADR-173 与现行规格更新

Triage: ready-for-agent
State: resolved
Type: task
Blocked by: 无（ADR-173 已于 2026-11-05 采纳；任务 04 可开始写产品代码）

规格：[../spec.md](../spec.md) 第 6.10 节。

## 做什么

1. 先读：`architecture/adr/144-preserved-history-source-recertification.md`、`architecture/adr/151-shared-wechat-cli-process.md`、`architecture/current/privacy-deletion.md` 的“来源变化与重新认证”、`architecture/current/wechat-sync.md` 第 43 行附近、`docs/verification/source-recertification-20261101.md`。
2. 新增 `architecture/adr/173-developer-batch-source-recertification.md`（文件名如需调整保持英文短横线），状态写“提议，待用户确认”。必须写明：
   - 为什么需要：成百上千个联系人被围栏，逐位点不现实；
   - 与 ADR-144 的关系：仍是用户明确选择；一次确认覆盖弹窗列明的“全部当前被围栏且在有效读取范围内的联系人”；每位仍由后端独立复验；不绕过任何保护；
   - 严格串行、可停止、失败停下、不自动恢复、不持久化批量状态；
   - 只在开发模式出现，不进入打包版；
   - 不记录名称与正文；
   - 被拒绝的方案：直接删围栏、自动静默修复、并发修复，各写一句理由。
3. 在 `architecture/adr/README.md` 末尾加一行索引。
4. 在 `architecture/current/wechat-sync.md` 的“来源重新认证”相关段落补一句现行要求并指向 ADR-173；若 `privacy-deletion.md` 同段需要同步，一并改。**只写用户已确认的内容**，提议状态的 ADR 不要写成已采纳。
5. 运行 `node scripts/check_public_history.mjs --ref HEAD --working-tree`，确认无新增命中。
6. 按 `docs/agents/engineering.md` 的 Git 规则做一个只含本任务文件的本地提交，不推送。

## 验收

- ADR 与 README 索引、现行规格的措辞一致，不出现“已实现”。
- 用户过目并确认后，把 ADR 状态改成“已采纳（日期）”，再把任务 04 解锁（在其 `Blocked by` 里去掉 03）。
- 没有改动产品代码。

## Comments

- 2026-11-05：已起草 `architecture/adr/173-developer-batch-source-recertification.md`（状态“提议，待用户确认”），并同步 `architecture/adr/README.md` 索引、`architecture/current/wechat-sync.md` 来源重新认证段与 `architecture/current/privacy-deletion.md` 来源变化与重新认证段，三处均标注提议状态、未写已实现。本地提交 `45668b5c7`（仅含上述 4 个文件）。提交前后 `node scripts/check_public_history.mjs --ref HEAD --working-tree` 均为 issues 0（基线 commit `d95f115f7` 同为 0）；未改产品代码，未启动 dev、未跑测试。等待用户过目并确认 ADR；用户已确认采纳（2026-11-05），ADR 状态已改为“已采纳（2026-11-05）”，README 索引与现行规格同步更新为已采纳、尚未实现。

- 2026-11-05（确认采纳后）：ADR-173 状态改为“已采纳（2026-11-05）；尚未实现，实现与验收状态另行记录”，正文“提议”表述校正为已采纳的约束；`architecture/adr/README.md` 索引改为“已采纳（2026-11-05）；未实现”；`architecture/current/wechat-sync.md` 与 `architecture/current/privacy-deletion.md` 对应句子改为已采纳、尚未实现。本地提交 `8560b3fb8`（仅含上述 4 个文件）。提交前后 `node scripts/check_public_history.mjs --ref HEAD --working-tree` 均为 issues 0；未改产品代码。任务 04 的阻塞已从本任务解除。
