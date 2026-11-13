# 历史同步授权版本与旧授权升级

Triage: ready-for-agent
State: resolved
Type: task
Blocked by: 03

按 [spec](../spec.md) 与 [ADR-100](../../../architecture/adr/100-authorized-private-history-sync.md)，引入明确的“历史同步授权版本”状态，替代只靠现有同步范围推断历史读取资格。三条入口都要触发首次历史同步：新用户首连确认、仅所选会话确认、全部私聊模式下新发现的会话。老授权不能静默解释为包含历史，必须有一次明确确认。

## 验收

- [x] 新用户首次连接确认同时授予全部私聊范围、后台同步开启与历史同步资格，并为现有私聊创建历史覆盖任务（含 ADR-095 合并授权）。
- [x] 仅所选会话逐项授权的绑定同样创建历史覆盖任务；全部私聊模式下上线后新发现的会话首次纳入时也先读既有历史再转增量。
- [x] 老授权在下一次进入相关设置或启动时看到一次性明确确认；拒绝不改变总开关和绑定、不创建历史任务、增量同步继续；接受后与新用户行为一致，不再出现分支。
- [x] 重复确认、响应丢失、后端重启和并发刷新不重复创建任务、不重置检查点、不恢复已撤销或排除的会话。
- [x] 桌面确认界面文案明确说明读取范围扩大；控制器与视图测试覆盖接受、拒绝与重复确认。

## Comments

2026-10-23：实现完成并置 resolved。新增迁移 `105_history_sync_authorization.sql`（表 `wechat_history_sync_authorization`，主键 `owner_id + channel + account_scope`，保存 `version` / `decision` / `decided_at`）与 `persistence/history_authorization.py`：
`PostgresHistorySyncAuthorizationStore` 读写授权版本，`HISTORY_SYNC_AUTHORIZATION_VERSION = 1`。没有行的老授权读取为 `required`；`declined` 只落授权行，不改总开关与绑定；同一版本上迟到的 `declined` 不会降级已 `accepted` 的状态，重复 `accepted` 保留首次 `decided_at`，低版本确认不会覆盖更高版本。

三条入口接线：
- ADR-095 首次连接：`PostgresWechatSetupStore.connect` 在同一事务写入身份、`all_private` 范围、总开关和 `accepted` 授权；重启后 `_ensure_history_tasks` 为自动建联的现有私聊创建历史任务。
- 仅所选会话：`CliFullSyncEngine.confirm_cli_bindings` 用 `CliBackgroundSync.start_history_for_bindings` → `PostgresHistorySyncStateStore.ensure_bindings_started` 只为本次确认的 active 绑定建任务；账号级历史授权状态保持不变。
- 全部私聊新发现：账号授权 `accepted` 时，`_ensure_history_tasks` 在下一轮为新增 active 绑定补建任务，首读仍走 `tail(..., history=True)`。

状态与界面：`/api/sync/status` 新增 `cli_history_authorization_state` / `version` / `current_version`；新增 `POST /api/sync/history-authorization`，严格接受 `{decision: "accepted" | "declined", confirmed: true}`，经 `SyncHost.set_history_authorization` 在权限变更锁内落库并立即刷新任务。同步状态每次循环最多每 60 秒重读一次授权版本，接受/拒绝时直接更新缓存；后台授权端口仍失败关闭。桌面 `SyncControlBridge.setHistoryAuthorization`、主进程控制器、预加载桥与 `SyncControlPanel` 增加“读取更早的聊天记录”区：`required` 时明确说明读取范围扩大并提供“允许读取历史 / 暂不读取”，`declined` 时说明已有授权会话继续增量、仍可稍后允许，`accepted` 显示已允许。首次连接与逐会话确认文案同步说明首次历史读取。

