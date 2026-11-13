# 修复删除路径的无索引反查

Triage: ready-for-human
State: resolved
Type: task

Blocked by: none（占用迁移版本号 43，见 [spec.md](../spec.md) "迁移版本号协调"）

先读 [spec.md](../spec.md) 的"全局规则"，再开始。

## Goal

让联系人／来源／账号删除的"计划"阶段不再对每条消息扫描整个 owner 分区。目标：消息特别多的联系人不再因计划动作超过 15 秒预算而被存储线程终止（`worker_failed`）；诊断文档里的超大联系人（约 2.2 万个目标）计划耗时从 50.4 秒降到预算内，原型对比 5,013 条消息由 311 秒降到 8 秒。**行为与删除结果必须完全不变。**

## 背景证据

只读核对（11-06 23:28，真实库 `EXPLAIN QUERY PLAN`）：

```text
SELECT * FROM message_alias WHERE owner_id=? AND message_id=?
  -> SEARCH message_alias USING INDEX sqlite_autoindex_message_alias_2 (owner_id=?)     只用 owner_id 前缀
SELECT id FROM capture_record WHERE owner_id=? AND message_id=?
  -> SEARCH capture_record USING COVERING INDEX sqlite_autoindex_capture_record_4 (owner_id=?)
SELECT id FROM capture_record WHERE owner_id=? AND contact_id=? AND message_id=?   （无 INDEXED BY）
  -> SEARCH capture_record USING COVERING INDEX sqlite_autoindex_capture_record_4 (owner_id=? AND contact_id=?)
SELECT id FROM capture_record INDEXED BY capture_record_message WHERE owner_id=? AND contact_id=? AND message_id=?
  -> SEARCH capture_record USING INDEX capture_record_message (owner_id=? AND contact_id=? AND message_id=?)
```

结论：

1. `message_alias` 没有以 `(owner_id, message_id)` 开头的索引（表上只有主键 `(owner_id,id)` 和唯一键 `(owner_id,contact_id,binding_id,scheme,external_key)`）。真实库 366,406 行，每次反查扫整个 owner 分区。
2. `capture_record` 已有 `capture_record_message(owner_id,contact_id,message_id)`，但 `idsForScope` 的查询**没带 `contact_id`**，用不上它。
3. 第三条显示：即便带了 `contact_id`，**没有统计信息时优化器仍倾向选 `sqlite_autoindex_capture_record_4`（只匹配前两列）而不是更精确的 `capture_record_message`**。库里没有 `sqlite_stat1`，代码里也没有 `ANALYZE` 或 `PRAGMA optimize`。所以"加 `contact_id` 条件"这一步本身未必足够，**必须用查询计划和计时实证**，不能只改 SQL 文本。

调用点（逐个核对，不要只信本表）：

| 位置 | 查询 | 调用次数规模 |
| --- | --- | --- |
| `backend-ts/src/history/sqlite/deletion.ts:25` | `SELECT id FROM capture_record WHERE owner_id=? AND message_id=?`，对每个候选消息各查一次 | 每条待删消息 1 次 |
| `backend-ts/src/history/sqlite/deletion.ts:73` | `SELECT * FROM message_alias WHERE owner_id=? AND message_id=?`，对每个被删消息各查一次 | 每条被删消息 1 次 |
| `backend-ts/src/history/sqlite/deletion.ts:97` | 同上，用于 `fence` 里的来源排除 | 每个来源 1 次 |

诊断文档在超大联系人上实测：`message_alias` 反查 488 次共 31.6 秒（单次最大 827 毫秒），`capture_record` 查询 7.0 秒，一次 `UPDATE capture_record` 5.2 秒。

先例（照这个模式做迁移）：`backend-ts/src/history/sqlite/empty-capture-schema.ts` 里的 `historyCaptureRecordForeignKeyIndexMigration`——只建索引、不批量删数据，注释写明了在 1.9 GB 副本上的实测。注册位置：`backend-ts/src/storage/sqlite/registry.ts:47`（导入）与 `:83`（迁移列表，当前最后一个是 42）。

