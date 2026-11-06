# 备份与运行时占用盘点（2026-11-06）

对应任务：`.scratch/runtime-waste-cleanup-20261106/issues/03-backup-retention.md`。本次盘点**只读取证，未移动、未删除任何文件**。任务 03 的步骤 3、4（脚本、受控清理）未执行，删除动作全部留给用户批准。

## 0. 方法与核对命令

只使用了：`du -sk`、`stat -f '%SB %Sm'`、`ls -l`、`lsof`、`df -h`、`rg`（仓库文档引用）、`git log --all --oneline -S<名>`（提交引用）、`sqlite3 -readonly <备份> "SELECT max(version) FROM schema_migration"`（仅备份文件，每库 1 条）、`file -b`（仅读头部 user_version）。未读取任何备份的消息正文或联系人内容；正文中的路径为机器级路径，不含联系人信息。

说明：对 7 份备份执行 `sqlite3 -readonly` 时报 `unable to open database file (14)`（原因未查明，权限与文件头均正常；同一批中其余 5 份成功）。改用 `file -b` 读取每库头部 `user_version`（只读前 100 字节头，不含任何业务正文）。在 5 份 sqlite3 成功的库上，`user_version` 与 `schema_migration.max(version)` 完全一致（24/24/26/33/42），故其余 7 份以 `file` 头部值作为 schema 版本，可信。

当前产品 schema 版本为 42（`backend-ts/src/storage/sqlite/registry.ts` 最后一个迁移；规格文件管理与本盘点一致）。

## 1. 总体占用（du 实测，2026-11-06 23:59 前后）

`~/Library/Application Support/NotAloneDesktop` 合计 23,534,636 kB（约 21.9 GiB）。

| 目录 | du kB | ≈GiB | 说明 |
| --- | ---: | ---: | --- |
| `backups/` | 14,613,516 | 13.94 | 全部为开发 Agent 手工"改动前快照"，无产品代码生成（`rg "backups/sqlite"` 在 `backend-ts/src`、`desktop/src`、`scripts`、`backend-ts/scripts` 无命中） |
| `managed/` | 7,531,304 | 7.18 | 产品在用数据（media 4,395,816 / sqlite 3,130,452+4,100+32 / runtime-copies 896 等） |
| `Cache/` | 1,234,616 | 1.18 | Electron 缓存，可再生 |
| 其余 | ~155,000 | ~0.15 | `wechat-tool` 17,616、`wechat-tool-dev-20261023` 12,688、`GraphiteDawnCache` 5,764、8 个 `wechat-history-*`（每目录约 13 MB，合计约 104 MB）、`GPUCache`/`Dawn*Cache` 各 548、若干 ≤16 kB 配置与日志，及 10 个 `backend-launch.json.before-*`（各 4 kB） |

磁盘余量：`df -h /` → 可用 54 GiB（总量 228 GiB）。

同级（不属于 NotAloneDesktop，本次一并盘点）：

| 路径 | du kB | ≈GiB | 时间 |
| --- | ---: | ---: | --- |
| `~/Library/Application Support/NotAlone-consolidation-20261031.M61JMC` | 3,055,416 | 2.91 | 10-31 遗留 |
| `~/Library/Application Support/NotAlone DB Observer Prototype` | 7,576 | 0.007 | 10-30 09:09 |
| `~/Library/Application Support/NotAlone-Quarantine` | 60 | 0.0001 | 10-30 11:50 |
| `~/Library/Application Support/NotAlone` | 0 | — | 空目录 |

## 2. 分类定义（照任务单）

- **A 当前在用**：真实库及其 `-wal`/`-shm`、`managed/media` —— 绝不动。
- **B 最近快照**：最近/受文档登记的"改动前快照"—— 建议保留。
- **C 被覆盖的中间快照**：时间更晚、体积更大、schema 更新的同类快照已存在 —— 可删，需用户对具体文件名批准。
- **D 孤儿附属文件**：无主 `-wal`/`-shm` —— 本目录未发现（每个 `-wal`/`-shm` 都有同名主文件），但存在"附属文件不该存在"的问题，见 §4。
- **E 归属未知**：等待用户回答"这是什么"，不猜测。
- **F 可再生缓存**：可再生，需先保证无进程占用。

## 3. 真实库与 A 类（绝不动）

