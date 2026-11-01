# 桌面联系人删除验证

日期：2026-11-01。用户确认的范围：联系人详情「⋯ → 删除联系人」，明确确认后停止同步、移出目录并清理此人在 NotAlone 的本机资料；失败可重试，不自动加回，后续明确添加建立新联系人而不恢复旧资料。

## 实现与数据边界

- 沿用既有 SQLite 删除协调器，不改数据库结构或 DSH 接口。删除先封禁有效读写资格，既有领域闭包清理消息、关系资料、助手讨论、候选、受管副本及对应记录；仅权威任务状态及最终复核通过才显示完成。
- 删除入口仅在管理窗口开放。IPC 与 preload 核对显式确认、稳定联系人 ID、当前选择代次及字段白名单；切换联系人、连接变化或取消窗口不提交删除。
- 联系人退出目录后，任务反馈仍独立存在。已知任务只重试原 operation；回执丢失时，只有用户明确重试才可重放最初确认的旧联系人 ID，重放幂等，不作用于后续新建联系人。
- 重连先只读核验固定运行本人的 `owner_id`，相同本人才能恢复 main 内存中保存的未知意图；不同本人不公开旧姓名或任务。完成项撤下姓名与联系人标识，不将请求接受或目录缺项当作完成。
- 旧渠道身份只保留必要墓碑，普通刷新或开关不重新建联。必须完整联系人删除已完成、历史绑定均撤销、旧联系人均删除，才允许用户基于新名单明确创建新 ID；仅身份领域清理不足以开放重加。
- 微信好友、微信原消息和用户外部原件不变。确认窗口说明模型服务商的留存及删除按其政策独立处理，本机删除不代表外部副本已清除。

## 自动检查

使用 Node.js 24，数据均为隔离临时 SQLite、合成账号及会话。控制器 HTTP 合同使用真实 `ContactMetadataLifetime`、`DeletionService`、`SqliteDeletionHttp` 与 `ContactSession`；仅替代本地认证传输和微信元数据，实际删除仍由生产存储模块执行。无真实微信正文或外部模型调用。

在 `desktop/`：

```sh
pnpm run typecheck
node --test tests/contact-deletion-controller.test.mjs tests/contact-deletion-http.test.mjs
NOTALONE_TEST_CHROMIUM_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' node --test tests/contact-deletion-view.test.mjs tests/contacts-history-view.test.mjs
```

覆盖当前对象与确认门、权威终态、另一联系人保留、回执丢失、原请求幂等重试、连接换代、同本人恢复、跨本人隔离、错误任务范围拒绝、目录消失后反馈保留、键盘取消与焦点、窄屏布局。控制器及真实 HTTP 12 项、页面相关 12 项通过。

在 `backend-ts/` 执行以下相关模块与 `pnpm exec tsc --noEmit`：

```sh
node --test test/sqlite-contact-binding.test.mjs test/sqlite-contact-close.test.mjs test/sqlite-deletion-metadata.test.mjs
node --test test/sqlite-deletion-metadata.test.mjs test/sqlite-history-host.test.mjs test/sqlite-deletion.test.mjs
node --test test/sqlite-memory-deletion.test.mjs test/sqlite-media-deletion.test.mjs test/sqlite-discussion-deletion.test.mjs
```

联系人绑定、关闭与元数据删除 44 项通过；正式历史宿主与删除协调器的另 30 项、记忆／媒体／助手讨论删除 18 项通过，重复的元数据用例不重复计数。结合桌面控制器与页面，相关回归共 116 项通过，前后端类型检查通过。覆盖未完成删除恢复不被 50 条较新完成记录挤掉、整项删除完成前不得重加、显式重加新 ID、旧 DELETE 不影响新对象、晚到结果和实际本机文件清理。扩大回归发现的「身份领域清理后过早开放重加」已通过整项删除完成证据收紧，原拒绝断言仍通过。

`pnpm run test:inventory` 全量登记检查仍失败：HEAD 基线已有以下 5 个已跟踪测试未登记，本次新增的 3 个测试均已分类，未改变这些既有遗漏：

- `tests/assistant-session-workspace.test.mjs`
- `tests/foreground-recovery-view.test.mjs`
- `tests/message-stream.test.mjs`
- `tests/packaging/upgrade-history-image-cli.test.mjs`
- `tests/sqlite-first-session-regression.test.mjs`

因此不宣称桌面全量默认测试通过；本轮仅报告实际执行的相关回归。

## 真实桌面与清理

复用并核验 `pnpm run dev` 热更新实例；未打包、未运行打包版、未启动第二个 App。真实 App 选择当前显示无已保存消息的联系人，依次打开「⋯」、删除确认框，核对默认焦点为取消、范围文案与外部副本说明，再用 Escape 取消并核对焦点返回。未在私人联系人上点击最终删除，未新增授权或发送外部消息。删除执行、文件与来源闭包、失败恢复用上述隔离合成数据验证，不将原生确认／取消等同于真实私人资料已删除。

真实界面及合成窄屏截图已检查；私人界面帧不写入仓库。测试临时目录随用例清理，合成截图及日志留在仓库外；开发资源目录前后均约 3.8 MiB，无独立 App 或运行时副本需清理。