本票改动的共享/跨票文件（供集成核对）：`backend/src/notalone/front_sync/cli_sync.py`、`full_sync_engine.py`、`factory.py`、`sync_engine.py`、`backend/src/notalone/persistence/history_sync_state.py`、`wechat_setup.py`、`backend/src/notalone/server/app.py`、`sync_host.py`、`backend/README.md`、`desktop/src/main/sync/{bridge,controller,status}.ts`、`desktop/src/preload/sync-control.ts`、`desktop/src/shared/sync-control-bridge.ts`、`desktop/src/renderer/{SyncControlPanel,BindingConsentPage,WechatSetupPanel}.tsx`。未触碰票 07 的提取/记忆模块或迁移 106。

两轴评审：Standards 采纳并修复未使用导入、导入顺序、`ensure_scope_started` 与 `ensure_bindings_started` 的重复 SQL（合并为私有 `_ensure_started`）、魔法版本号、授权刷新频率、拒绝态文案与逐项确认的歧义；保留窄授权端口（接口隔离）与前端操作参数传递（改动面可控）。Spec 采纳并修复：`decided_at` 重复确认不得重置、低版本不得覆盖更高版本、首次连接 → 建联 → 历史任务的端到端用例、拒绝后逐项确认仅覆盖该绑定的钉住用例、授权升级只主动排队一次而不改变常规发现节奏。未采纳“拒绝必须阻止后续逐项确认读取历史”的解释：规格第 2 条要求逐项确认也执行首次历史同步，拒绝只关闭账号级升级；该行为已由用例和文案固定。

## Answer

已完成：

- 老授权（无版本行）在同步设置页看到一次性明确确认；拒绝后授权状态持久为 `declined`，总开关与绑定不变，不创建历史任务，增量同步继续；之后仍可在同一区域改为允许。接受后为当前 active 绑定补建历史任务，并立即按固定预算排队读取。
- 首次连接一次确认写入全部私聊范围、开关与历史授权；新私聊自动建联后，下一轮为其创建历史任务并从最早页读取，再转增量。仅所选会话确认只为新绑定建任务；全部私聊新发现的会话在账号授权下同样先读历史。
- 重复确认、响应丢失重试、后端重启与并发 accept/decline 只保留一行授权、不重置水位/检查点，`ON CONFLICT DO NOTHING` 与 active 绑定过滤保证撤销/排除会话不复活。
- 状态 API 只输出授权状态与版本元数据；桌面只显示范围说明和决定按钮，不读取或展示聊天正文。

验证命令与结果（全部使用本票独立测试库 `notalone_04_test`，结束后已删除；未使用共享的 `notalone_test`）：

- 红：新持久化测试在实现前因 `notalone.persistence.history_authorization` 缺失失败。
- `NOTALONE_TEST_DATABASE_URL=postgresql:///notalone_04_test python -m unittest tests.unit.front_sync.test_cli_full_sync_engine tests.unit.front_sync.test_cli_history_sync tests.integration.persistence.test_history_authorization tests.integration.persistence.test_wechat_setup tests.integration.persistence.test_cli_history_sync tests.integration.server.test_sync_api`：85 项通过。
- `python -m unittest discover -s tests/unit/front_sync -t .`：250 项通过；`discover -s tests/unit/server -t .`：133 项通过。
- 桌面 `npm run typecheck` 通过；`npm test` 933 通过 / 1 跳过（共 934）；`node --test tests/sync-scope-view.test.mjs tests/wechat-setup-view.test.mjs`：6 项通过。
- 全量：一次运行 4482 项得到 130 failures / 93 errors / 64 skipped，抽样可见失败集中在 `tests.unit.memory_extraction.*` 等票 07/模型与环境门禁模块；本票相关模块单独全量通过。按用户快速收尾要求，最终修复后未再重跑整包。

未完成/剩余风险：

- 真实微信与全量历史规模、重启恢复和自定义账号验收留给 [08](08-real-wechat-acceptance.md)；本票只使用合成 CLI 与合成数据库。
- 历史覆盖与回复资格界面留给 [05](05-multi-binding-scheduling-and-coverage-ui.md) / [06](06-reply-eligibility-warning.md)；本票只交付授权状态和任务创建。
- 老授权提示只在同步设置页出现，未增加启动弹窗；规格允许“进入相关设置或启动”，本票选择前者。
- 未运行真实 App/桌面验收；桌面结论仅来自 typecheck、headless/view 测试。