| 条目 | du kB | 时间（birth/mod） | 分类 | 核对结果 |
| --- | ---: | --- | --- | --- |
| `managed/sqlite/notalone.sqlite` | 3,130,452 | 10-30 14:39 / 11-06 23:45 | A | `lsof` 显示 Electron（PID 22194，多 FD）正在使用 → **开发 App 正在运行并持有真实库（停止条件事实记录）**；schema 未查（对真实库只允许聚合计数，本次未做查询） |
| `managed/sqlite/notalone.sqlite-wal` | ⾏4,100 | 11-06 23:01 / 11-06 23:45 | A | 活跃 |
| `managed/sqlite/notalone.sqlite-shm` | 32 | 11-06 23:01 / 11-06 23:19 | A | 活跃 |
| `managed/media/`（3,874 个 `.media` 目录） | 4,395,816 | — | A | 产品图片/原始对象存储，属"原始资料"，保留 |

另有 `managed/runtime-copies` 896 kB（运行期副本，可再生，量级极小，非候选）。

## 4. `backups/sqlite` 共 20 个条目逐条盘点

`lsof +D backups` 全目录 **无任何输出（无人占用）**；`rg -l` 与 `git log -S` 的引用核对中，"任务单自引"一律不计入（指本任务单 03 文件中本身列出了这些名字）。

| # | 文件名 | du kB（大小） | birth / mod | schema¹ | 文档引用（除任务单） | git -S 命中 | 附属文件 | 分类 | 分类理由 |
| --- | --- | ---: | --- | ---: | --- | ---: | --- | :- | --- |
| 1 | before-fence-restart-fix-20261106.sqlite | 3,131,028 | 11-06 20:55 | 42 | docs/verification/fenced-contact-recall-coverage-and-shared-reader-fence-20261106.md | **1（提交 ed2b64e02"记录围栏覆盖映射与共享读取器失证修复验收"）** | wal 0 kB＋shm 32 kB（21:50 由后续打开生成） | **B 保留** | 最新、schema=当前 42，且被验证文档＋提交登记为当前围栏工作的回滚点 |
| 2 | before-image-reset-20261105.sqlite | 1,996,672 | 11-05 12:58 | 42 | .scratch/fenced-contact-repair/issues/02-fence-cause-diagnosis.md（该任务 State: resolved） | 0 | 无 | **B 保留（第二新）** | 同 schema 42 的第二新快照；按提案"保留最近 2 份"自然保留 |
| 3 | before-quote-tail-v2-20261101.sqlite | 1,121,632 | 11-01 11:12 | 26 | 无 | 0 | 无 | C | 存在更晚、大 2.8 倍、schema 更新的快照（#2、#1），已被覆盖 |
| 4 | before-quote-tail-sync-20261101.sqlite | 1,120,272 | 11-01 10:59 | 26 | 无 | 0 | 无 | C | 同上；且与 #3 仅相隔 13 分钟，属同一 Bug 连环快照 |
| 5 | before-quote-target-fence-repair-20261101.sqlite | 1,099,352 | 11-01 10:15 | 26 | 无 | 0 | wal 0＋shm 32（10:16）+同前缀 json 22.6 kB（#15） | C | 同上；连同其 wal/shm/推断说明 json 一组，可一起由用户批准清理 |
| 6 | before-quote-sync-20261101.sqlite | 1,093,804 | 11-01 09:40 | 24 | 无 | 0 | wal 0＋shm 32（10:00 birth，shm mod 10:32 → 备份后被打开过） | C | 已被 #4/#5/#2 连续覆盖 |
| 7 | before-image-placeholder-wxgf-20261031.sqlite | 1,105,496 | 11-01 00:00 | 24 | 无 | 0 | wal 0＋shm 32（shm mod 11-01 09:24，比主文件晚 9 小时 → 有后续打开痕迹） | C | 已被后续 7 份覆盖 |
| 8 | before-original-image-decoding-fix-20261031.sqlite | 1,057,564 | 10-31 22:24 | 24 | 无 | 0 | 无 | C | 已被后续 8 份覆盖 |
| 9 | before-original-image-reader-upgrade-20261031.sqlite | 1,032,256 | 10-31 21:19 | 24 | 无 | 0 | 无 | C | 已被后续 9 份覆盖 |
| 10 | before-legacy-guard-repair-1793349613.sqlite | 307,732 | 10-30 16:40 | 18 | 无 | 0 | 无 | C | 最旧世代之一；被全部后续覆盖 |
| 11 | before-stable-source-upgrade-1793349058.sqlite | 159,120 | 10-30 16:30 | 18 | 无 | 0 | 无 | C | 最旧；schema 18 距当前 42 最多 |
| 12–14 | before-fence-restart-fix-…-wal/-shm | 0 / 32 | 11-06 21:50 | — | — | — | — | 随主文件（B）→ 按提案 R6"单文件"要求可一并移除 wal(0 kB)＋shm(仅无数据价值) | 备份后 21:50 被打开的痕迹；无数据（wal 空） |
| 15 | quote-target-fence-repair-20261101.json | 24（22,596 B） | 11-01 10:15 | — | 无 | 0 | — | 随 #5（C） | #5 的伴随说明/统计 json；不读其内容 |
| 16–19 | before-image-placeholder-wxgf / quote-sync / quote-target-fence 的 -wal/-shm（共 4 件，wal 全 0 kB，shm 共 96 kB） | 128 | 11-01 00:01–11-01 10:16 | — | — | — | — | 随各自主文件（C）+ F 性质（无数据） | **非孤儿**（都有主文件），但按"N 用 .backup 单文件快照"的要求本不该存在 |
| 20 | before-quote-tail-v2 等其余无附属主文件 | — | — | — | — | — | 无附属 | 已并入 #3–#11 | — |

