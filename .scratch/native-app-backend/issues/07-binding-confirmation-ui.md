# 07 — 绑定确认界面化

Type: task

**Triage:** ready-for-agent
**State:** resolved

**What to build:** 首次绑定、重名、改名或证据矛盾时的候选绑定，在主窗口内显示一次性选择列表（display name、外部会话定位标识、最近活动时间），用户选择后写入绑定；菜单栏的两级子菜单确认入口被主窗口入口替代。

**Blocked by:** 05（主窗口骨架）

- [x] 出现候选绑定时主窗口弹出选择列表，同步在确认前保持暂停，不写入消息。
- [x] 确认后后续切换自动识别，不再重复确认；已绑定会话经最近会话回退可自动认出。
- [x] 证据矛盾或无候选时失败关闭，不把消息写入错误联系人。
- [x] 绑定确认 API 与既有 `confirm-binding` 命令共用同一确认逻辑；绑定只保存展示名与证据摘要（预览为 SHA-256）。
- [x] 集成测试覆盖首次、重名、改名与失败关闭路径。

## Comments

- 来源规格：`.scratch/native-app-backend/spec.md`。
- 绑定与匹配语义沿用迁移 019 的字段与既有领域匹配器；参考 08 号菜单栏票记录的 OCR 名字变形回退。

## Answer

- 后端新增 `POST /api/sync/confirm`（严格 JSON 请求体 `{contact_id, locator}`），经 `SyncHost.confirm` 委托 `FrontSyncEngine.confirm_binding`，与 CLI `confirm-binding` 命令共用同一应用层逻辑（薄壳架构）；真实 HTTP 适配器按 Content-Length 读取请求体（上限 1MB、异常按空体），契约测试与真实 HTTP 冒烟均验证 body 真正到达处理器。
- 错误映射：非法 JSON/参数 → 400 `binding_confirmation_invalid`；确认被引擎拒绝 → 409 `binding_confirmation_rejected` + 稳定 `reason` 码（如 `no_pending_selection`/`candidate_not_found`/`binding_conflict`）；无同步宿主 → 503。绑定只保存展示名与证据摘要（预览经 SHA-256，不存预览原文）。
- Swift 主窗口：status.candidates 非空时弹出一次性选择 sheet（候选列表展示 display name、外部会话定位标识与最近活动时间），点候选后展示联系人列表（避免按展示名猜测，重名/不同名安全），选择后调用 confirmBinding；「稍后处理/取消」不写入绑定、同步保持暂停且本会话不再自动弹出；确认成功后候选清空、sheet 自动收起，后续切换由引擎自动识别。
- 集成验证：新增 HTTP→SyncHost→真实引擎整链测试（首次绑定经 API 全流程、确认后同一会话自动识别、拒绝 reason 稳定），契约测试覆盖 400/409/503 与请求体解析；Swift 拒绝 reason 解码展示（`confirmRejected(reason:)`）。
- 验证：Python 全量 547 项通过（含 2 项真实模型冒烟跳过）；`swift build`（macos_app 与 macos_sync_probe）与 `swift test`（探针包 21 项）通过；真实 HTTP 冒烟确认无身份 owner 的 503 失败关闭；`git diff --check` 干净。
- 双轴 code-review（Standards + Spec）：修复硬违规「真实 HTTP 未读取请求体导致 confirm 恒 400」；修复 Swift sheet 关闭死胡同（派生 Binding no-op、Escape 无效、「关闭」按钮为空操作）；`AppModel.confirmBinding` 去掉候选重查与静默失败，失败路径有提示；`confirmRejected` reason 展示。
- 数据影响：测试使用合成 UUID/`_test` 库；不触碰生产数据。
- 剩余风险：菜单栏两级确认入口已于 05 移除并由主窗口替代；真实微信前台下的候选出现与确认交互需人工冒烟确认（依赖真实微信环境）。
