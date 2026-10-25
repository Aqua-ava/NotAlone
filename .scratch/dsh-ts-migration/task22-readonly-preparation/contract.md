# 22「全部业务后台任务管理」只读合同准备

日期：2026-10-24。只完成本角色的来源与合同准备；不表示 22 或主迁移验收通过。

## 来源、状态与核验边界

- `R:` 为生产运行源码固定点 `43ae208f3c4bc38116bfee62ed4665923674e682`；`M:` 为元数据固定点 `9ed7770d1a2cd74361d2b2adbeff78962b1e09e8`。相关源码已逐文件比对工作区实际字节，完整 SHA256、Git blob 与引用行号见 `source-manifest.json`。
- `O:` 为主任务指定的官方本机归档内相对路径，声明来源 commit `687f282e8625c6b8d11ff58211a90524be2e4317`，实际 package version `0.2.1-rc.2`。归档没有 `.git`；本轮核实际字节，不冒充重新联网验证 tag、仓库对象或发行构建可复现。
- 22 顶部仍为 `open`，依赖 10、13、14、15、20；五个前置顶部也为 `open`。本轮未修改这些状态。`M:.scratch/dsh-ts-migration/issues/22-background-task-management.md:3`、`:6`；`M:.scratch/dsh-ts-migration/issues/10-memory-extraction-verification.md:4`、`M:.scratch/dsh-ts-migration/issues/13-l2-scenario-organization.md:4`、`M:.scratch/dsh-ts-migration/issues/14-l3-profile-overview.md:4`、`M:.scratch/dsh-ts-migration/issues/15-skill-learning-review.md:4`、`M:.scratch/dsh-ts-migration/issues/20-history-gap-recovery.md:4`。
- 当前 HEAD 中后续离线评测工具、19 证据／状态，不改变上述运行源码固定点。任务状态、源码存在、旧测试名称均不等于 TS 业务任务验收。
- 仅运行只读文件／Git 查询、版本和哈希计算、本文引用检查。未运行产品、测试、DB、模型、网络、安装、App／微信、签名、打包、提交、push；未读取私人资料、凭据或 `.env`。只写本目录。

## 先核锁定 DSH 的交互边界

| 一手来源 | 核到的合同 | 对 22 的约束 |
| --- | --- | --- |
| `O:package.json:4`；`O:docs/architecture.md:17`、`:43`；`O:packages/boot/app-boot/src/profile.ts:7` | profile 按 bundle／patch 组合；受支持 Node 应用走命名 profile。 | 普通 TS 任务业务由现有薄插件装配；不另造任务 Harness 启动器，不改 DSH 核心。 |
| `O:packages/core/agent/README.md:32`、`:35`、`:47` | 官方 create／dispose／cancel／whenIdle 示例明确由 handle 拥有运行销毁权。 | 只用于语义调用的临时执行与退出；不是 PostgreSQL 业务任务表、任务领取或删除证明。 |
| `O:packages/core/agent/src/index.ts:147`、`:162` | dispose 停循环、等待退出、注销 Agent、移除 session 并清理作用域。 | 清理一个 Agent 不自动取消业务租约、擦除来源、重建索引或清除稳定 journal。 |
| `O:packages/core/agent/src/runtime-types.ts:183`、`:191`、`:202` | cancel 是活动的协作式中断；whenIdle 是全 Agent 静止；runMaintenance 只占当前 Agent idle 阶段。 | 均不提供业务任务的持久原子领取／崩溃恢复。不能把 runMaintenance 或 Agent 状态作为用户任务板。 |

02 的历史闭包记录 Node 24.19.0、pnpm 11.25.0、DSH 0.2.1-rc.2、650 个锁条目，锁 SHA256 为 `69fcd1a15fb734f9c58c2a241939db6fc003b3c10001a33ecb11f6bf6e5841c2`；见 `M:.scratch/dsh-ts-migration/runtime-validation/dependencies.json:2`、`:5`、`:7`、`:8`；五个发行包的接口 marker／固定源码交叉记录为 `M:.scratch/dsh-ts-migration/runtime-validation/interface-crosscheck.json:1`。02 只证明当时合成可行性；其 Answer 明确非产品任务持久恢复证明：`M:.scratch/dsh-ts-migration/issues/02-dsh-runtime-validation.md:57`。

