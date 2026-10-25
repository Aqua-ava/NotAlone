# Ticket 22 实施与 DSH 边界证据

日期：2026-10-25。实现基线：`b0d8c63033e02e5b5f3d2da7138e1709ec37969e`。

## 锁定 DSH 核验

- 版本：`@deepseek-ai/dsh@0.2.1-rc.2`；官方声明提交 `687f282e8625c6b8d11ff58211a90524be2e4317`。本机安装 manifest 实际报告同一版本。
- 固定源码入口：<https://github.com/deepseek-ai/deepseek-harness/tree/687f282e8625c6b8d11ff58211a90524be2e4317>；下文 `O:` 路径均相对该提交。
- 官方 profile：`O:docs/architecture.md:17,43` 与 `O:packages/boot/app-boot/src/profile.ts:7` 明确普通 Node 应用由命名 profile、有序 bundle／patch 组合启动。本票继续经现有 `host-plugin.ts` 接入，不另造启动器。
- Agent 生命：`O:packages/core/agent/README.md:32,47`、`O:packages/core/agent/src/index.ts:147`、`O:packages/core/agent/src/runtime-types.ts:183,191,202` 说明 handle 拥有 dispose，`cancel` 只协作式中止活动，`whenIdle` 是临时运行静止，`runMaintenance` 只占 Agent idle。它们均不提供 PostgreSQL 原子领取、租约、业务恢复或用户任务列表。
- 适配结论：本票不新增 DSH 直接 API、模型任务 Tool、Todo／计划或长期 session 恢复。DSH 只提供共享后台寿命和模型调用生命周期；任务真相仍完全由 PostgreSQL `background_task`／`background_task_step` 控制。停止先提交业务取消，再尽力中止本地匹配任务；晚结果仍由原 claim 的 scope、状态、worker、有效期限与 `lease_generation` 拒绝。
- 固定来源摘要：`package.json` `12bb41cd…`；`docs/architecture.md` `95a7722c…`；`packages/core/agent/README.md` `652a3283…`；`packages/core/agent/src/index.ts` `218b3022…`；`packages/core/agent/src/runtime-types.ts` `1ae0003c…`。当前 `backend-ts/pnpm-lock.yaml` SHA256 为 `bfcf83f9f210d5014177c08dcae98b0cd50d9b9f8a3c481794018c1fc8a92798`；本机 Node 为 `v24.22.1`。

## 任务类型与唯一责任方

| 类型／单元 | 步骤 | 当前唯一执行方 | 本票管理行为 |
| --- | --- | --- | --- |
| `import` | `parse → normalize → extract_memory → index → verify` | TS 任务模式：`ExtractionWorker` + `ExtractionTaskRunner`、索引 Runner；Python 模式：原 TaskHost。两模式互斥。 | 列表、实际步骤计数、停止、显式恢复原任务；保留成功步骤与来源。 |
| `observation` | `extract_memory → index → verify` | 同上；正文已由同步层保存，任务只消费冻结目标。 | 列表、实际目标计数、停止、显式恢复；绑定撤销后不可恢复。 |
| `layered_memory`，含 L2/L3 与本人 `contact_id=NULL` | `organize_memory` | TS 模式：同一个 `ExtractionWorker` 的 organization Runner；Python 模式：原 TaskHost organization Runner。 | 列表、预算／batch／job 状态、停止；恢复只走 settings generation、work revision 与领域 continue，不重置累计预算。 |
| `skill_learning` | `propose_skill → verify_skill_drafts` | TS 模式：同一个 `ExtractionWorker` 的 learning Runner；Python 模式：原 TaskHost。 | 列表、停止；恢复只走 receipt-aware `SkillLearningStore.enqueue(forceRetry)`，不重复已提交模型批次。 |
| `delete` | `mark_deleted → delete_derived → delete_index → clear_cache → verify_not_retrievable` | Ticket 17 接管前：原 Python SourceService／删除 Worker。通用任务面板不创建替代 Handler。 | 列表、停止、失败原因；恢复仍从来源删除面板发起，防止本票复制跨域删除闭包。 |
| `memory_upgrade` | 历史 `preview_upgrade` 等 | 无活跃执行方；ADR-070 已退役。 | 只显示历史状态，不提供停止／恢复以外的自动复活；Worker 不领取。 |
| `index`／`reindex` | import／observation 的 `index` 步骤 | 与所属任务同一 Worker。 | 不创建独立任务，不新增模型任务板。 |

## 实现边界

- 新 `background-task-management.ts` 只读同一 owner 范围，按联系人过滤时不混入本人任务；`scope=owner` 只返回 `contact_id=NULL`，本人停止／恢复也携带该范围，不能凭任务 ID 命中联系人任务。列表不调用业务 list、不 notify、不唤醒。
- 停止在固定范围锁内推进步骤代次；TS Worker 只中止当前同 task 调用，不停止共享 Worker。未知调用、删除／撤销和旧租约不能靠统一按钮清零或恢复。
- 桌面控制器严格校验闭集字段和 `scopeRevision`，迟到读取／旧连接／切换范围均不可写；“对方／待确认”使用当前联系人任务，“我”使用独立本人任务，两类列表不混用。任务面板显示步骤处理量和稳定错误码。
- 无 schema 迁移、无真实资料读写、无模型调用、无外部消息、无 App／微信、无打包或 push。

## 验证记录

- `backend-ts`：任务管理 5 项、任务存储 17 项、Worker 控制 4 项、旧任务 API 2 项，共 `27/27`。覆盖两领取者只成功一个、全局锁、跨 owner／contact 拒绝、本人范围不能停止／恢复联系人任务、列表无副作用、未知总量、停止幂等与旧完成拒绝、显式恢复保留成功步骤、Skill／L2/L3 停止不改授权。
- `backend-ts/test/host-http.test.mjs`：真实官方 DSH profile 及宿主生命周期 `11/11`，其中新增用例验证联系人／本人统一列表互不混入、本人动作跨范围失败、统一停止与恢复及 `ownership.taskManagement=typescript`。
- `backend-ts/test/unconfigured-tasks.test.mjs`：无模型来源删除五步与无关模型租约隔离 `1/1`；Python 原失败任务恢复、Skill 已保存草稿恢复各 `1/1`。
- 桌面：任务控制器 4 项、任务面板 2 项、既有导入／删除轮询 8 项、记忆接线 3 项、记忆进度 UI 13 项，共 `30/30`；后端和桌面 `tsc --noEmit` 均 0 错误。
- L2/L3 Python 集成单例未运行：该测试要求显式 `NOTALONE_TEST_DATABASE_URL`，本会话未提供；未改用默认库冒充。
- 合成 PG 库按夹具回收。发现三个无连接的测试残留库，核对后删除；最终 `notalone_ts_host_%_test` 查询结果为 none。
- 未运行实际 App／微信、真实模型质量、真实资料、打包或远端操作。TS 模式删除仍须 Ticket 17／24 处理原全局锁与 SourceService 切换。
