# 06 内部 RPC Standards 复核

只读检查两个新增 Python 模块及对应 unit/persistence 测试；未修改产品源码，未启动 App、读取业务数据库或使用真实资料。

## Finding

- **[P2] 取消后 HTTPConnection 可自动重连并发出写请求**：`backend/src/notalone/persistence/skill_management_remote.py:74-81` 在检查 `cancelled` 后调用 `connection.request`，与 `close()`／deadline 的 `interrupt()` 并发时没有保护。如果取消发生在检查之后、实际发送之前，`interrupt()` 关闭并清空 `connection.sock`，而 `HTTPConnection.request()` 默认自动重连。于是 close 已返回或 deadline 已到期后仍会向宿主发送同步写请求；最终虽然返回 unavailable，但远端副作用已发生，且新的 socket 不再是 `request.transport` 所保存的 socket。违反 ADR-102:22 停收并核对在途后移交责任的约束，也违背该适配器 close 的打断承诺。

确定性复现：复用现有测试的匿名 loopback server，用 Event 暂停 `HTTPConnection.request` 入口（此时第74行检查已通过），调用 `remote.close()` 后恢复真实 request。实际输出为 `requests_after_close=1, worker_alive=False, errors=['skill_management_remote_unavailable']`。只传合成 owner 和 token；fixture 已正常清理。补一个相同边界的取消／超时测试，并禁止关闭后的自动连接，确保取消与连接生命周期协调；仅再加一次 cancelled 检查仍保留同样竞态。

其余已检查的固定地址、固定身份、代理绕过、错误脱敏、响应大小／格式校验及本地嵌套租约排空未发现独立 finding。没有重跑整套测试；现有关闭测试只覆盖已到达服务端后的阻塞，不能覆盖上述发送前竞态。

## 最小修复探针

在同一暂停点仅对测试连接设置 `auto_open=0`，再执行 close／恢复，实际得到 `requests_after_close=0, worker_alive=False, active_requests=0`，固定 unavailable 错误保持。建议在 `_Request` 创建连接时设置此标志：显式 connect 不受影响，send 不会在关闭后自行建立第二条连接。此为隔离测试探针，尚未修改或签收产品修复。

## 修复复核：已关闭

已只读确认 `_Request.__init__` 在创建连接后设置 `connection.auto_open = 0`（`skill_management_remote.py:23`），不会等待取消后才设置。新增 `test_cancellation_before_send_cannot_reopen_connection` 用真实 socket 与 Event 固定发送前时序，分别覆盖 close 和 Timer 截止，核验调用线程退出、返回固定失败且服务端无请求。该修复消除了已复现的自动重连路径，原 P2 关闭；本次 RPC Standards 未关闭 finding 为 0。

本轮仅复核实现和测试，不重跑测试、不修改产品源码；不据此宣称生产移交、跨票集成或 App 验收完成。上文为修复前审查及探针历史。