本轮实际消费锁 `R:backend-ts/pnpm-lock.yaml:1` 的 SHA256 为 `bfcf83f9f210d5014177c08dcae98b0cd50d9b9f8a3c481794018c1fc8a92798`，精确二级 packages 条目 681 个、681 个带 integrity；实际已安装 DSH manifest 为 0.2.1-rc.2。当前锁与 02 历史闭包不同，不能沿用 02 数量／摘要冒充当前完整闭包重验。未安装或运行依赖。

结论：22 的状态、队列、租约、恢复、进度和确定性 handler 不涉及新的 DSH 直接 API；与 DSH 的接缝是共享后台寿命、语义调用取消／释放及业务提交资格。应沿官方 profile 和已有模型许可接缝装配，不新增模型计划 Tool、自治任务板或长期 session 恢复。目标依据：`M:.scratch/dsh-ts-migration/spec.md:50`、`:62`、`:69`、`:72`；`M:architecture/adr/102-dsh-typescript-backend-migration.md:9`、`:20`。

## 具名反向清单：入口到持久状态、handler 与执行者

原清单：`M:.scratch/dsh-ts-migration/baseline/behavior-matrix.md:104`。真实枚举只有六种：`R:backend/src/notalone/tasks/models.py:59`；其中五种仍有活跃路径，旧升级只保留历史清理。下表描述现状，不把表中映射写成已迁移。

