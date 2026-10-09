# 16：首次会话选择与绑定授权

Type: task
State: claimed
Triage: ready-for-agent
Blocked by: 06
Spec: ../spec.md

## 交付行为

查看会话元数据，手动选择并确认对应联系人，明确授予后台正文读取范围。

覆盖规格用户故事：42、43。

## 验收条件

- [x] 首次列表无预选，新会话和刷新不自动授权；已存在的有效确认范围按后端真实状态展示。
- [x] 绑定使用稳定内部身份与已确认外部定位标识，重复、冲突、失效或改名需重新确认。
- [x] 范围变更/撤销按现有确认协议落实，不在未确认范围读取正文；用合成 CLI 及真实 HTTP 验证。

## 测试与范围

- 当前 CLI 批量确认是增量追加，缺少公开绑定目录与撤销。补齐最小安全投影（binding_id/contact_id/conversation_locator/display_name/status），固定当前运行 owner/渠道/账号，包含当前 CLI 列表消失的 active 绑定；不返回正文或视觉证据。
- 既有批量确认 selections 增加可选 observed_display_name。App 携带最后展示的名称；服务端在自身当前 CLI 元数据复读中逐项比较，任一改名/消失拒绝整批并要求重新确认，不部分创建联系人、绑定或 baseline。原 display_name 自定义展示与不提供新字段的既有调用保持兼容；名称不充当身份，也不新增持久字段、端点或读取授权。
- 撤销后台读取授权复用现有 read_binding/revoke_binding，在 SyncHost 同一循环互斥边界内有界等待本轮收尾，校验全部范围后幂等标记 revoked。成功响应后该绑定不再新增 tail；超时、范围不符或失败保留真实状态并提供重试。它保留既有绑定记录及历史资料，用户主动清除来源仍按任务 15 的独立删除流程；不新增表或重写同步算法。
- 使用真实 HTTP、隔离 PostgreSQL 和可控 CLI 验证目录、跨范围拒绝、重复撤销及并发门禁；仅在 tail 后阻止写入不等于已经停止读取。
- 沿用规格中用户已确认的实际 App 操作与后端 HTTP 公共接缝；一次推进一个 red -> green 行为，自动验收与实现一起完成。
- 涉及业务数据时只使用合成资料、随机隔离 `_test` 库和独立握手/配置；本任务未涉及的后端、渠道与桌面能力保持后续任务范围。
- 按仓库工作流读取相关领域及工程约束，完成最小相关检查、Standards/Spec 两轴评审和只含本任务改动的本地提交。
- 不提交私人资料或凭据，不发送外部聊天消息；远端 Git 操作需另有用户明确同意。

## Comments

- 2026-10-08：开始在独占 `codex/mac-app-16-bindings` 实现；固定基点 `e88423b68c025de24d491e077cf79172fca298ee`。按已批准的实际 App、真实 HTTP、随机隔离 PostgreSQL 与合成 CLI 接缝做 red → green；候选保持 claimed，交由主 Agent 安排双轴评审。