## 必读

- `architecture/current/privacy-deletion.md` 中删除计划、闭包与目标收集的章节（`rg -n "计划|闭包|目标|collect|message_alias" architecture/current/privacy-deletion.md`）；文件超过 20 KB，不要整读。
- `docs/agents/scaling-and-data-lifecycle.md` 的"级联删除"相关条目。
- `backend-ts/src/storage/sqlite/README.md`（迁移与 schema 摘要规则）。
- `backend-ts/src/storage/sqlite/worker.ts:34-43,56,74-78`：迁移 checksum、`schema_digest` 与 `migration_drift` 的校验方式，决定新迁移怎么写才能通过打开校验。

## 步骤

1. **建基线**（先于任何修改）：在合成夹具上复现"一位有 N 条消息的联系人做 `deletion.plan`"。参照 `backend-ts/scripts/perf/image-sync-query-baseline.mjs` 写 `backend-ts/scripts/perf/deletion-lookup-baseline.mjs`：用确定性数据（例如 5,000 条消息、每条 1–2 个别名、对应 `capture_record`，外加另外几位联系人制造足够的 owner 分区体量），记录 `deletion.plan` 的 P50／P95 和三个反查查询的 `EXPLAIN QUERY PLAN`。保存"修改前"的黄金输出：计划产生的 `deletion_target` 集合（行类型＋行键＋顺序）。
2. **选方案并用证据选**：对每个调用点评估两种手段，各自测一遍：
   - (a) 查询里补 `contact_id`，并在需要时用 `INDEXED BY` 或让统计信息生效；
   - (b) 新增索引：`CREATE INDEX message_alias_message ON message_alias(owner_id,message_id)`；对 `capture_record` 只有在 (a) 不可行时才新增（候选 `capture_record(owner_id,message_id,id)`，注意 `idsForScope` 的 `scope.kind==='account'` 和 `'source'` 分支没有现成的 `contact_id`）。
   - 约束：`message` 表的 `UNIQUE(owner_id,contact_id,id)` 表明可以由 `message_id` 取回 `contact_id`，但**必须验证 `message.id` 在同一 owner 下是否全局唯一**（看 `message` 表主键），不要假设。
   - 优先选"不新增迁移"的方案；只有证明必须新增索引时才加迁移，并在报告里写明新增索引的体积（`dbstat` 或前后文件大小）与建索引耗时。
3. **（可选，需单独评估）统计信息**：评估在打开或迁移后对相关表执行 `PRAGMA optimize` 或一次性 `ANALYZE` 的收益与风险（3 GB 库上的耗时、是否改变其他查询的计划、是否触发 `schema_drift`——`sqlite_stat1` 属于 `sqlite_*` 对象，`schemaDigest` 查询里用 `NOT GLOB 'sqlite_*'` 排除了它，但要实测）。**只写进报告，不要默认启用。**
4. **实现**：
   - 若新增索引：新建迁移函数（放在 `backend-ts/src/history/sqlite/` 下合适的 schema 文件或 `empty-capture-schema.ts` 同级新文件，函数名描述用途），在 `registry.ts` 列表末尾追加 `version: 43`。**迁移只建索引、不改数据。**
   - 更新所有写死 42 的断言（至少 `backend-ts/test/sqlite-memory-auto-switch.test.mjs:115`；用 `rg -n "schemaVersion" backend-ts/test` 与 `rg -n "\b42\b" backend-ts/test` 全面检查，`sqlite-storage.test.mjs` 用的是 `baseRegistry.migrations.length`，通常无需改）。
   - 改完 SQL 后重跑第 1 步基线，对比计划集合与耗时。