| 类型／单元 | 当前公开或桌面入口 → 持久化 | handler／执行者 | 进度、停止与恢复资格 |
| --- | --- | --- | --- |
| `import` | `R:desktop/src/main/imports/controller.ts:164` 提交；`:250` retry、`:255` run、`:280` status → `R:backend/src/notalone/application/import_service.py:88` → `R:backend/src/notalone/persistence/postgres_repository.py:664` → `R:backend/src/notalone/persistence/background_tasks.py:76`。 | 固定 `parse→normalize→extract_memory→index→verify`，`R:backend/src/notalone/tasks/models.py:114`；parse／normalize 在 Worker 中是已保存消息的计数完成，非再次读入原文件，`R:backend/src/notalone/tasks/worker.py:560`。提取 `:700`，index `:605`，verify `:650`，Python TaskHost／CLI 进入同一 run_worker。 | task_id 幂等、成功步骤保留；HTTP retry 仅重排，run 才执行。来源进入删除路径即不再恢复。没有已核验的通用 task stop HTTP；不能把取消进度读取当作取消执行。 |
| `observation` | TS 已提交正文写 `R:backend-ts/src/sync-incremental-store-write.ts:30`、`:45` 的非正文 extraction receipt／schedule；`R:backend-ts/src/host-plugin.ts:67` 仅把稳定消息身份交 Python 事件入口。Python `R:backend/src/notalone/persistence/extraction_schedule.py:60`、`:90` 创建／合并原联系人任务。 | `extract_memory→index→verify`，`R:backend/src/notalone/tasks/models.py:125`；仍为 Python TaskHost `R:backend/src/notalone/application/import_service.py:221` 的定时调度与原 Worker；新增输入与当前轮分别处理，`R:backend/src/notalone/persistence/background_tasks.py:822`。 | 进度用登记目标与已完成批次，非步骤权重。撤销绑定、删除来源或旧租约拒绝晚结果；新消息不能恢复取消前未领旧目标。历史／缺口由 20 承接，不把消息已保存写成记忆任务完成。 |
| `delete` | `DELETE /api/contacts/{contact}/sources/{source}`，`R:backend/src/notalone/server/app.py:1805`；桌面 `R:desktop/src/main/sources/tracking.ts:21` → `R:backend/src/notalone/application/source_service.py:34` → `R:backend/src/notalone/persistence/source_tasks.py:62`。请求先隐藏来源、撤回回复、取消导入并清历史升级依赖，再幂等建原任务。 | 五步 `mark_deleted→delete_derived→delete_index→clear_cache→verify_not_retrievable`，`R:backend/src/notalone/tasks/models.py:136`。实际删除在 `R:backend/src/notalone/tasks/worker.py:545`，其余确定性核验；来源/副本残留不得成功。 | SourceService 独立 daemon Thread `R:backend/src/notalone/application/source_service.py:43`、`:51` 使用相同 Worker／全局锁；不是 TaskHost 登记线程。删除 API 可显式恢复失败原任务。无模型仍能执行五步，不可顺带重排无关模型租约。 |
| `skill_learning` | 桌面 `R:desktop/src/main/skill-learning/controller.ts:111`、`:279` → `R:backend/src/notalone/server/skill_learning.py:105`；配置授权／resume → `R:backend/src/notalone/application/skill_learning.py:80`、`:85` → `R:backend/src/notalone/persistence/skill_learning.py:86`。 | `propose_skill→verify_skill_drafts`，`R:backend/src/notalone/tasks/models.py:144`；`R:backend/src/notalone/tasks/worker.py:578` → `R:backend/src/notalone/application/skill_learning.py:113`。保存草稿事务复验原 claim、当前材料键、授权，`R:backend/src/notalone/persistence/skill_learning.py:137`；不自动发布。 | 有限重试／显式 resume；保存草稿后的 verify 失败沿原 receipt 恢复，不再次调用模型。disable、删除、材料／版本变化挡晚提案；111 租约授权和未知调用不能通过重试清零。注意 list 也会 notify 排队，非纯进度读取，见后文。 |
| `layered_memory`，联系人／本人 L2、L3、概览覆盖 | 联系人 `/api/contacts/{contact}/layered-memory/{action}` 与本人 `/api/memories/owner/layered-memory/{action}`；`R:backend/src/notalone/server/app.py:2244`；桌面本人 `R:desktop/src/main/memory/owner-layered.ts:161`、`:176`。`R:backend/src/notalone/application/layered_memory_service.py:203` → `R:backend/src/notalone/persistence/layered_coverage.py:50`、`:115`。 | 一条 `organize_memory` 驱动有限批次；`R:backend/src/notalone/tasks/worker.py:517` → `R:backend/src/notalone/application/layered_memory_service.py:245`；job／manifest／generation／累计预算与 L2/L3 receipt 分层保存。TaskHost 或 `R:backend/src/notalone/tasks/organization_dispatch.py:14` 的嵌入 Worker。 | pause／continue 明确 settings_generation＋work_revision，`R:backend/src/notalone/persistence/layered_coverage.py:62`；取消时推进 lease_generation，`:16`。不能把 dirty／refresh／重启当免费补预算或重新开启用户暂停；owner 的 contact_id 为 NULL，与联系人范围分别锁定。 |
| `memory_upgrade` 历史枚举 | 不迁移新创建／页面／IPC／HTTP／执行入口；`M:architecture/adr/070-automatic-memory-maintenance.md:14`。当前 server／Worker 支持步骤扫描没有升级执行 handler。 | 枚举和旧持久对象为历史兼容，非活跃能力；`R:backend/src/notalone/persistence/background_tasks.py:1421` 仅是资格 SQL，不能据此创建新 TS handler。 | 来源删除继续调用历史 `erase_memory_upgrades`，`R:backend/src/notalone/persistence/source_tasks.py:96`；不复活旧升级。 |
| 索引／重建 | 文档有抽象 reindex 模板，`M:architecture/adr/007-background-task-steps-and-worker.md:28`；真实模型枚举无 `reindex`，也未核到独立产品任务创建器。 | 现状是 import／observation 的 INDEX 步骤，`R:backend/src/notalone/tasks/worker.py:605` 调 `PostgresContactMemoryIndexRepository.rebuild`，VERIFY `:650`。 | 22 必须承接现有索引步骤与删除不可检索核验；不能凭设计模板增加新任务或宣称独立 reindex 迁移完成。 |