- 2026-10-08：用户认可二十张任务的粒度和依赖，按 `to-tickets` 发布；尚未开始本任务。
- 2026-10-08：主 Agent 根据只读代码与测试证据，在本任务既定授权管理/停读闭环内明确绑定目录与串行撤销的必要公开接线；原任务粒度与依赖不变，不把旧前台 pending 兼容流程当作新小窗手选联系人的必需入口。
- 2026-10-08：真实接线核对发现 App 最终复读与服务端确认自身 CLI 复读之间仍可能改名。按本任务既定过期确认拒绝要求，先明确可选 observed_display_name 的最后元数据一致性检查及整批回滚，保留原展示名兼容；不承诺外部改名持续锁定，不改变任务图或授权范围。
- 2026-10-08：实现候选使用真实目录、具名桥接与管理页面，不从名称推断内部身份。已有授权与未提交选择分开；同名联系人显示内部标识供明确选择，用户也可明确新建。目录固定当前运行 owner/渠道/账号，包含 CLI 列表消失的 active 绑定。撤销在 SyncHost 同一 cycle 锁内最多等待 4 秒取得锁，完整范围复核后幂等撤销；取得锁前超时不执行迟到撤销，成功响应后不再新增该绑定的 tail，历史资料与既有记录保留。CLI 元数据不可用时仍可管理真实目录；缺本人渠道身份时引导已确认的首份导入与正常重启，没有隐藏初始化。
- 2026-10-08：原始 red 基点 `e88423b68c025de24d491e077cf79172fca298ee`；接手续验时先合入启动诊断 `beda065ee1a336b83459b0c72283aa87b15bc955`，入口冲突保留两条接线。最终候选前再快进至 `0ffae9e6b6b469a6ee1a26de1e5bcce582c99d40`；该次仅合入任务 04 两行实机观察，生产源码与已验证签名包相同，因此不重复构建或业务测试。候选保持 claimed，由主 Agent 统一两轴评审后再写 Answer/resolved。
- 2026-10-08：真实 red 证据保留在本工作树 ignored `desktop/artifacts/bindings-tdd-evidence.md`：HTTP 新目录 404、撤销入口缺失、App 确认按钮未接线与撤销按钮缺失均曾失败。原最终名称 red 仅保留叙述，本轮保存绿色字节快照后临时恢复旧契约，以同一真实 HTTP/PG 单项重现改名返回 200 而预期 409 的失败，并逐字恢复实现；详见 `bindings-resume-name-red.log`，不把重现伪称为第一次编写该测试。最终服务端复读名称不一致时整批拒绝，当前联系人及绑定目录无部分新建；自定义 display_name 与未提供新字段的旧调用均兼容。
- 2026-10-08：最终验证：Conda NotAlone 中核验模块来自本工作树 `backend/src`。真实 HTTP/PG 绑定组 `python -m unittest tests.integration.server.test_binding_consent -v` 为 5/5（20.256s）；旧 CLI、双通道、后台同步、SyncHost、停读、HTTP DTO、PG 持久绑定与新授权相关组为 101/101（21.075s）。`npm run typecheck` 通过；实际 App 绑定/迟到响应组 11/11（57.7s）；`npm test -- --output=artifacts/bindings-resume-full-source` 全部 98/98（8.7m，含主 Agent CUA 协调时暂停调度）。原 `bindings-final-source` 的超时/窗口关闭失败上下文仍保留，其瞬时原因未另行证实，不以清理页面推断产品主动退出。
- 2026-10-08：`npm run package` 重建后，指定 `NOTALONE_TEST_APP_EXECUTABLE` 的绑定/迟到响应、联系人及窗口组 25/25（1.9m）。严格 `codesign --verify --deep --strict` 通过；ad-hoc、`com.notalone.desktop`、仅 allow-jit、ATS=false、无权限用途键。打包器另提示可选 `.icon` 格式缺失，既有 `.icns` 与 App 品牌正常；不作为构建失败或 Developer ID/公证证据。日志、合成截图与字节快照位于 `desktop/artifacts/bindings-resume-*`，包位于 `desktop/out/NotAlone-darwin-arm64/NotAlone.app`，均不提交。任务字段/DAG/相对链接辅助检查及 `git diff --check` 通过。
- 2026-10-08：所有库为本轮随机新建、正式迁移的 `_test`，env/info/userData/模型/CLI/probe 均隔离；夹具显式建立合成本人渠道身份，不能证明 setup→首份导入→重启的首用完整链路。只读资源核验该前缀测试库与本工作树 App/后端/合成 CLI 剩余均为 0；只清理本轮所有资源。没有读取私人配置、业务库或真实微信，没有模型调用、外部发送或 CGEvent。真实微信/原生权限、真实模型及系统快捷键派发仍不属于本轮已通过证据；外部确认后的持续改名不会被锁住。
- 2026-10-09：首轮候选 `b1c7c459e01ef642f94decc41fed48920d9c2f8d` 双轴评审后，按用户“先继续不触桌面的工作，实机验收稍后安排”继续安全修复。恢复中断中的同一 merge，保留双方真实权限台账；先合入集成 `ef86567f1f9c7d5c780f2f03cac939eef3f05264` 的跨工作树桌面启动门禁，本轮固定修复基点为 merge `4a4d0a7e47d4f68c20999c6b3b6eb66e60340ebd`。中断前无长命令遗留，进程核验仅有审计命令自身；不重复启动，不清理未知 PID。任务保持 claimed，候选交主 Agent 增量双轴，未写 Answer/resolved。
- 2026-10-09：修复最后 GET 与 POST 之间的明确新建竞态：携带既有 `observed_display_name` 且省略 `contact_id` 的选择若发现 locator 已 active，在 Coordinator 写入前整批 `409 cli_binding_rejected` / `selection_stale`，不静默复用别的联系人或部分创建其他项。沿用 `SyncHost.confirm_cli_bindings` 的同一 engine_lock，确认拒绝在 `CliFullSyncEngine.confirm_cli_bindings` 的 backfill/cycle 之前；不同宿主在最终复读后竞争时，既有 `conversation_binding_active_locator_unique` 与 `create_cli_bindings_batch` 同一事务保证冲突回滚。源码分别在 `backend/src/notalone/server/sync_host.py`、`front_sync/cli_binding.py`、`front_sync/full_sync_engine.py`、`persistence/conversation_repository.py` 与迁移 `006_conversation_binding.sql`；没有新端点、协议字段、数据表或同步算法。改名整批拒绝、显式相同联系人重放、自定义展示名及未提供新字段的旧调用保持兼容。
- 2026-10-09：公开 HTTP 竞态 red → green 使用两条并发认证请求、合成 CLI 元数据阻塞及随机正式迁移 `_test` 库。正式 red（3.474s）返回 200 而非 409，联系人及授权多一项，额外 tail 两次；最小拒绝实现后同一用例 1/1（3.023s）通过。补充只读 PG 行数 red contact/runtime_binding/baseline/observation/message 为 3/2/2/2/2，green 为 2/1/1/1/1，仅另一合法确认的范围保留；PG 计数不作 HTTP 行为测试的内部断言。驱动首次模块路径失败、最初联系人全 DTO 比较包含赢家合法统计变化的校准记录均独立保留，不计为正式 red。日志和可复现驱动为 ignored `desktop/artifacts/bindings-review-race-*`。
- 2026-10-09：采纳 P3：`desktop/src/main/bindings/validation.ts` 只共享 UUID 与 locator 非空/4096/控制字符两条纯值规则，IPC 参数边界与 HTTP 响应解析仍各自校验并保留固定中文错误；不新增通用验证架构或镜像测试。`npm run typecheck` 通过。最小相关后端 CLI 确认、双通道引擎、SyncHost、HTTP DTO、真实 PG 绑定持久化与真实授权组 66/66（21.541s）通过，涵盖名称变化、撤销并发、旧调用和显式相同联系人兼容，日志 `desktop/artifacts/bindings-review-related.log`。本轮未运行 App、Playwright、CUA、键盘或模型，未重建包；历史签名 App 结果不能证明修复已通过新的 UI 验收。
- 2026-10-09：env/info/模型/CLI/probe 均由本轮临时目录隔离，模块核验来自本工作树 `backend/src`；仅新建合成随机 `_test` 库并正式迁移/回收。本轮竞态驱动创建库与后端进程剩余 0，相关组父测试库剩余 0。任务 16 新增测试仅经已合门禁的 app-fixture，完整 raw launch 只读审计未发现本任务旁路；未读私人配置、业务库或真实微信，没有外部发送、push 或 PR。后续 App 正向适配与修复后 UI 验收仍待用户认可的桌面时段。
- 2026-10-09：主 Agent 已完成修复增量双轴，固定基点 `4a4d0a7e47d4f68c20999c6b3b6eb66e60340ebd` 至候选 `77620ad9a48ab98ce01a6bcea6218e01d206e2c2` 的 Standards 与 Spec 均为 0，原 P3 重复验证及 P2 过期新建竞态已解决；原完整评审其余结论保留。历史 App 11/11、源码 98/98、签名包 25/25，以及新真实 HTTP red → green、后端 66/66 和资源剩余 0 的完整证据保持原记录，不覆盖或扩张为最新版桌面验收结果。
- 2026-10-09：按用户当前决定，最新版 UI 及重建签名包仍待认可时段内的实际验收。可由合并者先安全合入两轴通过的代码，形成统一可评审集成；此操作不关闭任务、不自动解除 17/18 的阻塞，也不解除桌面暂停。任务保持 claimed，不写 Answer/resolved、不改依赖图。本次仅追加 Comments 并做差异及任务辅助检查，不重复后端组、类型检查或任何 App/Playwright/CUA/键盘操作。

