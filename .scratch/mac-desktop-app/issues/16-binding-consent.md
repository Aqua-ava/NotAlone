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