邻接运行单元也要核寿命，但不强行变成后台任务表：

| 单元 | 已核入口与寿命 | 移交边界 |
| --- | --- | --- |
| 候选生成／准备／继续／方向探索 | `R:backend/src/notalone/server/assistant_preparation_jobs.py:67` 内存 Job／线程，status／cancel `:124`，stop `:136`；探索 stop `R:backend/src/notalone/application/reply_exploration.py:262`；TS 实际模型运行 `R:backend-ts/src/host-reply.ts:26`、`:62` 持有 pending、取消信号并等物理结束。 | 05／07／08 的输入版本、来源与持久候选资格继续有效；准备 Job 不持久、不在重启后隐式续跑。Agent cancel 不等同物理调用已结算。 |
| 同步 host／tail／历史分页及缺口 | `R:backend-ts/src/sync-incremental-api.ts:13` 命令，`:56` 停收排空，`:78` close；写入 receipts 见上。旧 `R:backend/src/notalone/server/sync_host.py:225`、`:311` 为残余宿主生命周期。 | 18–20 的稳定绑定、授权、baseline、删除／撤销排除与停读独立于模型任务。22 管理呈现／恢复不得启用同步或扩大来源。 |
| 前台名称观察 worker | `R:backend-ts/src/foreground-location-probe.ts:29` close、`:35` dispose、`:47` abort、`:64` 60 秒闲置回收。 | 21 已迁移的原生 worker 归其原适配器；不改成任务模型、不作正文读取门禁、不读聊天正文／其他 App。 |

## 当前管理面与真实进度

| 入口 | 已核行为与不可混同事项 |
| --- | --- |
| `/api/tasks/status?contact_id=…&task_id=…` | `R:backend/src/notalone/server/app.py:2992` → `R:backend/src/notalone/application/task_service.py:27`，读取单一持久 task＋steps；没有 task_id 则 `TaskHost.current` 是进程内最近快照，不能作为全量任务清单或持久完成事实。 |
| `/api/tasks/retry`、`/api/tasks/run` | `R:backend/src/notalone/server/app.py:2927`；允许闭集字段、原 scope＋task_id。retry 仅支持失败 import/delete/observation，`R:backend/src/notalone/persistence/background_tasks.py:1041`、`:1081`；不是 layered／learning 的通用恢复器。 |
| 联系人／本人 `/memory-processing`、`/resume` | `R:backend/src/notalone/server/app.py:2645`；`R:backend/src/notalone/persistence/memory_processing.py:351` 明确 read-only，只投影 import／observation；completed／failed／stopped／interrupted 由持久状态、live lease、真实 Host 登记决定。`:464` 恢复仅原 task、有效来源，`resume` 与 cancelled 的 `restart` 分开，不执行其他任务。 |
| `task.progress` | `R:backend/src/notalone/server/event_models.py:160` 只携 task_id、step、实际数量、attempt/retry、error_code、failure_state_commit；`R:backend/src/notalone/server/command.py:494` 发布。事件是通知，回读持久态；`failure_state_commit=unknown` 不得用 idle／100% 覆盖。 |
| 真实聊天处理量 | `R:backend/src/notalone/persistence/memory_processing.py:371` 按 target completed/skipped/unknown 计数；`M:architecture/current/core-flows.md:398` 区分处理聊天数与生成记忆数，缺可靠分母显示未知。 |
| 停止 | 当前 task API 没有通用 stop；领域上有 layered pause、learning disable、来源删除取消派生、宿主停机。`M:architecture/current/domain-data.md:110` 仍写 v1 不提供用户取消入口，而 22 的交付要求停止；需在实现前明确各类型可用动作及删除收尾语义，不能发明现有成功基线。桌面的 `cancelProcessingRead` 只中断读取，`R:desktop/src/main/memory/processing.ts:74`。 |

## 领取、恢复与晚结果合同