- 2026-10-09：恢复到集成 `1c8825b` 后，生产绑定桥接已由主 Agent 以 `cdc42df61c3eb4f6b0d576d5601bc785338c5038` 接入 PageCommands/PageTransport。本轮静态抽取纯绑定后端夹具及共享公开页面场景，原 9 条 consent 与 2 条 stale 由 App／普通页面复用；新增并发新建旧选择拒绝和短等待撤销成功，扩展 CLI 缺失、执行失败与公开刷新恢复，以及 arity／旧范围／跨 owner 与 account／helper 角色边界。只安排合成 CLI 与本轮随机新 `_test` 库，保持真实 HTTP／PG 业务。类型检查、构建和静态纯依赖检查通过；没有启动任何 HTTP／PG、浏览器、Electron、模型或原生操作，未产生 UI red／green。共享 PageHost、renderer 与受限 CLI 入口接线由主 Agent 串行处理。收尾以认证 stopped、owned 后端正常退出和精确测试库删除确认；未知页面／传输／准备收尾保留 marker、临时目录与非秘密归属诊断。旧 App 场景历史勾选保持原证据，最新版普通页面尚待运行，任务继续 claimed，不写 Answer／resolved。

- 2026-10-09：静态修复 App wrapper 与纯夹具的停读见证接线：所有绑定 App 场景均由本轮 BindingFixture 预启并持有唯一真实后端，App 在原路径正常连接／app.close；复用单个回环代理，仅在原 token、POST /api/runtime/shutdown、真实 HTTP 200 和正文 state:stopped 同时匹配时记录见证，再独立核验 owned child exit 0。未提前向 App 外部停读；没有见证时只对保存的原目标尝试夹具认证收尾，日志区分 app-http-response、page-host 与 fixture-shutdown，不能把后者作为产品退出通过。CLI 准备失败且尚未尝试启动时可只精确回收本轮新库，停读字段保持 false；启动结果或页面／传输清理未知时保留诊断。类型、构建、静态纯依赖与差异检查通过；本轮仍未运行任何 App、HTTP、PG 或浏览器，不把静态接线称为原生或普通页面 green。

- 2026-10-09：静态合入指定任务08候选 `5518f84710de1eb416dcb76c626bd799f470fe60`（含当前10／12／14切片）；入口冲突保留生产 PageCommands 绑定、回复会话、Electron 复制和导入选择各自接线。当前普通 PageHost 只新增绑定 installer，renderer 复用同一 preload factory；copySurface／chooseImportFile 和既有复制／导入／资料／回复／依据通道均保留。任务16既有11条 consent＋2条 stale 的13个普通场景入口已在当前合并宿主静态构建；run.ts 与受限 test-pages 登记交由主 Agent／14唯一共享入口负责人串行处理。类型、构建、纯页面依赖、固定差异与20票检查通过；没有运行PG、HTTP、浏览器或App，不将静态接线记为 UI green，任务继续 claimed、无 Answer。
