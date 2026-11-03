# 后台图片与记忆读取隔离

Triage: ready-for-agent
State: claimed

Blocked by: none

## Goal

使用 `SqliteStorage.openReader()` 建立宿主生命周期内的后台只读通道，将图片同步目录查询和记忆管理读取从主 SQLite worker 移出；所有写入继续走主 worker。

## Acceptance

- [ ] `SqliteImageSyncCoordinator` 只依赖 `Pick<StorageReader, 'execute'>`，宿主传入隔离 reader。
- [ ] `SqliteMemoryManagement.read`／`readHistory` 使用隔离 reader，`prepareTimeline` 和决定写入仍走主存储。
- [ ] `backgroundReads` 纳入宿主关闭、排空和错误传播。
- [ ] 后台慢读期间前台写入不被串行阻塞。
- [ ] 来源、lease、删除和迟到结果保护不回归。
- [ ] 最小读写隔离测试和类型检查通过。