1. **原子身份与锁**：`R:backend/src/notalone/persistence/background_tasks.py:570` 先取范围事务锁并处理失效租约，再检查有效 running；`:640` 选允许任务／步骤和前序成功，`FOR UPDATE OF task, step`，`:708` 同事务写 worker_id、attempt、lease_generation 与 lease_expires_at。锁序 contact→owner，`R:backend/src/notalone/persistence/locks.py:1`。不能把 task_id、DSH session 或昵称当隔离键。
2. **两层排他不同**：`R:backend/src/notalone/tasks/command.py:77` 的 session advisory 全局 Worker 锁＋原 task 固定，和联系人／owner 范围的步骤租约是两层合同。当前允许同后台有限模型并发不等于不同联系人任务已放开并行；22 不能顺手移除全局锁。
3. **完成与失效**：`R:backend/src/notalone/persistence/background_tasks.py:1266` 完成／续租前核 task 状态、来源／绑定、worker_id、有效期限、lease_generation，`:786` 原子保存完成并决定下一步／最终 verify。`R:backend/src/notalone/tasks/worker.py:770` stop 或 claim 失效不写成功；重复／旧轮次同 worker_id 也不能写回。
4. **语义处理心跳和停止**：`R:backend/src/notalone/tasks/worker.py:125`、`:177` 续租；外部 stop 停心跳，`:808` 尝试 pause 原步骤。`R:backend/src/notalone/application/import_service.py:329` 停新工作、最多 4 秒等线程并关其持有的全局锁连接；无法中断调用由原租约和未知调用语义收尾，不能宣布业务成功。
5. **有限重试**：最多三次自动尝试；`R:backend/src/notalone/tasks/command.py:204` 只对 retryable 退避。失败原 task 的显式恢复保留成功步骤、重置当前轮尝试，`R:backend/src/notalone/persistence/background_tasks.py:1041`。读取不是恢复授权；模型额度／调用收据不得清零。
6. **前台优先**：当前跨 TS／Python 由共享 ModelPermit 仲裁；`R:backend-ts/src/model-permits.ts:89` 等已在途后台结算后优先发前台、前台整轮期间不给后台，后台上限由构造配置。取消／HTTP 断连不释放已授容量（`:6`）。默认 Python 模式及配置分支仍需按宿主核，不能把两套独立限流称全局等价。
7. **删除／撤销／版本晚结果**：业务事务复验在每个 handler／存储层继续保留，不能只在领取时查一次；学习 `R:backend/src/notalone/persistence/skill_learning.py:137`、分层取消 `R:backend/src/notalone/persistence/layered_coverage.py:16`、导入来源与观察绑定 `R:backend/src/notalone/persistence/background_tasks.py:1266`。单一 Agent dispose 不能替代这些资格。

必须分开保留以下四类事实；不以其中任何一个推断其他事实已成功：

| 事实 | 权威持久边界 | 对恢复的影响 |
| --- | --- | --- |
| 学习 claim 授权 | `R:backend/database/migrations/111_model_call_learning_claim.sql:7`，无正文 attempt＋scope＋task＋step＋worker＋lease_generation，唯一 `(step_id,lease_generation)`。`R:backend-ts/src/host-model-accounting.ts:121`、`:140` 原事务校验／写入。 | 只证明真实租约获一次物理发送授权，不证明模型结果、草稿保存或任务完成；重试不能清累计收据。 |
| 请求 receipt | `R:backend/database/migrations/110_model_call_receipt.sql:3`；attempt／request／permit、dispatch、outcome、预算与成本。 | pending／unknown 阻止同请求盲重放；`R:backend-ts/src/model-ledger.ts:124`。迟到同真实 attempt 的结算不自动放行其业务写入。 |
| 旧调用台账 | `R:backend/database/migrations/010_outbound_ledger.sql:1` 的 outbound_ledger_entry，UUID 不重写；`R:backend-ts/src/model-ledger.ts:76` 是可确认物理调用的旧投影。 | 不能用台账一行反推任务成功、来源仍有效或 consumer 收到 ACK。 |
| 稳定 journal／consumer ACK 未知 | `R:backend-ts/src/model-permit-journal.ts:98` 只有确认旧宿主与旧 worker 消失才把 active 变 unknown；`R:backend-ts/src/host-model-accounting.ts:98` 合并 orphan/journal；Python `R:backend/src/notalone/application/model_transport_accounting.py:140` 丢失结果 ACK 后仍保留未确认。 | conservative unknown 的 ACK 只确认清理写入（`:155`），不能代签丢失结果 ACK。`R:backend/src/notalone/persistence/background_tasks.py:1446`、`:1457` 合并 receipt／trace ledger ACK／可信宿主未确认集合，恢复资格不以新进程、过期租约或窗口关闭替代。 |

