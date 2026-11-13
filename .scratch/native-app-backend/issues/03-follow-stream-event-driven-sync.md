# 03 — CLI 适配器 --follow 流式读取与事件驱动同步

Type: task

**Triage:** ready-for-agent
**State:** resolved

**What to build:** 消息读取从一次性轮询升级为 `tail --follow` 常驻流（兑现 ADR-016 第 3 条原设计）：任何时刻只有当前绑定联系人保持一个流；切换联系人停旧启新；流崩溃后指数退避重启并从水位补读；`--follow` 不可用时降级回一次性轮询退避；失败关闭语义不变。新消息入库后经事件通道推送。本票全部用 fake CLI 流式扩展验证，真实微信冒烟由 04 票负责。

**Blocked by:** 01（后端服务骨架）、02（事件总线与 SSE 契约）

- [x] fake CLI 适配器扩展出 `--follow` 流式语义，支撑本票与后续测试。
- [x] follow 流消息经既有稳定消息身份去重与规范化，写入正确联系人范围；重复事件不产生重复消息。
- [x] 切换联系人停旧启新；切回补读保留 `cli_catchup` 标记与联系人独立水位。
- [x] 手动关闭窗口内的消息只前移水位不写入。
- [x] 流进程崩溃进入指数退避重启并从水位补读；`--follow` 不可用降级回一次性轮询退避。
- [x] 新消息入库后产生事件推送，fake CLI 流式集成测试覆盖观察→入库→事件全链路。
- [x] 既有 `TailLifecycle` 集成测试（切换隔离、去重、非前台停读、重启恢复等）更新后全部通过。

## Comments

- 来源规格：`.scratch/native-app-backend/spec.md`。架构依据：ADR-016、ADR-020。
- 实现前重读 `.scratch/local-wechat-cli-observation/issues/06-tail-lifecycle-catchup.md` 与 07 票的"剩余风险"部分。

## Answer

- 实现：`LocalWechatCli.tail_follow` 新增可关闭只读流 `TailFollowStream`（后台读线程 + 逐条 JSONL 校验，`--strict-read-only`）；`TailFollowItem` 以 `event=None` 表示非文字事件只前移水位。`TailLifecycle` 改为 follow 优先：切换停旧启新、崩溃指数退避重启并从水位补读、`--follow` 不可用或连续 3 次打开即失败后永久降级一次性轮询；切回联系人先一次性补读（`cli_catchup`）再重开流，补读不会被误标 live。批次结果区分本次新建消息（`created_message_ids`），事件只推送新建消息。
- 架构：`front_sync` 只保留 `MessageEventPublisher` 纯端口与空适配器；`EventBusMessagePublisher` 放服务壳层 `server/event_publisher.py` 由组合方注入，生命周期零依赖展示通道。生产构造（`command.py`）默认一次性轮询，follow 仅由测试显式开启，待 04 票真实冒烟后再接线。
- 验证：`conda run -n NotAlone python -m unittest discover -s tests -q` 全量 492 项通过（2 项真实模型冒烟跳过）；`compileall` 与 `git diff --check` 通过。双轴 code-review（Standards + Spec）无遗留硬违规；Spec 指出的 status_changed 发布方与心跳/工作区探针层不在本票清单，留待后端接线与 04 票。
- 数据影响：仅新增本地观察来源与规范消息写入路径（沿用既有去重/删除语义）；测试全部使用合成数据。剩余风险：真实 CLI 的 `--follow` 行为（参数、退出码、乱序事件）与长进程稳定性需 04 票端到端验证。
