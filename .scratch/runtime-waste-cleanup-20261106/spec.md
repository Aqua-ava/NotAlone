# 运行时浪费清理：读取目标增长、删除查询、备份占用与自证式校验

Triage: ready-for-agent
State: resolved（2026-11-07：四张任务与全部后续小任务收口，结案摘要见下）

> 来源：2026-11-06 对"是否有不必要的防御性代码、哈希与性能浪费"的只读排查，以及同日 `docs/verification/deletion-and-sync-status-perf-20261106.md` 的测量。
> 本规格拆成 4 张任务（见下表），每张任务可由独立 Agent 在新上下文中完成。**先读完本文件的"全局规则"，再读你负责的那一张任务。**

## 结案摘要（2026-11-07）

| 任务 | 收口 | 交付 | 验证报告 |
| --- | --- | --- | --- |
| 01 read_goal 增长 | issues/01 的 `## Answer`（阶段 A `3b69f2497`／阶段 B 复用 `c84f90940`＋空探针扩展 `b25e44c46`） | 重启点火→自续循环归因；同身份 complete 空目标同行重验复位，行数不滚大、读取频率保持 | [read-goal-churn-attribution-20261106.md](../../docs/verification/read-goal-churn-attribution-20261106.md)、[read-goal-reuse-phaseb-20261107.md](../../docs/verification/read-goal-reuse-phaseb-20261107.md)、[read-goal-empty-probe-attribution-20261107.md](../../docs/verification/read-goal-empty-probe-attribution-20261107.md) |
| 02 删除反查 | issues/02 的 `## Answer`（`995e4b3a7`；真库应用批准后完成，记录 `d4962fec0`） | 迁移 43 `message_alias_message`＋capture_record 精确查找；plan P50 63.8 s→0.19 s；黄金集逐项一致 | [migration-43-application-20261107.md](../../docs/verification/migration-43-application-20261107.md) |
| 03 备份清理 | issues/03 的 `## Answer`（盘点 `9be678598`；两轮执行 `6f853af1c`／`9341fce9f`） | A–F 分类与 R1–R8 提案；批准的 25 项已入废纸篓（8.29 GB＋3.38 GB，实际释放待清空废纸篓） | [backup-inventory-20261106.md](../../docs/verification/backup-inventory-20261106.md) |
| 04 自证清理 | issues/04 的 `## Answer`（`8d2b0c369`/`6685e7d9c`/`588affa27`/`e70bbfe19`/`26fa0fde4`） | A1–A3 重构＋A4 语义锁测试＋B1–B4 分析 | [self-verification-review-20261106.md](../../docs/verification/self-verification-review-20261106.md) |

后续批准的小任务：`.scratch/bundle-build-probe-whitelist-simplify/`（B1 简化，`99e891c84`）、`.scratch/read-goal-empty-probe-loop/`（空探针轮＋lost 路径，`b25e44c46`）、`.scratch/fence-origin-attribution/`（围栏本源只读调查，`84c72f1d2`，0/100 未复现结案）。工具修复：`check_public_history` 对象闭包超 512 MB 的分批化（`c7be7c79f`）。

留待用户裁决/另立任务：handoff 行（pages≥1 空页）复用扩展；`desktop/tests/helpers/probe.test.mjs` 既有失败（另有调查任务）；`Cache/` 清理时机（R7）；`before-bulk-contact-delete-20261107.sqlite` 的 R5 登记（由批量删除任务收尾补）；`.scratch/fence-origin-attribution` 观察到的 arm/释放竞态围栏写入点（未定）。

**对原始旧结论的更新**：阶段 A 推翻了"每小时 1 万行无界增长"——空闲 certified-absent 联系人循环为 0 新增（见上文勘误）；02 的删除闭包语义与目标集合未变（4.3 万消息夹具黄金集 12,008 行逐项一致证明）。

## 结论先行