## Worker 移交寿命与尚未解开的接缝

当前 `R:backend-ts/src/legacy-backend.ts:10` 明列 `tasks:'python'`，`:123` 将 tasks 等公开路由交旧后台；`R:backend/src/notalone/server/app.py:101` 引用 Python TaskHost，类在 `R:backend/src/notalone/application/import_service.py:151`。未核到 `backend-ts/src/task-host.ts`，不能引用不存在的 TS 类签收。

迁移必须覆盖四个旧入口：TaskHost、SourceService daemon、EmbeddedOrganizationDispatcher、注册 CLI `R:backend/pyproject.toml:34`、`:35`。它们可共享 Worker/global lock，不能由“同进程一个类”推导唯一执行者。尤其 SourceService 无 stop 方法、其 Worker 没有 TaskHost stop_event；只停 TaskHost 不证明删除线程已退出。

待前置业务验收后，移交最小顺序应为：停止旧接收／排队／定时唤醒 → 排空或明确中断四类执行入口 → 核具体进程身份、全局锁、有效步骤租约与 model pending/unknown → 保留业务范围、成功步骤、原 receipt/journal、编辑／删除决定 → 明确开放唯一 TS handler／写入方 → 经公开入口读回、再核旧入口不能执行。这里是验收合同，未在本轮实施。

宿主现有收尾依据是 `R:backend-ts/src/host-plugin.ts:104` 增量→范围／资料门禁→模型／Python→存储；`R:backend-ts/src/host-model-runtime.ts:57` 先恢复 unknown 再起 Python 队列，`:89` 停收并等两侧实际 SDK；`R:backend-ts/src/legacy-backend.ts:111` 受控 shutdown／SIGTERM／6秒后SIGKILL。不能改为先擦稳定 journal 或仅丢临时 DSH home。任务 handoff 未验证，旧关闭代码不是 TS Worker 完成证明。

仍需解决并由实际行为验收，而非本轮选择或修复：