¹ schema 版本：sqlite3 实测成功 5 份（24/24/26/33/42），其余 7 份取 `file -b` 头部 `user_version`（该值与 schema_migration 在成功样本上一致；两法交叉验证可信）。

小结：#1–#2（B）合计 5,127,700 kB（4.89 GiB）保留；#3–#11（C 主文件）合计 **8,097,228 kB（约 8.29 GB / 7.72 GiB）可删（需用户批准）**；8 件附属 wal/shm 共 128 kB；1 个 json 22.6 kB。

## 5. `backups/` 根其余条目

| 条目 | du kB | birth/mod | schema | 引用/git | lsof | 分类 | 理由 |
| --- | ---: | --- | ---: | --- | --- | :- | --- |
| contact-sync-20261103-1793699318593.sqlite | 1,388,384 | 11-03 17:48 | 33（file 头） | 仅任务单自引；git -S 0 | 无占用 | **C′（任务专用快照，单独裁决）** | 用途与"改动前快照"不同（联系人同步调试）。当前四阶段同步工作早已通过（deletion-and-sync-status-perf-20261106 等已落 docs/verification），此备份只在"想回到 11-03 时刻的联系人同步状态"时有用。**建议可删，由用户单独批准** |
| contact-sync-…-wal / -shm | 0 / 32 | 11-03 17:58 / shm mod **11-06 23:46** | — | — | 无占用 | 随主文件 | 异常：**shm 在 11-06 23:46（当晚，与真实库活跃时段相邻）被改写过**，说明 11-06 22–24 点之间有进程打开过该备份；删除前必须重新 `lsof` |
| launch/（4 个 before-quote-*.json，各 488–492 B；共 16 kB） | 16 | 11-01 00:01–10:59 | — | `rg` 0 命中 | 无占用 | D′ 低值快照 | 启动配置改动前快照；无登记引用，体积可忽略。可删（需批准），删后无影响 |
| resumable-history-20261103-launch-before.json | 4（390 B） | 11-03 22:49 | — | 仅任务单自引 | 无占用 | 低值快照 | 同上；390 B |
| notalone-pre-dedup-backups（顶层，空目录） | 0 | — | — | — | — | 空目录 | 可删（需批准），无空间影响 |

## 6. Electron 可再生缓存（F）

| 条目 | du kB | 备注 |
| --- | ---: | --- |
| `Cache/` | 1,234,616 | 可清；**当前 App 正在运行（真实库被 PID 22194 持有），必须等 App 完全退出后再动，否则视为"待删文件被占用"（停止条件命中）** |
| `GraphiteDawnCache`/`GPUCache`/`DawnGraphiteCache`/`DawnWebGPUCache`/`GPUPersistentCache`/`Code Cache` | 7,008 | 同上，量级小 |
| `Shared Dictionary` 52、`Trust Tokens` 36、`Preferences`/`Network Persistent State`/`Local State`/`Local Storage`/`DevToolsActivePort` 等 | ~110 | 同属配置/缓存；除非用户明确要求，不建议动（Preferences 等丢失会重登设置） |

## 7. 其余非候选数据（保留，不在本轮范围）

- `wechat-tool`（17,616 kB）、`wechat-tool-dev-20261023`（12,688 kB）：工具运行数据，保留。
- 8 个 `wechat-history-<账号哈希>` 目录（每个约 13 MB，合计约 104 MB）：账号级历史数据目录（内部为 bin/lib/manifest/source-identity-aliases 结构），含用户联系人历史产物，属性接近"原始资料"，保留。文档中不列全名以避免页面出现账号标识。