1. **哈希不是性能问题。** 源码里有 84 处 `createHash`，但实测开销很小：sha256 5 MB 约 1.6 ms、40 MB 约 13 ms；`policy-version` 的 `assertCurrent`（每次重读并哈希源码依赖树）约 5 ms/次；SQLite `synchronous=FULL` 每次写事务 0.043 ms（`NORMAL` 为 0.008 ms）。哈希带来的主要是**代码复杂度**，不是 CPU。
2. **真正的运行时浪费在数据库查询和数据增长上**：删除联系人要 246–645 秒、同步状态要 5 秒以上，原因是无索引的反查与 `read_goal` 行数增长，而不是哈希。
3. **磁盘占用 22 GB**，其中 `backups` 14 GB（`backups/sqlite` 20 份备份共 13 GB）。这些备份不是产品代码生成的，是历次开发 Agent 留下的"改动前快照"，没有保留策略。

## 已核对的事实（2026-11-06 23:28 本机，只读取聚合计数）

| 项目 | 数值 | 获取方式 |
| --- | --- | --- |
| 真实库 `managed/sqlite/notalone.sqlite` | 3051 MB，schema 版本 42 | `ls`、`SELECT max(version) FROM schema_migration` |
| `read_goal` 行数 | **40,497**（诊断文档 14:18 时为 279,909） | `sqlite3 -readonly` |
| `read_goal` 按状态 | incremental/invalidated 15,286；history/complete 13,616；history/invalidated 8,917；history/running 2,411；incremental/running 267 | 同上 |
| 最近每小时新增 `read_goal`（本地时间） | 12 点 550；14 点 468；15 点 2,280；17 点 1,109；**18 点 15,688；19 点 11,624**；21 点 18；22 点 399；23 点 219 | 同上 |
| 18、19 点突发的失败码 | `history_runtime_revalidated`（history/incremental 目标被置失效）、`history_snapshot_replaced`；237 位联系人参与，单人最多 127 行/2 小时 | 同上 |
| `message_alias` / `capture_record` / `message` 行数 | 366,406 / 369,100 / 346,567 | 同上 |
| `message_alias WHERE owner_id=? AND message_id=?` 查询计划 | `SEARCH ... USING INDEX sqlite_autoindex_message_alias_2 (owner_id=?)`：只用到 `owner_id` 前缀，等于扫整个 owner 分区 | `EXPLAIN QUERY PLAN` |
| `capture_record WHERE owner_id=? AND message_id=?` 查询计划 | 同样只用 `(owner_id=?)` 前缀；已有的 `capture_record_message(owner_id,contact_id,message_id)` 因查询缺 `contact_id` 无法使用 | `EXPLAIN QUERY PLAN` |
| 库内统计表 | **无 `sqlite_stat1`**；`backend-ts/src` 里没有 `ANALYZE` 或 `PRAGMA optimize` | `sqlite_schema` 查询、`grep` |
| 数据目录总量 | `~/Library/Application Support/NotAloneDesktop` 22 GB：`backups` 14 GB、`managed` 6.9 GB（`media` 3.9 GB、`sqlite` 3.0 GB）、`Cache` 1.2 GB；另有同级 `NotAlone-consolidation-20261031.M61JMC` 2.9 GB | `du -sh` |
| 根卷空闲空间 | 54 GiB（总 228 GiB） | `df -h /` |

### 与 14:18 诊断文档的差异（执行前必读）

诊断文档把 `read_goal` 写成"约每小时 1 万行的无界增长"。**这一判断已不能直接沿用：**

- 当天 14:25（`bbe43446a`）、15:09（`63cd07410`）已有提交扩大 `purgeStaleGoals`（`backend-ts/src/history/sqlite/goal-retention.ts`）的清理范围，`read_goal` 已从约 28 万行降到约 4 万行。
- 现在空闲时的新增速度约每小时 200–400 行，**不是**每小时 1 万行。
- 但 18、19 点仍出现两次各 1 万余行的突发，主要失败码是 `history_runtime_revalidated`。读 `continuity.ts:197` 可知：当后台运行时 id（`runtime_id`）与联系人守卫租约里的不同，就会把该联系人的 history／incremental 目标置失效并重建。**开发热更新每次重启后台，都可能对 237 位联系人各触发一轮。** 这只是与代码相符的推测，尚未用时间线证实。
- 因此任务 01 的第一步是**重新测量并归因**，不能直接"停掉空探测"。

## 任务清单

