# 多绑定历史调度、失败隔离与覆盖状态界面

Triage: ready-for-agent
State: resolved
Type: task
Blocked by: 03

按 [spec](../spec.md) 与 [ADR-100](../../../architecture/adr/100-authorized-private-history-sync.md)，让多个绑定的历史同步共享现有“每心跳一页”的续读队列：当前查看的联系人优先，但不得饿死其他绑定；单会话失败只影响该绑定并按退避自动恢复。桌面按联系人展示消息覆盖状态，并与关系资料处理分开表达。

## 验收

- [x] 多个绑定同时历史同步时每心跳只推进一页，当前查看联系人获得优先调度，其他绑定仍持续前进。
- [x] 单会话超时、空结果或读取失败只影响该绑定的覆盖状态，其他会话继续；失败按现有退避自动重试，不阻塞队列。
- [x] 桌面按联系人展示尚未开始、同步中、完整、不完整（含原因），当前联系人进度与汇总可见。
- [x] 连接成功、即时读取成功或计数增长不会被显示成历史已完整；历史不完整与失败可区分。
- [x] 消息历史覆盖与关系资料处理在界面上是两个状态，不合并成“记忆已同步”。
- [x] 控制器、视图与页面级测试覆盖；真实 App 的只读检查可回放。


## Comments

2026-10-23：在票 04 的共享文件上继续实现。TDD 先复现当前联系人每个慢心跳重新排到队首、其他绑定持续饥饿；新增交替优先策略：优先联系人最多提升一片，下一片保留原队列顺序，续页仍回队尾，生产宿主继续每片 `max_bindings=1`。绑定级失败、五秒起指数退避与空历史五分钟重探沿用历史引擎，补测试证明空结果不阻塞其他绑定。

状态桥严格校验历史覆盖四态、绑定/联系人 UUID、计数与原因码，只向页面提供最小元数据。同步状态响应预算从 16 KiB 调整为有界 4 MiB，超过预算整份失败，不截断后误报完整；控制器在仅所选会话模式也刷新历史覆盖进度。同步设置显示各联系人四态、已保存文字数/页数、当前联系人与汇总；联系人详情按当前 contact_id 筛选，不用即时读取或消息总量推断完整。关系资料独立说明并指向既有资料处理状态页面。

两轴独立 code-review（基准 `1edfc2a2` 到本票工作树）：Standards 未发现硬违反或阻断气味；Spec 未发现阻断偏差，建议补联系人详情实页断言，已补充甲/乙切换覆盖隔离测试。真实 App 阻碍见下方，未把合成页面检查当作真实微信证据。

## Answer

已完成多绑定公平调度、失败隔离回归、覆盖状态解码与控制器刷新、联系人详情和同步汇总展示。数据处理范围不扩大：不增加读取联系人、聊天正文输出、模型调用或发送能力；继续使用已有授权、来源、检查点和退避，只新增状态元数据展示。

验证（Python 使用 `$HOME/miniconda3/envs/NotAlone/bin/python`；Node/npm 使用同目录 PATH；页面测试设置 `NOTALONE_TEST_CHROMIUM_PATH=/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`）：

- 红→绿：`python -m unittest tests.unit.front_sync.test_cli_history_sync.HistorySyncEngineTest.test_priority_history_leaves_every_other_slice_for_waiting_bindings -v`：实现前四片全读当前联系人，修复后按当前/乙/当前/丙推进，每片一页。
- 红→绿：`node --test tests/sync-priority-status.test.mjs`：覆盖字段缺失断言失败后通过；非法阶段/UUID/计数拒绝，旧报告保持未知。
- 红→绿：`node --test --test-name-pattern='消息历史覆盖' tests/sync-scope-view.test.mjs`：覆盖区域不存在时失败，实现后通过。
- 红→绿：控制器新增测试在仅所选模式无法更新覆盖状态时失败，加入历史任务快照刷新条件后通过。
- `python -m unittest discover -s tests/unit/front_sync -t .`：252 项通过（含超时、空历史、缺表、重启、停读与公平调度）。
- 创建独立 `notalone_05_test`，通过 `NOTALONE_DATABASE_URL=postgresql:///notalone_05_test python -m notalone.database_migrations --migrations database/migrations` 应用 106 份迁移。`NOTALONE_TEST_DATABASE_URL=postgresql:///notalone_05_test python -m unittest tests.integration.persistence.test_cli_history_sync tests.integration.server.test_sync_api`：42 项通过。首次新库未迁移导致历史集成跳过，已纠正并实跑，不以跳过作为通过。
- `npm run typecheck`：通过。`npm test`：935 通过、1 跳过（共 936）；之后新增联系人实页断言和提示文案再跑相关视图/控制器/状态检查：19 项通过。
- 全量：`NOTALONE_TEST_DATABASE_URL=postgresql:///notalone_05_test perl -e 'alarm 600; exec @ARGV' -- python -m unittest discover -s backend/tests -t backend`：600 秒到期终止，未产出完整汇总；运行中出现失败标记，不能报告全量通过或给出可靠失败计数。日志留本机 `/tmp/notalone-05-python-full.log`。定位尝试 `python -m unittest tests.integration.memory_extraction.test_evaluation_ecnu -f -v`：83 项通过，未复现该模块失败；没有重新跑整套，也不据此声称全部失败均与本票无关。
- `dropdb notalone_05_test` 后查询 `pg_database` 确认剩余 0；未使用共享 `notalone_test`。全量既有用例自行建立的随机 `_test` 库沿用其自身清理流程。
- `git diff --check`：通过。提交后执行公共历史检查，结果随本地提交交付报告返回。

真实开发 App 只读检查（由主 Agent 通过 Computer Use / `@oai/sky` 执行，可按下列路径回放）：先 `npm run dev:status` 复用热更新实例；管理后台 → 联系人显示“启动遇到问题 / 数据库迁移账本或基线发生漂移 / 尚未连接”；点击“查看诊断”进入设置仍显示相同错误。只读诊断确认 `migration_history_mismatch`：已执行的 `104_cli_history_sync_state.sql` 校验和与仓库不同（账本 104 项、仓库 106 项）。未改业务库、配置或授权，未发送外部消息，无私人截图入库。

未完成/风险：启动门禁阻挡真实覆盖界面和微信读取，本票不能认证真实历史规模与恢复；真实只读验收继续由票 08 单独记录。回复生成门禁由票 06 实现，本票未改变生成资格。历史分页总量未知，仅展示已保存文字数与页数，不虚构百分比。超出 4 MiB 报告预算会明确状态读取失败，需要后续有界分页设计，不能静默截断。

给票 06 的共享文件：`backend/src/notalone/front_sync/cli_sync.py`、`desktop/src/main/sync/{status,controller}.ts`、`desktop/src/shared/sync-control-bridge.ts`、`desktop/src/renderer/{HistoryCoverageStatus,SyncControlPanel,ContactsPage,index}.tsx`。前端 `HistoryCoverage` 只含 bindingId/contactId/phase/failureCode/messageCount/nonTextCount/pageCount；缺失报告不等于完整。票 06 可复用展示类型，但后端生成必须独立复验持久状态，不能依赖桌面快照。