5. **迁移实测**：在 3 GB 真实库的隔离副本上打开新代码，记录：迁移耗时、`quick_check` 是否通过、`schema_digest` 与 `migration_drift` 校验通过、文件大小变化。**打开预算 `sqliteOpenTimeoutMs=60_000`，迁移耗时必须明显低于它。** 超过 10 秒就停下，报告给用户。
6. **等待用户批准后**才可把迁移应用到真实库（见全局规则）。本任务**不负责**在真实库上执行迁移；只交付代码、迁移实测报告和"应用时的操作步骤与回滚说明"（回滚 = 用迁移前备份还原，因为 `user_version` 升到 43 后旧代码会报 `schema_too_new`）。

## 验收

- [ ] 合成夹具上 `deletion.plan` 的 `deletion_target` 集合（行类型、行键、顺序）与修改前黄金输出**逐项一致**（含 `contact`／`contact_history`／`source`／`account` 四种范围）。
- [ ] 三个调用点的 `EXPLAIN QUERY PLAN` 不再出现仅 `(owner_id=?)` 前缀的搜索，已记录前后计划。
- [ ] 同一夹具上 `deletion.plan` 前后耗时已记录；5,000 消息量级下应进入秒级（诊断原型参考值 311 秒 → 8 秒；实测值以你的夹具为准，如实写）。
- [ ] 若新增迁移：版本为 43，只含 `CREATE INDEX`；`sqlite-storage.test.mjs`、`sqlite-incremental-migration.test.mjs`、`sqlite-startup-preflight.test.mjs`、`sqlite-memory-auto-switch.test.mjs` 通过。
- [ ] 副本实测：迁移耗时、索引体积、`quick_check`／`foreign_key_check` 通过；真实库未被改动（`ls -l` 修改时间与迁移前一致，且你没有以写模式打开过它）。
- [ ] `sqlite-deletion.test.mjs`、`sqlite-deletion-compaction.test.mjs`、`sqlite-deletion-metadata*.test.mjs`、`sqlite-history-legacy-source-deletion.test.mjs`、`sqlite-history-source-epoch-deletion.test.mjs`、`sqlite-clear-*.test.mjs`、`discussion-deletion-scaling.test.mjs` 通过。
- [ ] 报告写明：数据处理影响（只新增索引，不改既有行）、实际命令、剩余风险（超大联系人计划仍可能超 15 秒预算则如实写）。

## Test seam

公开存储动作 `deletion.plan`（经 `SqliteStorage.execute`）及历史域的删除域注册 `historyDeletionDomain`；对比的是计划产生的目标集合，不是 SQL 字符串。参照 `backend-ts/test/sqlite-deletion.test.mjs`、`backend-ts/test/discussion-deletion-scaling.test.mjs` 的夹具。

## 常用命令

```bash
cd backend-ts && node --test --test-name-pattern="<名称>" test/sqlite-deletion.test.mjs
cd backend-ts && node --test test/sqlite-deletion.test.mjs test/sqlite-history-source-epoch-deletion.test.mjs test/sqlite-incremental-migration.test.mjs
cd backend-ts && (set -o pipefail; perl -e 'alarm 600; exec @ARGV' -- npm test 2>&1 | tail -60)   # 仅在前面都通过后
```

## 停止条件

- 需要改变删除闭包语义、目标收集顺序，或删除证明的内容。
- 迁移在副本上超过 10 秒，或触发 `schema_drift`／`migration_drift`。
- 需要对真实库做任何写入。

## Answer

**结论**：已完成实现与隔离副本实测，提交 `995e4b3a7`（7 个文件）。**2026-11-07 用户批准后已把迁移 43 应用到真实库并核对通过（见 `docs/verification/migration-43-application-20261107.md`）**：`schema_migration` 43 行、`user_version` 43、`message_alias_message` 索引存在、`quick_check`／`foreign_key_check` 通过、epoch 1215→1219、主文件字节数不变；改前快照 `backups/sqlite/before-migration-43-20261107.sqlite`（APFS 逐字节克隆，shasum 与库一致）仍保留作回滚点。