| 编号 | 文件 | 目标 | 类型 | 依赖 | 是否改真实数据 |
| --- | --- | --- | --- | --- | --- |
| 01 | [issues/01-read-goal-churn.md](issues/01-read-goal-churn.md) | 归因并抑制 `read_goal` 突发增长 | 先研究后实现 | 无 | 否（只读测量） |
| 02 | [issues/02-deletion-lookup-indexes.md](issues/02-deletion-lookup-indexes.md) | 修复删除路径的无索引反查 | 实现 | 无（与 01 共用迁移版本号，见全局规则） | 实现阶段否；**应用到真实库需用户批准** |
| 03 | [issues/03-backup-retention.md](issues/03-backup-retention.md) | 备份盘点、保留策略与受控清理 | 盘点＋人工审批 | 无 | **删除需用户逐项批准** |
| 04 | [issues/04-self-verification-cleanup.md](issues/04-self-verification-cleanup.md) | 合并重复哈希封装、去掉确认冗余的重复校验 | 分级重构 | 无，但改动文件分散，**不要与其他改 `backend-ts/src` 的 Agent 并行** | 否 |

建议顺序：**02 与 03 最独立且收益明确，可先行；01 先做研究阶段；04 最后做**（收益最小，主要换可维护性）。

## 全局规则（所有任务共用，必须遵守）

### 阅读顺序

1. 根 `AGENTS.md`（产品硬边界、通用规则）。
2. `docs/agents/workflow.md`、`docs/agents/engineering.md`（环境、验证阶梯、Git 规则）、`docs/agents/domain.md`、`docs/agents/scaling-and-data-lifecycle.md`（删除、来源核验、增长检查）。
3. 你那张任务点名的 `architecture/current/*.md` 章节。文档只整读一次，之后用 `rg -n` 和 `sed -n` 定位。

### 真实数据红线

- 真实库路径：`~/Library/Application Support/NotAloneDesktop/managed/sqlite/notalone.sqlite`。**只允许 `sqlite3 -readonly` 或 `file:...?mode=ro` 读取聚合计数、表结构和查询计划**，不读取消息正文、联系人名称或昵称；联系人只用 ID 前 8 位。
- 需要执行写操作、迁移、删除动作或启动 App 的实验，一律在**隔离副本**上做：`sqlite3 -readonly <真实库> ".backup '<副本路径>'"`，副本放在你自己的临时目录，不进仓库；用完删除并核对已删除。复制前确认可用空间不少于 15 GiB（`engineering.md` 的开发磁盘规则），当前 54 GiB。
- 副本上打开存储时用 `SqliteStorage.open({... intent:'open', expectedDatabaseId:<副本里 database_instance.database_id>})`；不要对真实库调用 `intent:'create'` 或 `upgrade`。
- **不得用开发 App（`pnpm run dev`）或任何会打开真实库的进程来验证本规格里的改动。** 迁移在打开时执行，版本升到 43 之后旧代码会报 `schema_too_new`，不可回退。要把迁移应用到真实库，必须先取得用户在对话中的明确批准，并先确认磁盘空间和一份仍然有效的备份。
- 桌面验收按 `engineering.md` 的"桌面验收"，使用独立 `--user-data-dir` 和合成数据；发布／打包任务不属于本规格。

### 工作树红线

开始时 `git status` 已有用户的未提交改动，**不得改动、暂存或提交**：

- `architecture/adr/README.md`
- `backend-ts/test/sqlite-memory-adjudication-evidence.test.mjs`
- `desktop/src/renderer/SqliteMemoryManagementPanel.tsx`
- `desktop/tests/sqlite-memory-management-view.test.mjs`
- `docs/verification/deletion-and-sync-status-perf-20261106.md`（未跟踪）

提交只用 `git add <精确路径>`，不用 `git add -A` 或 `git commit -a`。

### 迁移版本号协调

当前注册表最后一个迁移是 42（`backend-ts/src/storage/sqlite/registry.ts:83`）。**任务 02 占用版本 43。** 任务 01 若也需要迁移，必须在 02 合并后使用 44；两张任务不得同时抢同一版本号。测试里写死了版本数的地方（例如 `backend-ts/test/sqlite-memory-auto-switch.test.mjs:115` 的 `schemaVersion,42`）由引入迁移的任务更新；其他任务发现这类断言失败时先 `git log` 确认是否已有迁移合入，再决定是否重新对齐。

### 验证阶梯

