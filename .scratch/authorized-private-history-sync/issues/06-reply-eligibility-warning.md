# 回复资格与历史覆盖不完整警告

Triage: ready-for-agent
State: resolved
Type: task
Blocked by: 03, 05

按 [spec](../spec.md) 与 [ADR-100](../../../architecture/adr/100-authorized-private-history-sync.md)，当前联系人历史未追平时不得静默生成回复。门禁必须在后端生成入口执行，不能只靠桌面禁用按钮；明确进入“不完整”状态后允许用户基于已同步部分继续，但请求前与请求证据都要保留警告。

## 验收

- [x] 当前联系人历史处于尚未开始或同步中时，默认阻止新候选生成。
- [x] 覆盖状态为明确“不完整”后，用户可选择基于已同步部分继续；生成前必须展示历史覆盖不完整，界面对话与请求证据都保留该警告，不声称完整语境。
- [x] 用户不选择继续时不生成；警告的消失只由覆盖状态变化驱动，不能靠关闭界面绕过。
- [x] 后端生成入口执行门禁，桌面提示与禁用状态同步；绕过桌面直接调用也不能静默生成。
- [x] 控制器、视图与接口测试覆盖阻止、明确继续与状态恢复三种路径。


## Comments

2026-10-23：按已确认的 ReplyService／HTTP、持久覆盖查询、桌面控制器和视图 Seam 做 TDD。先复现同步中仍生成，再补明确不完整确认、请求持久恢复、直接 HTTP 严格布尔参数、账号已授权但任务未创建窗口、多绑定 pending 优先、准备至执行的覆盖变化。旧账号授权无历史任务仍走原增量回复路径。每次执行读取持久状态，不用桌面快照作为后端证明。

两轴 code-review（基准 `16d103c8` 到本票工作树，先审后提交）：Standards 无阻断违规；保留两项非阻断建议（以后集中请求复制、覆盖返回类型复用枚举），本票不扩大重构。Spec 首轮发现连续修改继承旧轮确认，已修为新 continuation 独立携本次确认，只有同一冻结请求的重试／恢复保留原决定；复审通过。最终新增状态读取失败保留联系人已知覆盖、哈希请求另存快照警告，Standards 再次复核无硬问题。

## Answer

已完成后端生成门禁与桌面警告闭环。`PostgresReplyHistoryCoverage` 按 owner/contact 查询全部 active 微信绑定，存在历史任务或账号已授予当前历史版本才纳入；尚未开始／同步中优先阻止，明确不完整需 `allow_incomplete_history: true`。普通生成、prepare、execute、连续修改和重试均经 `ReplyService` 重验；账号已同意但任务尚未创建的窗口不放行。关闭同步不会把仍不完整的历史伪装为完整。

工作区和连续修改各自展示警告与本次确认，联系人／会话／覆盖状态变化清除临时确认；状态读取失败保留按联系人缓存的原警告。已保存请求、上下文快照、模型输入和助手对话保留固定警告，调用方的布尔确认不作为覆盖证明，不能自定义保存的警告正文；当前覆盖恢复完整只清除当前提示，不擦除过去请求的决定记录。后端拒绝有稳定原因与中文界面说明。

数据处理影响：只新增覆盖元数据读取及本次确认／警告记录，沿既有回复与助手会话删除路径保存。不扩大微信读取范围、模型用途、长期偏好或外部发送能力；未改业务数据库账本与迁移文件。

验证（Python/Node/npm 使用 `$HOME/miniconda3/envs/NotAlone/bin`；独立库 `notalone_06_test` 应用106份迁移）：

- 红→绿：服务同步门禁、明确继续、HTTP拒绝非布尔确认、请求持久化警告、覆盖持久查询、工作区禁用、状态读取失败保留原提示、新连续修改独立确认，均先看到对应失败再实现。
- `python -m unittest tests.unit.application.test_reply_service tests.unit.application.test_assistant_continuation tests.integration.server.test_reply_api tests.integration.persistence.test_cli_history_sync`：最终42项通过，含准备→执行状态变化、多绑定pending优先、无任务授权窗口与旧增量路径。
- `python -m unittest discover -s tests/unit/application -t .`：最初109项通过；将私有序列化单测换成真实PG公开存储接口恢复测试后，最终108项通过。
- `python -m unittest tests.integration.server.test_reply_api tests.integration.persistence.test_cli_history_sync tests.integration.server.test_assistant_session_api tests.integration.server.test_assistant_session_inputs`：63项通过。
- `npm run typecheck`：通过；`npm test`：最终939通过、1跳过（940项）。新增页面测试已登记为headless，首次未登记的调度失败已修正后完整重跑。
- `node --test tests/unified-workspace-view.test.mjs tests/workspace-session-switch.test.mjs`：9项通过；后续新增已保存对话恢复警告，控制器模块3项通过。
- `NOTALONE_TEST_CHROMIUM_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' node --test tests/history-reply-warning-view.test.mjs tests/workspace-session-switch.test.mjs`：5项通过，含工作区／连续修改显式确认、联系人切换、覆盖恢复、重开与历史对话警告。
- `NOTALONE_TEST_DATABASE_URL=postgresql:///notalone_06_test perl -e 'alarm 600; exec @ARGV' -- python -m unittest discover -s backend/tests -t backend`：600秒上限到期，进程终止，未获得完整汇总；期间有失败标记，不宣称全量通过，也无法可靠给出总失败数。日志 `/tmp/notalone-06-python-full.log` 留端侧。没有为赶进度扩大时限或重复全套。
- `dropdb notalone_06_test` 后查询 `pg_database` 确认剩余0；未主动创建或使用共享 `notalone_test`。全量既有用例自行建立随机 `_test` 库；终止后目录仍有多份随机库，但缺少运行前清单或逐库归属证据，未猜测删除，交主Agent记录残留核验风险。
- `git diff --check`：通过；公共历史检查在本地提交后执行。

真实开发 App 复验由主 Agent 持有桌面，通过 Computer Use `@oai/sky` 对 `com.github.Electron` 只读检查：`npm run dev:status` 为 development（最终宿主 pid 24193）；管理后台→联系人仍显示“启动遇到问题／数据库迁移账本或基线发生漂移／尚未连接”，联系人、添加、刷新均不可用。沿用05确认的 `migration_history_mismatch`，未改配置、业务数据、授权或账本，无外发。真实生成警告与微信全历史恢复无法实测，合成页面通过不等同真实App通过。

给票08：保持只读开发模式，先记录既有104迁移校验和阻碍；未经新任务决策不要修业务账本。06功能验收已由合成服务、HTTP、真实隔离PG与Chrome页面覆盖；真实规模、重启恢复、自定义账号和实机警告仍需在08单独记录实际可达范围。
