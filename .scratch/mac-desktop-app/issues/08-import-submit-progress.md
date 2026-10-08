# 08：导入提交、处理进度与重试

Type: task
State: claimed
Triage: ready-for-agent
Blocked by: 07
Spec: ../spec.md

## 交付行为

确认预览后正式导入，更新联系人及来源，查看解析/提取的真实进度和失败恢复。

覆盖规格用户故事：38。

## 验收条件

- [ ] 确认后原子提交，重复提交返回原结果；来源、规范消息及首次本人渠道身份遵循现有后端规则。
- [ ] 展示真实任务状态、步骤和安全错误；重试原失败任务，不重做成功步骤，不按进度百分比假报完成。
- [ ] 导入期间能按现有调度发起前台回复；使用真实 HTTP 与隔离 PostgreSQL 验证成功、回滚及恢复。

## 测试与范围

- 沿用规格中用户已确认的实际 App 操作与后端 HTTP 公共接缝；一次推进一个 red -> green 行为，自动验收与实现一起完成。
- 涉及业务数据时只使用合成资料、随机隔离 `_test` 库和独立握手/配置；本任务未涉及的后端、渠道与桌面能力保持后续任务范围。
- 按仓库工作流读取相关领域及工程约束，完成最小相关检查、Standards/Spec 两轴评审和只含本任务改动的本地提交。
- 不提交私人资料或凭据，不发送外部聊天消息；远端 Git 操作需另有用户明确同意。

## Comments

- 2026-10-08：用户认可二十张任务的粒度和依赖，按 `to-tickets` 发布；尚未开始本任务。
- 2026-10-09：依赖 07 已完成，开始接入一次性确认后的原子提交、持久任务进度与原任务重试。用户选择先继续不触桌面的工作，本轮只准备公开 App 用例及隔离 HTTP 证据；必要 App 验收待安排，任务保持 claimed。
- 2026-10-09：真实 HTTP 显示首次 `new_contact_name` 已保存后，同 body 再提交返回 409；联系人、来源、消息仍为 1/1/6。按既定“重复提交返回原结果”获准最小修复：以受控 owner、稳定微信身份与同摘要查找原归属，原 active 来源、active 身份、`manual_create` 确认及当前联系人名称均一致才复用原 contact/task，返回 0 新增、6 重复投影。名称不作匹配键；名称变更、不同文件、原 `manual_select`、错 owner、非 active 来源或 revoked 身份拒绝自动复用/恢复，要求重新预览明确选择既有 UUID。锁定原记录，不新增 schema/DTO/token 或授权，二十张任务与依赖不变。
- 2026-10-09：本轮不触桌面的候选已接入具名提交、真实持久五步骤与安全错误、原失败任务 retry→run、真实联系人/来源刷新和明确认证停读重启入口。取消/断线只废弃本次等待与展示，不能撤销已发出的 commit 或后台任务；结果未知不自动重发，必须重新预览确认。同 body 新建重放真实 HTTP red 为 409，修复后 200、原 contact/task、0 新增/6 重复；首次同 body 并发均 200，仍只有 1 联系人/1 来源/6 消息。HTTP 九项 green 包含名称、不同文件、owner、manual_select、非 active 来源、revoked 身份及并发状态变更零新增副作用，原任务恢复不重做 parse/normalize、前台回复只用当前草稿范围且后台让位。夹具固定身份冲突及非法 deleted 状态的修正不算产品 red。
- 2026-10-09：已合入 root 复核的集成 `8a35aac053ba3985f10fe59bc96abcdabfabe722`，保留 07/09/13/16 与桌面门禁；`npm run typecheck && npm run build` 通过。以当前 `backend/src`、Conda NotAlone、禁默认 dotenv、双向独立配置/握手、模型/CLI/探针的随机新 `_test` 库运行 `desktop/tests/fixtures/import_http_check.py` 九项及 `tests.integration.server.test_first_import_api`、`tests.integration.persistence.test_postgres_repository`、`tests.integration.ingest.test_import_command` 四十项通过；仅该库执行正式迁移，逐次按本轮库名核验残留 0，临时目录/HTTP/任务宿主均按夹具收尾。HTTP owner UPDATE 与 CLI owner KEY SHARE/本人渠道身份 UPDATE 的现有锁区别保留；重放另锁原记录。`git diff --check` 与二十票字段/DAG/链接检查通过，后者不算产品测试。
- 2026-10-09：公开 App 提交、进度、恢复、迟到结果、丢响应及首份身份重装配用例已准备，本轮没有执行 Electron/Playwright/CUA、对话框或剪贴板操作，也未跑签名包、真实微信或语义质量验收；没有 UI red/green 或新截图。任务继续 claimed、验收条件未勾选、没有 Answer，等待 root 统一两轴复核和用户安排 App 时段。
- 2026-10-09（安全维护，待增量复核）：以 `a6ceb873332c44c2bc4e8875b9277adc530af4f9` 为 fixBase，修复实例 `doCleanups()` 的 bool 与类 `tearDown_exceptions` 被忽略而错误 exit 0 的问题。共享清理 helper 先执行实例和类全部清理回调，再核验两类结果与本轮随机库残留；异常或无法确认均非零退出，不能把 stop 命令确认当作清理成功。真实子进程/HTTP/随机 PG 故障检查 red 为关闭、class cleanup、DROP 三种故障均误返 0；修复后两夹具各四种情况共八种 green，正常 0、故障 1，其他 admin/HTTP/临时目录清理继续。被注入阻止的 DROP 如实报告残留 1，由检查器随后只清理本轮库并核验 0；夹具自身不假称已删除。
- 2026-10-09（安全维护命令与边界）：激活 Conda NotAlone、禁默认 dotenv、当前 `backend/src` 和独立读写配置/握手/模型/CLI/探针后运行 `python desktop/tests/fixtures/fixture_cleanup_check.py`；每种情况只迁移随机新 `_test` 库。`node tests/fixtures/fixture-transport-check.mjs` 六项验证真实管道分片、乱序 id、退出拒绝 pending、既有超时、坏记录后仍可控制收尾、受控握手 HTTP；共享 helper 只管传输，08/09 的业务控制、环境及生命周期保留，70 秒 ready、5 秒 command 超时不变。`npm run typecheck && npm run build`、`git diff --check` 和二十票字段/DAG/链接检查通过；未重跑已过四十项业务回归。Context7 不可用，核对实际 Node 25.2.1 的 [ChildProcess](https://nodejs.org/download/release/v25.2.1/docs/api/child_process.html)、[readline](https://nodejs.org/download/release/v25.2.1/docs/api/readline.html) 与 [Python 3.12 unittest](https://docs.python.org/3.12/library/unittest.html)。没有 App/Playwright/Electron/CUA 或桌面操作，没有新 UI/签名包证据；保持 claimed、无 Answer，最终增量两轴结论由 root 另记。