照 `engineering.md`：先单用例（`node --test --test-name-pattern=... test/X.test.mjs`）→ 再相关文件 → 影响面需要时才全量 `npm test`。macOS 无 `timeout`，用 `perl -e 'alarm 600; exec @ARGV' -- <命令>`。输出裁剪必须保留退出码：`(set -o pipefail; <命令> 2>&1 | tail -60)`。夹具只用合成数据。

### 性能工作的证据要求

照根 `AGENTS.md`"性能优化"：先测量瓶颈，用**同一工作负载**比较前后，报告数据和取舍。**没有可测收益的改动要如实写"无可测收益"，不得宣称提速。** 基准脚本放 `backend-ts/scripts/perf/`（参照已有的 `image-sync-query-baseline.mjs`），夹具用确定性合成数据。

### Git

- 完成并通过最小相关验证后，自动创建**只含本任务变更**的本地提交；一个提交一个主题。
- 标题中文；正文用 `1、2、3、4` 列 3–5 条改动、边界和真实验证结果。
- **提交信息末尾不要加 `Co-Authored-By` 或 `Generated with Claude Code` 一类署名行。**
- 提交后运行 `node scripts/check_public_history.mjs --ref HEAD --working-tree`，区分既有命中和本次引入的命中。
- **任何 `git push`、强制推送、远端分支或 Pull Request 都要先取得用户明确同意。**

### 任务状态与交付格式

照 `docs/agents/issue-tracker.md`：开始前把任务文件的 `State:` 从 `open` 改为 `claimed`；完成条件是在文件底部写好 `## Answer`（结果、实际命令、数据影响、剩余风险）并把 `State:` 改为 `resolved`。需要用户判断的点把 `Triage:` 改成 `ready-for-human` 并在 `## Comments` 写明问题，不要自行越过。

### 决策模式（何时必须停下问用户）

- 要改的行为超出任务点名范围，或需要改变产品硬边界（联系人隔离、来源与删除路径、不自动发送、授权范围）。
- 需要对真实库做任何写操作、迁移、删除，或删除任何备份文件。
- 发现某项"防御性校验"其实承担删除证明、来源核验、`owner_id + contact_id` 隔离或跨进程完整性——**保留，并在报告里说明理由**。

## 不在本规格内

- 模型网络速度、DSH 行为、候选回复质量、记忆抽取质量。
- 把 `synchronous=FULL` 改成 `NORMAL`：实测每次写事务只差 0.035 ms，不值得放宽持久性保证。
- 删除后的压缩（`VACUUM` ＋ 全库校验约 73 秒）改成异步：与"结案前必须完成 SQLite 压缩"的规格冲突，需另行修改规格后再议。
- 删除流程里"计划、领任务、重新收集"三次重复收集目标（约 68 秒）：触及删除闭包稳定性协议，风险高，先看任务 01、02 的收益再决定是否另立任务。
- 同步状态按联系人缓存（诊断文档方案 F）：缓存失效规则易出陈旧状态，先看任务 01 后 `/api/sync/status` 是否已降到可接受。

## 附带待测（未编号，有余力的 Agent 可测量后在任务 01 的 Comments 里报告）

每次打开已有库都会跑 `PRAGMA quick_check` 和 `PRAGMA foreign_key_check`（`backend-ts/src/storage/sqlite/worker.ts:57-61,85,100`，打开预算 `sqliteOpenTimeoutMs=60_000`，见 `storage/sqlite/timeouts.ts`）。在 3 GB 库上的实际耗时没有测过。方法：在隔离副本上分别计时这两个 PRAGMA，报告耗时与占启动的比例；**只测量，不改。**

## 交给其他 Agent 前的注意

- `.gitignore:24` 忽略了整个 `/.scratch/`，所以本目录**只存在于当前这份检出里**；新建的 git 工作树、云端会话或别的克隆里看不到它。给 Agent 下指令时用绝对路径 `/Users/local-user/Documents/learn/NotAlone/.scratch/runtime-waste-cleanup-20261106/`，或让 Agent 在这份检出里工作。
- 各任务要求产出的报告写在 `docs/verification/`（不被忽略，可提交）。
- 基准脚本在 [bench/](bench/)：`bench-policy.mjs`、`bench-sync.mjs`，均已实跑通过。