- **重启恢复冲突**：`R:backend/src/notalone/application/import_service.py:221` 在模型能力可用时起调度器；`R:backend/src/notalone/persistence/extraction_schedule.py:115`、`:134` 会发现有效来源／绑定下 queued/running/verifying 的 import／observation。旧测试也明示 startup recovery：`R:backend/tests/integration/server/test_persistent_extraction_schedule.py:18`。这与 `M:architecture/current/core-flows.md:394`、`:400`、`M:architecture/adr/038-import-triggered-memory-work-and-reply-priority.md:11` 的“不扫重启前旧队列／显式继续”有出入；10／20／22 必须收敛范围，禁止凭文档假定现状。
- **读取唤醒差异**：`R:backend/src/notalone/application/skill_learning.py:75` list 调 notify→enqueue／wake，而 memory-processing GET 明确只读。分层维护也有自身 change feed／pending 恢复。目标任务列表若承诺只读，应接纯状态投影，不能复用会唤醒的业务 list 并悄悄改变授权。
- **管理覆盖缺口**：当前是任务详情、记忆进度、学习、分层、来源删除几个管理面；memory-processing 只接受 import／observation，前端 `R:desktop/src/main/memory/processing.ts:38` 也闭集校验。没有已证统一全部类型列表／动作；22 要新增合同适配时保留各领域资格，不能把新的学习／分层 task_type直接喂旧投影。
- **无模型不是已 TS 化**：`R:backend/src/notalone/server/command.py:427` 只装 DELETE 五步并过滤可执行步骤；`R:backend/src/notalone/application/import_service.py:211` 和 `R:backend/src/notalone/application/task_service.py:35` 在模型管理写前拒绝。`R:backend-ts/test/unconfigured-tasks.test.mjs:16` 实际启动 Python fixture，证明的是过渡边界，不是 TS Worker。
- **本人整理事件接缝（静态推断）**：`R:backend/src/notalone/server/command.py:500` 事件发布仍用 ContactScope；本人任务 contact_id=NULL 与 `R:backend/src/notalone/scopes.py:16` 的 UUID 校验冲突，`R:backend/src/notalone/application/import_service.py:589` 会吞发布异常。因此不能以联系人 task.progress 证明本人任务事件完整；需实测 owner 管理面的轮询／事件。SourceService 独立 Worker 也未传 progress_callback，现有删除进度靠持久轮询，不能虚构统一实时事件。
- **状态更新与副作用提交分离**：handler 已提交但步骤 ACK 失败、trace 写失败且失败状态 ACK unknown、模型结果已收而账本 ACK 未知，恢复必须按各原 receipt／资格处理，不能全都改成 retryable、重复模型或直接 succeeded。

## 解锁后的具名最小纵切与验收

以下均为准备合同，不提前执行 22，不建立临时替代 Worker。最小第一条为 **「无模型来源删除原任务五步及失败原位恢复」**；它最少牵涉语义依赖，仍须等 22 前置验收，不借此绕依赖。

| 纵切 | 经现有入口观察的交付结果 | 所需针对性竞争／故障 |
| --- | --- | --- |
| A 无模型来源删除五步 | 由桌面来源删除 → DELETE sources → 幂等原 task_id → TS 唯一 worker → 五步 → tasks/status／来源清单 → verify_not_retrievable；失败显式恢复保留成功步骤；其他同范围模型任务字节／租约不变。 | 两领取者、global lock busy、删除派生／副本清理失败、过期租约、同 worker 旧 generation、停止时无假成功。 |
| B import／observation 提取和索引 | commit／同步已保存消息 → 固定原 task → 10 的 TS handler → index／verify → 非正文 task.progress → memory-processing 实际目标统计。 | 新批次在途、重复事件、trace/ACK失败、来源删／绑定撤销、前台等待期间失效、显式恢复不扩大来源。 |
| C L2／L3 覆盖管理 | 联系人／本人 enable／refresh／pause／continue → 原 job＋generation＋累计预算＋覆盖 receipt → TS handler → 两层结果与进度。 | pause／disable→reenable ABA、未来批次来源删除、L2 已提交 L3 失败、显式 continue 增量额度、旧 receipt／old worker 晚结果。 |
| D Skill 学习草稿管理 | 独立授权 → 原任务 propose／verify → 未运行草稿 → 原审核入口；status／允许恢复展示真实原因。 | 111 已消费 claim、新旧租约、同 request unknown、已保存草稿 verify 失败零二次模型、disable/删除/版本变化、无模型拒绝写前不排队。 |
| E 宿主／邻接作业收尾 | 共享前台优先／后台上限、pending实际调用排空、同步／原生 worker 停读、旧四入口无法执行、唯一 TS owner。 | 崩溃、宿主身份未知、orphan permit、journal unknown、consumer ACK unknown、临时 profile 清理、回退拒绝、非合作调用。 |

静态核实的可运行入口如下；本轮全部 **未运行**。Python 与若干 backend-ts 测试会创建合成 PostgreSQL 库；只在已授权开发验证阶段、有依赖及隔离 PG 时使用。旧测试运行通过也只能证明旧合同，需再换成实际 TS 管理／handler 和桌面入口，不能只换返回值或测试替身签收。

