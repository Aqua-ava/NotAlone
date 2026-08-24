# 01 — 后端服务骨架与进程内测试接缝

Type: task

**Triage:** ready-for-agent
**State:** open

**What to build:** 用户启动 NotAlone 后，一个常驻本地后端服务在本机回环地址上提供只带 token 的 API；联系人列表第一次可以不经命令行被读取。同时建立本功能的主测试接缝：进程内测试客户端直接调用服务应用，不起真实网络进程。

**Blocked by:** None — can start immediately.

- [ ] 服务只绑定本机回环地址，启动时生成随机 token；无 token 或 token 错误的请求被拒绝，错误信息不回显凭据。
- [ ] 进程内测试客户端可直接调用服务应用，成为本功能的主测试接缝。
- [ ] 联系人列表 API 只返回当前 owner 范围内的联系人，含展示名称与数据状态。
- [ ] API 与既有 CLI 共用同一应用层读取路径，不复制业务逻辑。
- [ ] 集成测试覆盖 token 校验、owner 隔离与联系人读取路径。

## Comments

- 来源规格：`.scratch/native-app-backend/spec.md`。架构依据：ADR-020。