**方案与证据**：
- `capture_record` 反查（`backend-ts/src/history/sqlite/deletion.ts` 的 `idsForScope`）改为补 `contact_id` 并 `INDEXED BY capture_record_message`。等价性依据：`capture_record(owner_id,contact_id,message_id)` 是指向 `message(owner_id,contact_id,id)` 的复合外键（且 `message` 主键即 `(owner_id,id)`），带 `message_id` 的行必然与该消息同 `contact_id`，集合与旧查询逐行相同。必须 `INDEXED BY` 的理由：库里无 `sqlite_stat1`，实测（基准脚本 EXPLAIN 两种夹具同现）三条件查询在无统计时仍退回 `autoindex_capture_record_4` 的 `(owner_id,contact_id)` 二列前缀。
- `message_alias` 两处（:73、:97）SQL 文本不变；由迁移 43 新建 `message_alias_message(owner_id,message_id)` 索引（`backend-ts/src/history/sqlite/empty-capture-schema.ts`，参照 v41 先例"只建索引不改数据"），查询计划从 `sqlite_autoindex_message_alias_2 (owner_id=?)` 全 owner 分区前缀变为 `(owner_id=? AND message_id=?)` 精确查找。没有选"补 contact_id＋INDEXED BY"路线：现有一把唯一键索引去掉 `message_id`，二列前缀仍要扫整个联系人的别名集合，对大联系人删除仍是平方级。
- 未采用新增 `capture_record(owner_id,message_id)` 索引：外键等价性已证明 (a) 路线可用；(b) 索引还要面对"覆盖索引平局优化器仍可能选错"的不确定性。

**前后对比（同一基准脚本、同一确定的合成夹具：大联系人 3,000 条消息＋40 位填充联系人各 1,000 条，owner 分区约 4.3 万消息；直调 `planDeletion` 绕过 15 秒 worker 预算只是为了能测出修改前的完整耗时）**：
- `deletion.plan`（scope=contact）：P50 **63,833 ms → 189 ms**；P95 67,789 → 196 ms（约 330 倍）。修改前每次 61.5–67.8 秒，真实 worker 里必被 15 秒预算终止（`worker_failed`），修改后远在预算内。
- 黄金集（`deletion_target` 行类型＋行键＋expected_identity＋顺序，`--golden-out/--golden-check`）：12,008 行逐项一致（修改前后两次 large 档运行对比）。
- 三处反查 `EXPLAIN QUERY PLAN` 前后记录见脚本输出：`message_alias` 由 owner 前缀变为 `(owner_id=? AND message_id=?)`；`capture_record` 计划脚本同时保留了"无 INDEXED BY 对照查询仍退回二列前缀"的证据行，证明强制索引的必要性（不是 SQL 文本就能避开优化器误选）。

**验证命令**：
```bash
cd backend-ts && node scripts/perf/deletion-lookup-baseline.mjs --profile=smoke
cd backend-ts && node scripts/perf/deletion-lookup-baseline.mjs --profile=large --golden-out=/tmp/deletion-golden-before.json   # 修改前
cd backend-ts && node scripts/perf/deletion-lookup-baseline.mjs --profile=large --golden-check=/tmp/deletion-golden-before.json # 修改后
cd backend-ts && node --test test/sqlite-deletion.test.mjs test/sqlite-deletion-compaction.test.mjs test/sqlite-history-legacy-source-deletion.test.mjs test/sqlite-history-source-epoch-deletion.test.mjs test/sqlite-clear-contact.test.mjs test/sqlite-clear-contact-history.test.mjs test/sqlite-clear-account.test.mjs test/sqlite-history-quote-store.test.mjs test/discussion-deletion-scaling.test.mjs   # 48 通过
cd backend-ts && node --test test/sqlite-storage.test.mjs test/sqlite-incremental-migration.test.mjs test/sqlite-startup-preflight.test.mjs test/sqlite-memory-auto-switch.test.mjs   # 28 通过
cd backend-ts && node test/fixtures/cutover/build-structure-baseline.mjs && node --test test/sqlite-cutover-structure.test.mjs   # 4 通过
node scripts/check_public_history.mjs --ref HEAD --working-tree   # issues 0
```

