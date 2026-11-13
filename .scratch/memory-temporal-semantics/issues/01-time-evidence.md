# 01：时间含义贯穿记忆页面与回复依据

Triage: ready-for-agent
State: resolved
Type: task

Blocked by: None

交付：旧聊天今天导入后显示来源日期，保存时间独立；已有事件阶段／时段进入联系人、本人、分层资料和回复依据。用户能理解未知原因，不再看到笼统时间核实标签。历史生成快照保持原样。

验收：合成旧资料 → 公开读取 → 卡片／详情 → 回复模型输入 → 保存与恢复快照；覆盖无日期、来源不完整、计划已过日期、来源删除、本人和联系人隔离。沿现有合同贯通字段，本票不虚构新精度或条件状态。

## Acceptance criteria

- [x] 本票上述完整行为已从正式流程传递到 API、页面、分层资料及回复冻结／恢复依据。
- [x] 新旧合同兼容、来源删除、联系人／本人隔离和未知语义有合成回归。
- [x] 沿已确认公开测试边界完成单例 red → green、相关回归和类型检查。
- [x] 记录真实命令、结果、数据影响与未验范围，未将脚本模型通过冒充真实模型质量。

## 执行约束

规格见 [spec](../spec.md)，实现入口见 [exploration](../exploration.md)，依赖见 [拆分](../ticket-proposal.md)。工作流、工程、领域与本地任务规范按仓库入口读取。仅修改本票文件，适配同时进行的任务。桌面仅使用 npm run dev，先核对并复用开发实例，禁止打包。没有授权进行真实存量重提取、业务数据迁移、远端操作或外部测试消息。测试用隔离合成资料。每个切片 TDD，提交中文本地 commit；基于并合入集成分支，完成后由集成负责人统一评审与验收。

## Answer

已实现已有时间合同的纵向贯通；最终双轴审查和实际开发 App 验收由集成负责人统一进行。

- 候选、联系人／本人记忆的事件阶段／时段进入检索、实际回复模型输入、意愿探索、L2/L3 引用、生成冻结／恢复和迟到结果复验；旧快照不从当前资料回填。
- 页面分开显示来源日期、适用期间、事件和保存时间，替换含糊核实文案。时刻按记录携带的 offset 展示，不因设备时区改日；未知与部分来源区分。事件来源位置收进折叠详情。
- 本人整理外发仅保留时间含义白名单，禁止原始消息标识／位置外发。来源删除沿已有依赖清理；没有重提取、迁移真实资料、改变同步授权或发送消息。

验证（2026-10-20）：

- 已有 red→green：正式导入过期 planned → 回复输入／冻结恢复，以及同一事件进入 L2/L3。恢复后新增负七区跨日显示 2 项先失败、修复后 3 项通过。
- `PYTHONPATH=src .../python -m unittest tests.integration.server.test_memory_temporal_evidence tests.integration.server.test_memory_current_status tests.unit.reply.test_prepared_context_codec -v` 对应回归通过；首轮同时运行额外两模块时因未设显式隔离库而有 setup error／skip，随后以 CoreBusinessFlowFixture 创建本轮独立库并补跑。
- 独立库内 `test_historical_reply_basis`、`test_owner_layered_safety` 及 `MemoryEventHistoricalReviewHttpTest.test_plan_keeps_its_source_verified_stage_after_the_occurrence_interval_passes` 共 32 项通过。新增时间依据模块增强本人事件→L2/L3及外发去定位后 2 项通过。
- `npm run typecheck` 通过。提供 Conda、已安装 Chromium 路径后，6 个相关 Node 测试文件最终 92 通过、1 skip、1 既有失败；失败为 `overview-reply-retrieval` 的“本人两处事实管理…”旧夹具路径，在未含本票改动的集成 b8a4fd88 单例复现同样错误。skip 为需外部保存证据目录的已有可选用例。时间／事件／来源／恢复过滤运行 54 项全通过。
- `git diff --check` 通过。`npm run dev:status` 显示本工作树无开发实例；未启动真实 App、未抢占桌面、未打包。真实 App 由主 Agent 在最终集成后验收；合成工程通过不证明真实模型语义质量。
- 日志：`/tmp/temporal01-isolated-regression.log`、`/tmp/temporal01-owner-event.log`、`/tmp/temporal01-final-desktop.log`、`/tmp/temporal01-zone-red.log`。

## Comments

2026-10-20 用户明确同意四票拆分及测试范围，发布为 ready-for-agent。

### 集成复验

已合入统一记忆列表基线，保留撤下概览界面、所有失效记忆禁止生成的行为，时间 ADR 编号调整为081。`npm run typecheck`、时间／事件／统一列表 27 项桌面测试通过；时间 HTTP 与快照 codec 8 项通过，另用本轮独立合成数据库运行退休资格全模块及过期／旧快照重点用例13项通过。适用期间改用记录时区的可读日期，不展示半开区间术语。未启动实际 App，原生验收留待整体任务完成。
