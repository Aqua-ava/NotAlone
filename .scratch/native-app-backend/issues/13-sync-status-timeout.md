# 13 — 同步状态读取超时

Type: bug

**Triage:** ready-for-agent
**State:** resolved

**Symptom:** App 已经能够读取联系人和首启状态，但同步管理区域反复提示“后端状态读取失败：The request timed out.”；同时后台同步周期仍在继续。

**Confirmed cause:** `SyncHost` 使用同一把锁保护同步引擎和状态快照。后台同步周期会执行 CLI、前台探针和数据库 I/O，持续时间不可控；HTTP 状态接口在这段时间也要等待同一把锁，因此把慢同步放大成 App 的请求超时。

**Blocked by:** none

## 修复

- 将引擎操作锁与状态快照锁分开；同步周期继续串行保护不可并发的引擎调用。
- `/api/sync/status` 和 Follow 运行状态改为读取缓存快照，不再等待正在执行的同步周期。
- 缓存同步报告和最近一次有效前台观察时，仍保留原有读取门禁与敏感数据边界；状态接口不返回聊天正文。
- 增加慢同步回归测试，确保同步周期阻塞时状态读取仍能立即完成。

## 验证

- 回归测试：先验证新测试在旧实现上失败，再验证 `tests.unit.server.test_sync_host` 17/17 通过。
- 相关接口测试：28 项通过。
- Python 全量测试：736 项通过，2 项按既有条件跳过。
- 当前本机 App：`/api/sync/status` 返回 HTTP 200，约 0.001 秒；`/api/sync/follow-smoke/status` 返回 HTTP 200，约 0.03 秒；界面显示“CLI 后台同步中：已绑定 115 个会话”。
- 未进行真实联系人发送；本次修复只涉及本地状态读取并发，不改变手动发送边界。

## 收尾记录（2026-09-08）

- 修复文件：`src/notalone/server/sync_host.py`、`tests/unit/server/test_sync_host.py`。
- 已重新启动当前构建的 NotAlone App 与后端，并确认权限弹窗没有再次出现。