## 8. E 分类（归属未知——请用户回答"这是什么"）

| 路径 | du kB | ≈GiB | 观察（顶层清单，未打开内部内容） |
| --- | ---: | ---: | --- |
| `~/Library/Application Support/NotAlone-consolidation-20261031.M61JMC` | 3,055,416 | 2.91 | 顶层含 `wechat-message-dedup-ignored.tar` 1,810,312 kB、`wechat-dedup-integrated-ignored.tar` 1,243,644 kB、`uncommitted-files.tar` 1,132 kB、`tracked.patch` 196 kB、`status.bin` 100 kB、`staged.patch` 12 kB、`four-file-changes.patch` 8 kB 及 3 个 `.nul 4 kB`。从文件名形态看像工作树/受治理分支合并时的归档快照，日期 10-31；仓库文档（除本任务单与 spec.md）无登记。**待用户回答**：它是否是某次合并工作的存档？如可以丢，能有条件释放 2.91 GiB |
| `~/Library/Application Support/NotAlone DB Observer Prototype` | 7,576 | 0.007 | 10-30 09:09 的 Electron 试用 profile（Cache/Code Cache/DIPS 等），量级极小。原型遗留，建议作为 F 类清理（需批准） |
| `~/Library/Application Support/NotAlone-Quarantine` | 60 | 0.0001 | 含 `snapshot-20261030-…` 目录与 `…-viewer.log`（95 B）。可能是旧隔离目录功能产物。**待用户回答** |
| `~/Library/Application Support/NotAlone` | 0 | — | 空目录，可删（需批准） |

## 9. 保留策略提案（供用户裁决；本提案只写入本文档，不改 `docs/agents/engineering.md`）

围绕一条主规则，即"**任何对真实库的迁移/批量写入前，先做一份命名明确的 '改动前快照'，作为唯一被允许的备份通道；除'最近 2 份'和'现行文档登记的回滚点'以外，其余快照默认过期**"。

**R1 只在真实库改动动作（迁移/批量写入/闭环清理任务）发生前建快照**，统一用 `sqlite3 .backup '<目标>'` 生成 **单文件**快照（不产生 `-wal`/`-shm`），命名 `before-<主题>-<日期>.sqlite`；同时按 R5 登记文档。对当前 20 条目的效果：名称形态全部符合（11+1+1 份）；但这 12 份均为手工 `sqlite3 .backup` 或 `cp` 产生、其中 4 份带 wal/shm 附属 → 现状暴露"未按单文件纪律"执行的问题，说明"手工动作散落"是根本瓶颈（也与管理纪律不强相符，方案 R5/R6 才是补上）。

**R2 保留最近 2 份"改动前快照"**（同型、全生命周期排序），更早的视为过期。对当前 11 份 before-* 主文件的效果：保留 #1 before-fence-restart-fix-20261106.sqlite、#2 before-image-reset-20261105.sqlite，**其余 9 份（#3–#11）全部过期**，可释放 **8,097,228 kB ≈ 8.29 GB（7.72 GiB）**。

**R3 被 docs/verification/ 登记为回滚点的快照保留到该文档/相关任务结案**。对当前条目的效果：#1 被 `docs/verification/fenced-contact-recall-coverage-and-shared-reader-fence-20261106.md`+ 提交 ed2b64e02 登记 → 即便少于此档也保留到该验收文档结案；#2 被 `.scratch/fenced-contact-repair/issues/02`（resolved）引用 → 属于"弱登记"，规则 R2 已覆盖。R2+R3 并用，保留集合与 R2 相同。

**R4 过期快照删除时机**：其对应工作（docs/verification 验收文档）结案后、**距快照生成 ≥7 天**即可执行清删，不必等 "用户批一次性全景清理"。出现例外（任务未结案时想先删）→ 用户在对话中批准具体文件名即可。对当前条目：#10/#11（10-30 两份）生成至今恰好 7 天满、对应工作（图片管线/stable source/guard）早已结案 → 可立即执行；#3–#9（11-01 起至 11-06 前）分别距 5–6 天，按 7 天法则在 11-08～11-12 内陆续到期；#3/#4/#6/#7/#8/#9（quote/image 各项）对应的 verification 文档（source-recertification-20261101 等）已 resolved → 一并满条件。**为减少两轮审批，主提案允许一次性将这些"已满 7 天或将满 7 天"的 9 份一并纳入本轮用户批准的清单。**