```sh
# 从仓库根执行；独立合成库，当前仍调用Python Worker
cd backend-ts && node --test --test-name-pattern='无模型的共享来源删除完成五步' test/unconfigured-tasks.test.mjs 2>&1 | tail -60
# 原HTTP失败任务：fixture自行建/销毁*_test库
cd backend && PATH="$HOME/miniconda3/envs/NotAlone/bin:$PATH" python -m unittest tests.integration.server.test_failed_task_recovery.FailedTaskRecoveryHttpTest.test_http_recovers_original_failed_task_and_skips_successful_steps -v 2>&1 | tail -60
# 纯进度读取与显式恢复：同样是原Python合同
cd backend && PATH="$HOME/miniconda3/envs/NotAlone/bin:$PATH" python -m unittest tests.integration.server.test_memory_processing_progress.MemoryProcessingProgressHttpTest.test_progress_read_is_inert_and_resume_survives_host_restart -v 2>&1 | tail -60
# 学习已保存草稿verify失败，不重做模型
cd backend && PATH="$HOME/miniconda3/envs/NotAlone/bin:$PATH" python -m unittest tests.integration.server.test_skill_learning.SkillLearningHttpTest.test_saved_draft_verification_failure_resumes_without_second_model_or_duplicate_draft -v 2>&1 | tail -60
# L2/L3原覆盖工作与预算暂停
cd backend && PATH="$HOME/miniconda3/envs/NotAlone/bin:$PATH" python -m unittest tests.integration.server.test_layered_memory_management.LayeredMemoryManagementHttpTest.test_task_host_restart_resumes_authorized_queued_work_and_keeps_budget_pause -v 2>&1 | tail -60
# claim、111结构、稳定journal恢复的已有聚焦入口；不是TS任务接管测试
cd backend-ts && node --test test/model-task-claim.test.mjs test/model-call-learning-claim-migration.test.mjs test/model-mode-recovery.test.mjs 2>&1 | tail -60
# 生产桌面控制器的页面夹具；不是实际App/微信验收
cd desktop && npm run test:pages -- --case memory-processing --timeout-seconds 180 2>&1 | tail -60
cd desktop && npm run test:polling 2>&1 | tail -60
```

每行 cd 命令以仓库根为起点独立执行。入口依据：`R:backend-ts/test/unconfigured-tasks.test.mjs:16`、`R:backend-ts/test/host-storage-fixture.mjs:7`；`R:backend/tests/integration/server/test_failed_task_recovery.py:66`、`:237`；`R:backend/tests/integration/server/test_memory_processing_progress.py:10`；`R:backend/tests/integration/server/test_skill_learning.py:291`；`R:backend/tests/integration/server/test_layered_memory_management.py:473`；`R:backend-ts/test/model-task-claim.test.mjs:13`；`R:backend-ts/test/model-call-learning-claim-migration.test.mjs:11`；`R:backend-ts/test/model-mode-recovery.test.mjs:14`；`R:desktop/scripts/test-pages.mjs:33`、`:38`；`R:desktop/package.json:14`。

租约并发的单用例还可用 `tests.integration.tasks.test_worker.BackgroundTaskWorkerTest.test_active_lease_blocks_second_worker_and_expiry_allows_takeover`（`R:backend/tests/integration/tasks/test_worker.py:276`）；它依赖 `NOTALONE_TEST_DATABASE_URL` 指向已迁移专用 `_test` 库（`:46`、`:154`），未准备该条件不得用默认连接冒充执行成功。撤销／同 worker 旧租约回写在 `R:backend/tests/integration/tasks/test_observation_task.py:240`、`:248`、`:359`。

完成 22 时还须经实际开发 App 逐类操作状态、原因、停／允许恢复、退出重启与删除竞争；先核验复用 `npm run dev`，本任务不启动、不打包。页面夹具、真实模型、App／微信分别记证；不以旧成功结果代签新实现。数据影响预期为元数据与执行职责等价迁移，资料正文／授权／删除决定不能扩大或回滚。
