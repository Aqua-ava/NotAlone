# 02 — 事件总线与 SSE 契约

Type: task

**Triage:** ready-for-agent
**State:** resolved

**What to build:** 后端服务向界面单向推送事件的通道打通：订阅方带上 token 即可收到结构化事件（新消息到达、同步状态变化、任务进度共用同一事件模型），断线可以重连。事件的 JSON 形态被契约测试钉住，作为 Swift 端解析的依据。

**Blocked by:** 01（后端服务骨架与进程内测试接缝）

- [x] 事件订阅要求有效 token；事件只推送给持有对应连接的订阅方。
- [x] 事件模型至少覆盖新消息到达、同步状态变化、任务进度三类，统一携带联系人范围与时间。
- [x] 事件不包含消息正文；正文读取走联系人范围的查询接口。
- [x] 契约测试钉住每类事件的 JSON 结构与出现顺序。
- [x] 订阅断开后重连不丢事件语义（重连后以当前状态为准，不伪造历史事件）。

## Comments

- 来源规格：`.scratch/native-app-backend/spec.md`。架构依据：ADR-020。

## Answer

- 已新增类型化事件模型与内存事件总线，支持 `message.created`、`sync.status_changed`、`task.progress` 三类事件。
- 已新增 `/api/events` SSE 订阅，复用现有 token 鉴权与 owner 隔离；消息事件只携带 `message_id`，不携带消息正文。
- SSE 断线后使用 `Last-Event-ID` 重新订阅时只发送当前同步/任务状态快照，不回放消息历史；连接关闭和后端关闭会清理订阅。
- 已覆盖进程内 seam 与真实 `127.0.0.1` HTTP SSE：事件 JSON envelope、串行与并发发布顺序、owner 隔离、token、正文不泄漏和重连语义。
- 验证：`conda run -n NotAlone python -m unittest tests.integration.server.test_events tests.integration.server.test_app -v`（13 通过）；`conda run -n NotAlone python -m unittest discover -s tests -v`（483 通过，2 个真实模型冒烟跳过）；`compileall` 与 `git diff --check` 通过。
- 数据影响：仅使用内存事件总线；测试只使用合成 UUID 和本地回环临时连接，不写入生产资料，不持久化事件正文。
