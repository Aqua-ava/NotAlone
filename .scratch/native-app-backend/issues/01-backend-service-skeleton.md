# 01 — 后端服务骨架与进程内测试接缝

Type: task

**Triage:** ready-for-agent
**State:** resolved

**What to build:** 用户启动 NotAlone 后，一个常驻本地后端服务在本机回环地址上提供只带 token 的 API；联系人列表第一次可以不经命令行被读取。同时建立本功能的主测试接缝：进程内测试客户端直接调用服务应用，不起真实网络进程。

**Blocked by:** None — can start immediately.

- [x] 服务只绑定本机回环地址，启动时生成随机 token；无 token 或 token 错误的请求被拒绝，错误信息不回显凭据。
- [x] 进程内测试客户端可直接调用服务应用，成为本功能的主测试接缝。
- [x] 联系人列表 API 只返回当前 owner 范围内的联系人，含展示名称与数据状态。
- [x] API 与既有 CLI 共用同一应用层读取路径，不复制业务逻辑。
- [x] 集成测试覆盖 token 校验、owner 隔离与联系人读取路径。

## Answer

- 已新增 `src/notalone/server/` 后端服务骨架：默认随机生成启动 token，只允许绑定 `127.0.0.1`，所有 HTTP 方法先经过 token 校验；未授权响应不回显凭据。
- 已新增进程内 `InProcessClient` seam；`GET /api/contacts` 返回当前 owner 的联系人、展示名称和有效消息/来源统计。
- 联系人目录抽为应用层 `ContactDirectory` + PostgreSQL adapter；`notalone-front-sync contacts` 与后端共用该读取路径。
- 已新增 13 项相关测试，覆盖 token、owner 隔离、数据状态、非 GET 鉴权、随机 token 和回环绑定约束。
- 验证：`conda run -n NotAlone python -m unittest tests.integration.server.test_app tests.unit.front_sync.test_command -v`；`conda run -n NotAlone python -m unittest discover -s tests -v`（476 通过，2 个真实模型冒烟跳过）；`compileall` 与 `git diff --check` 通过。
- 数据影响：测试仅写入 `notalone_test` 中的合成 owner/contact/source/message，测试结束按 owner 级联清理；未触碰正式数据库或用户资料。

## Comments

- 来源规格：`.scratch/native-app-backend/spec.md`。架构依据：ADR-020。
