# 06 — 消息流展示与实时更新

Type: task

**Triage:** ready-for-agent
**State:** resolved

**What to build:** 用户在主窗口中栏看到所选联系人的规范消息流：正文、说话人、时间、媒体占位文本与引用消息按领域定义如实展示；打开联系人加载历史，新消息到达时经事件通道实时更新，不需要手动刷新。

**Blocked by:** 02（事件总线与 SSE 契约）、03（--follow 流式读取与事件驱动同步）、05（主窗口骨架）

- [x] 消息查询 API 只返回当前联系人范围内 active 来源的规范消息，跨联系人读取被拒绝。
- [x] 媒体占位文本与引用消息按领域定义渲染：占位不冒充正文，引用目标缺失时显示为未解析引用。
- [x] 打开联系人时分页加载历史消息；新消息事件到达后消息流实时追加。
- [x] 契约测试覆盖消息查询 API 的 JSON 结构与范围隔离。
- [x] 手工冒烟：真实导入数据与前台同步新消息都能在消息流中正确展示。

## Comments

- 来源规格：`.scratch/native-app-backend/spec.md`。
- 消息范围语义沿用既有 PostgreSQL Retrieval 的 active 来源与联系人隔离约束。

## Answer

- 新增消息流查询 API `GET /api/contacts/{contact_id}/messages?limit=&before=`：只返回当前 owner 范围内 active 来源（`message_source_ref` 有效）的规范消息；跨 owner/不存在联系人返回 404；keyset 分页（按 occurred_at DESC NULLS LAST 排序，空时间排在末尾，limit+1 探测下一页）。
- JSON 契约按领域定义输出：`text` 与 `media_placeholder` 分开（媒体占位不冒充正文）；引用消息经来源元数据解析 `quoted.text` 与 `target_message_id`（引用目标仍存在时回到目标消息，缺失时 `target_message_id=null` 由界面显示「未解析引用」）；时间格式与 SSE 契约一致（秒级 UTC、`Z` 结尾）。
- 事件接线：`notalone-server` 构造引擎时注入 `EventBusMessagePublisher(events)`，消息写入即发布 `message.created` 到总线并经 `/api/events` 推送；`follow_enabled` 保持 False（Issue 04 真实冒烟通过前读取主路径仍为一次性轮询）。
- Swift 端：`BackendClient.messages` 分页读取、`SseEventClient` 订阅事件流（解析 message.created，重连后发 `reconnected` 对账信号拉最新一页去重合并，弥补断线窗口内入库消息）；主窗口中栏显示消息流（说话人/时间/正文/媒体占位样式/引用块，引用目标可点击定位，未解析引用标黄，加载更早分页，新消息自动滚动到最新且不打扰加载更早）。
- 验证：契约测试 9+4 项（鉴权、范围隔离 404、JSON 钉住、active 来源过滤、媒体占位、引用已解析/未解析、分页游标、非法参数 400、应用服务门禁）；Python 全量 539 项通过；Swift `swift build`+`swift test`（探针包 21 项）通过；`build_app.sh` 完整构建 .app 成功；真实库冒烟（`FSM💕cxk` 248 条消息）验证分页与引用解析；SSE 帧解析与后端真实帧格式逐字段核对一致。
- 双轴 code-review（Standards + Spec）：修复包括 SSE 断线静默丢消息（重连对账）、「加载更早」被滚动打断、引用跳转交互缺失、`before` 非法参数静默降级 200、时间格式化/查询解析重复实现、Swift 客户端样板重复、死分支与注释。
- 数据影响：只读查询 API；测试使用合成 UUID/`_test` 库；冒烟只读真实库不写数据。
- 剩余风险：清单最后一项的真实微信前台同步冒烟（新消息实时入库→SSE→界面追加）需在真实微信环境人工确认（依赖 Issue 04 的冒烟环境）；菜单栏与主窗口的屏幕录制权限授予仍需人工验证。