**R5 每个新快照在 `docs/verification/` 或旁边同名 .md 登记**：用途、对应提交、schema 版本、可删除条件；**没有登记的快照视同无主文档，只能作为过期待清理项**（R4 适用）。对当前 20 条目的效果：登记存在的仅 #1（docs/verification 验收文档）、#2（.scratch 任务文档）；其余 9 份无登记 → 这正是可安全删除的理由；提案也说明 R5 是"证据流"，把"无登记"从"未知"收敛为"可清"。

**R6 快照只保留单文件**：删除 wal 是空的（所有现存 8 件 wal 均 0 kB）→ 全部无未落盘数据；shm 只是共享内存索引（各 32 kB）→ 全部无回滚价值。效果：`backups/sqlite` 下 4 组附属 + `backups/` 下 contact-sync 附属，共 **128+32 = 160 kB 全部可清**（各自伴随主文件清单）。

**R7 可再生缓存清理时机**：`Cache/`（1,234,616 kB）与 `GraphiteDawnCache` 等仅在 **App 完全退出后**清理，平时允许保留（当下 Electron PID 22194 活跃，此刻不动）；改由"每次开发结束"触发（规范本就如此：`engineering.md`「每轮结束清理本轮闲置 App、运行时 staging 和编译缓存」），本轮如实记录"App 在跑，未清"。

**R8 任务专用快照（如 `contact-sync-*`、launch/ 的短 json）与 R2 同节奏**但按用途独立命名作区别：任务结束即过期；**需用户单独批准**。效果：contact-sync 主三件 1,388,416 kB、launch/ 16 kB、resumable 4 kB —— 若用户同意过期，可释放 1,388,436 kB ≈ 1.42 GB（1.32 GiB）。

### 可释放空间汇总（du 实算，均需用户对具体文件名批准）

| 方案 | 清理对象 | 释放 du kB | 换算 |
| --- | --- | ---: | --- |
| 主提案（R2/R5/R6） | 9 份 C 主文件 + 4 组 wal/shm + 1 json | 8,097,380 | ≈8.29 GB（7.72 GiB） |
| 主提案 + R8 | contact-sync 三件 + launch/4 + resumable 1 | ＋1,388,436 | 累计 **9,485,816 kB ≈ 9.71 GB（9.05 GiB）** |
| 再加 R7（App 退出后） | `Cache/` | ＋1,234,616 | 累计 10,720,432 kB ≈ 10.98 GB（10.23 GiB） |
| 再加 E 已获答复（consolidation 可丢） | consolidation 目录 | ＋3,055,416 | 累计 **13,775,848 kB ≈ 14.11 GB（13.13 GiB）** |

（以上所有数字来自本机 `du -sk` 实测；若最终走"移到废纸篓"流程，实际空间释放要到用户清空废纸篓后才发生。）

## 10. 停止条件核对记录

- 备份目录本轮 `lsof` 无占用（已记录输出为空、exit=0）。
- **真实库被开发 App 占用**（Electron PID 22194，多种 FD）：A 类，绝不动；同时导致 `Cache/` 等 F 类 当前不可清。
- `contact-sync-…-shm` 在 11-06 23:46 被改写（当晚有进程打开过该备份）——已如实记录；当前无占用，若用户批准删除，须删除前重新 `lsof` 并在无输出时执行。
- 未发现"某未结案任务的唯一回滚点"：引用 #1 的验收文档/任务都已会签到当前出口流程；引用 #2 的 `.scratch/fenced-contact-repair/issues/02` 已 resolved。若用户知晓有其他未落文档的回滚需要，可把对应文件移入保留清单。

## 11. 数据处理影响与剩余风险

- 本盘点只读，未发生任何写、移动、删除；备份正文与联系人内容全程未读。
- schema 版本来源两法交叉：5 份 `sqlite3 -readonly` 实测，7 份 `file` 头部；数值一致性良好。
- 风险 1：`sqlite3 -readonly` 对 7 份备份报 `unable to open database file (14)`（同一批中 5 份成功），原因未查明；未用任何绕过段读取。风险限于"少得了 7 个数值点"，由 `file` 兜底。
- 风险 2：`contact-sync-…-shm` 有 11-06 23:46 改写痕迹 → 备份曾被打开；若用户批准删除，删除时需重查 `lsof`。
- 风险 3：`NotAlone-consolidation-20261031.M61JMC` 内部含 `.tar`/`.patch`，未打开检查（可能含私人内容）；其归属只有用户能回答。
- 风险 4：本机磁盘可用 54 GiB，清理动作（尤其移废纸篓）不改变可用空间直到清空废纸篓；已提示。