**3 GB 真实库副本实测（真实库未动，`shasum` 与 `ls -l` mtime 前后一致；副本与临时产物已删除核对）**：
- 副本来源：无进程占用窗口内 APFS clone（`shasum` 逐字节一致，ledger 42、`user_version` 42、`database_id` 63c91816…），避免 WAL 单文件拷贝打不开的问题。
- 用新代码 `SqliteStorage.open` 打开副本：**open＋迁移总耗时 35.1 s**（60 秒 open 预算内；其中含 2 次 `integrity_check`、1 次 `foreign_key_check` 与建索引）。之后正常重开 14.4 s，schemaVersion 维持 43，`epoch` 连续 1216→1217，`schema_digest` 无漂移。
- 迁移耗时孤立测量：`BEGIN;CREATE INDEX message_alias_message…;ROLLBACK` ≈ 1.3 秒。3 GB 库各级检查冷/暖缓存实测：`quick_check` 16 s/1 s、`integrity_check` 24–35 s/13 s、`foreign_key_check` 2–9 s（0 行违反）。**冷缓存的第一次开库预计接近或超出 60 秒预算**；超时会回滚（实测第一次冷开即超时回滚，文件保持 42 版未损），可在页面缓存预热后重试，不会造成半迁移状态。
- 体积：索引 `dbstat` 体积 35,725,312 字节（约 35.7 MB）；库文件总大小不变（建索引复用了库内既有空闲页，`page_count` 不变）。
- 附带待测：`quick_check` 冷 16 s、暖 1 s（3 GB 副本，本机 NVMe）。

**数据处理影响**：只新增一个二级索引，无任何行被新增/修改/删除；所有已存在行、目标集合、删除证明内容不变。

**把迁移应用到真实库（需要用户明确批准后再执行）**：
1. 先确认存在一份"仍然有效的改前快照"（现库 42 版，可用 `sqlite3 -readonly 真实库 ".backup before-message-alias-index-<日期>.sqlite"` 现做一份，约 3 GB）。
2. 核对磁盘空间 ≥ 15 GiB（当前 54 GiB）并停止运行中的 App（确认 `lsof` 无真实库占用）。
3. 开发入口 `pnpm run dev` 正常打开 App 即自动执行迁移 43（迁移在开发/正式装配同一注册表）。建议先做一次普通打开把页面缓存预热（或先用只读快速校验一次），避免冷缓存第一次打开撞 60 秒预算；若超时，事务已回滚、库保持 42 版，稍后重试即可。
4. 回滚 = 用迁移前快照还原整个 `notalone.sqlite`（`user_version` 43 后旧代码会报 `schema_too_new`，不可原地降级）；确认迁移安全后第 2 步那份快照可按备份保留策略处置。

**剩余风险**：
- 每条消息一次反查的结构保留（N 次索引查找代替 N 次分区扫描），理论上仍随被删消息数线性增长；超大联系人（约 2.2 万目标）修改后预计远离 15 秒预算，但真实库上未实测（等待用户批准应用迁移后可以再验证）。
- `INDEXED BY` 依赖 `capture_record_message`（迁移 5 起存在）；若未来某迁移删除该索引，查询会直接报错（fail-fast），不会静默变慢。
- 直调 `planDeletion` 的基准路径与真实 worker 相同 SQL/语句缓存/FK/WAL/FULL 设置，但不经 worker 队列计时；对外宣称的数字注明了这一点。

## Comments
