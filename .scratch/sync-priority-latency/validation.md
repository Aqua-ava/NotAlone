# 优先同步修复验证

- 基线：`1f3ef8a96a94dbeac893cedbb1b6a63f0f906cbe`；已有单条测试消息发送至入库约 202 秒，旧发送许可已用完。
- RED/GREEN：优先提示未接线、Host 整轮阻塞、切片等待、共享 CLI 截止时间、HTTP 指标缺失及桌面状态不自动更新，均先以公开接口行为复现再修复。
- 后端：四个相关模块 96/96；`tests.unit.front_sync` 191/191；CLI adapter 33/33；同步 HTTP 模块 23/23。
- 持久化：`tests.integration.front_sync.test_confirmed_contact_continuity` 1/1；仅创建随机自有 `_test` 库，完整迁移并清理，未查询业务表。
- 桌面：`sync-priority.test.mjs`、`sync-status-recovery.test.mjs`、`sync-priority-status.test.mjs` 共 16/16；TypeScript 检查通过。
- 实际开发 App：复用 `npm run dev`，已确认优先目标登记成功；单轮排队 82ms、CLI 70ms、总耗时 80ms；这是无新消息检查，不是发送至入库样本。
- 实际输入小窗已显示“最近成功检查消息”并自动更新时间；回应消息列表可用。
- 页面：`npm run test:pages -- --case message-events --timeout-seconds 300` 六场通过，覆盖自动更新、断流恢复、分页缺口和联系人/认证范围失效；单无头 Chrome、隔离 HTTP/PG，退出码 0。
- 双轴审查与新消息实测结果待补充；未发送新外部消息。

数据影响：继续只读原已确认的联系人绑定，按原 owner/contact 保存文字来源、消息及独立游标。新增指标不含昵称、正文、凭据或视觉帧；未新增授权、并发正文读取、后台发送或外部模型调用。

预算局限：三秒仅限同一切片 CLI 剩余预算；数据库事务和规范化仍需实际阶段计时。少量真实样本不能证明 P95。原生界面观察时间上界与 SSE 接收时间须分开报告。
