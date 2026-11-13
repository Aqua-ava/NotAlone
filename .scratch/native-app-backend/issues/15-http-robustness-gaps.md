# 后端 HTTP 层结构化缺口（第二轮审查遗留项）

Triage: ready-for-agent
State: resolved

## 背景

2026-09-18 第二轮只读审查发现 HTTP/服务层的几处结构性缺口。同轮已修复：SyncHost 心跳线程死亡（`sync_enabled` 异常守卫）、`handle()` 顶层 500 兜底、`_authorized` 非 ASCII TypeError、TaskHost 并发 start 竞态（RLock + 按线程身份清除条目）。以下为遗留项，均已在代码中核实。

## 遗留项

1. **`do_HEAD` 返回完整响应体**（`app.py` `_write_response`）：HEAD 响应不应含 body，属 HTTP 协议违规，本地影响小。
2. **超大请求体静默当空体**（`_read_request_body`，Content-Length > 1 MiB 返回 `b""`）：客户端收到 RST 而非 413，失败模式无契约；缺失 Content-Length 或 chunked 同样静默。建议改为稳定 413 响应后再断开。
3. **SSE 写入异常捕获不全 + 无 socket 超时**（`_serve_sse` 只捕获 `BrokenPipeError, ConnectionResetError`）：`ConnectionAbortedError`/`TimeoutError`/其他 OSError 逸出刷堆栈；半开连接可让 keep-alive 写无限阻塞、事件队列积压。
4. **`has_active_backend` 的 pid 复用/跨用户误判**（`connection_info.py:99-107`）：pid 被无关进程复用或探测到其他用户进程时拒绝启动。
5. **owner 未初始化时 `/api/events` 可静默空挂**（`open_sse` 不经过 owner 门禁）：订阅成功但永远收不到事件。

## 为什么测试没抓到

无慢客户端/断连方式/超大请求体的针对性用例；`test_sync_host.py` 假引擎的 `sync_enabled` 从不抛错（该路径已补守卫，但对应回归测试见提交说明）。

## Answer

2026-09-18 已完成遗留项 1、3、5，并部分完成遗留项 2：HEAD 只写响应头；正整数 `Content-Length` 超过 1 MiB 时返回稳定 413，并以 100ms、最多 8 MiB 的有界排空兼顾正常上传客户端与只声明长度的慢客户端；SSE 写端增加 300 秒 socket 超时并统一收敛断连类 `OSError`；owner 未初始化时事件订阅返回 503。真实回环 HTTP 测试覆盖 HEAD、完整超限 body、仅声明超限长度但不发送 body，以及未初始化 owner。缺失/非法/负数 `Content-Length` 与 chunked 契约、遗留项 4（PID 复用/跨用户误判）尚未处理，本 ticket 保持 open。

## Comments

- 2026-10-04：收尾分类并关闭。5 条遗留项中 3 条已由后续提交修好（HEAD 提前返回、SSE 写异常改捕 `OSError` 且有 300s socket 超时、owner 未初始化返回 503），各条均有既有集成用例；本机另跑 `tests/integration/server` 149 项通过。
- 2026-10-04：第 2 条（超大／异常请求体）本轮补完可本地验证的部分：缺失、非数字与负数 `Content-Length` 现在返回 400 而不是当作空请求体继续处理；`Transfer-Encoding: chunked` 仍不支持（回环本地客户端不发送 chunked，若将来需要再单独设计）。新增回环用例覆盖三种畸形声明。
- 2026-10-04：第 4 条（`has_active_backend` 的 pid 复用／跨用户误判）保持未修：真实 PID 复用无法在本地稳定复现，跨用户 `PermissionError` 分支虽可单测，但正确修法是核对进程身份（命令行／启动时间），属于新的判定契约；已作为限制保留在本票，不阻塞关闭。
