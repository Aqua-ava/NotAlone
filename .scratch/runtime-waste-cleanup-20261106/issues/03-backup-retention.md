# 备份盘点、保留策略与受控清理

Triage: ready-for-human（盘点与提案已完成；删除步骤待用户在对话中批准具体文件名清单）
State: claimed（步骤 1、2 完成并写入 ## Answer；未做步骤 3、4，未移动/删除任何文件；用户批准清理后再执行步骤 4 并把 State 改为 resolved）
Type: task（盘点 → 提案 → **用户逐项批准** → 受控清理）

Blocked by: none

先读 [spec.md](../spec.md) 的"全局规则"，再开始。

## Goal

把 `~/Library/Application Support/NotAloneDesktop` 约 22 GB 的占用理清楚，给出每个文件／目录"能不能删、为什么、不删会怎样"的盘点；提出一条可执行的备份保留策略；**在用户逐项批准后**才移动或删除文件。本任务不是"清理磁盘"，是"让用户有依据地决定清理什么"。

## 硬性前提（先读）

- **业务数据库、原始资料和备份默认保留。** 这是 `docs/agents/engineering.md`"开发磁盘占用"的明文规则：删除前核对精确路径、Git 跟踪状态及进程引用；保留源码、未提交改动、验收记录、业务数据库、原始资料和备份。
- 因此本任务**默认不删除任何文件**。盘点和提案是 Agent 可独立完成的部分；任何移动、删除都必须取得用户在对话里对**具体文件名清单**的明确批准（"全部清理"这种笼统说法不算，需复述清单让用户确认）。
- 不读取任何备份文件的内容（它们是含私人聊天的完整数据库副本）。只允许 `ls`、`du`、`stat`、`lsof`，以及对**真实库**之外的备份用 `sqlite3 -readonly` 读取 `schema_migration` 最大版本与 `database_instance` 的非敏感字段（可选，用来判断备份对应的 schema 版本）。
- 备份不是产品代码生成的：在 `backend-ts/src`、`desktop/src`、`scripts` 里没有创建 `backups/sqlite` 的代码（`rg -n "backups" ...` 无命中）。它们由历次开发 Agent 用 `sqlite3 .backup` 或 `cp` 手工留下的"改动前快照"，没有保留策略。

## 背景证据（11-06 23:28 本机，请重新核对后再用）

`~/Library/Application Support/NotAloneDesktop` 共 22 GB：

| 目录 | 大小 | 说明 |
| --- | --- | --- |
| `backups/` | 14 GB | 其中 `backups/sqlite` 13 GB，另有 `contact-sync-20261103-1793699318593.sqlite`（1347 MB）及其 `-wal`/`-shm`，`launch/`（16 KB）、`resumable-history-20261103-launch-before.json` |
| `managed/` | 6.9 GB | `media` 3.9 GB（产品数据，**不是候选**）、`sqlite` 3.0 GB（**当前在用的库**，不是候选）、`runtime-copies` 728 KB |
| `Cache/` | 1.2 GB | Electron 缓存，通常可再生，但需 App 退出后再动 |
| 其余 | 约 60 MB | `wechat-tool`、`wechat-history-*` 等，数量级很小 |

同级目录：`~/Library/Application Support/NotAlone-consolidation-20261031.M61JMC` 2.9 GB（归属未知，疑为 10-31 合并工作遗留）、`NotAlone DB Observer Prototype` 7.4 MB、`NotAlone-Quarantine` 60 KB。

`backups/sqlite` 的 20 个条目（按文件名，大小为当时 `ls` 值；`-wal`/`-shm` 是同名数据库的附属文件）：

| 文件 | 大小 | 修改时间 | 仓库文档引用数 |
| --- | ---: | --- | ---: |
| `before-stable-source-upgrade-1793349058.sqlite` | 155 MB | 10-30 16:30 | 0 |
| `before-legacy-guard-repair-1793349613.sqlite` | 301 MB | 10-30 16:40 | 0 |
| `before-original-image-reader-upgrade-20261031.sqlite` | 1007 MB | 10-31 21:20 | 0 |
| `before-original-image-decoding-fix-20261031.sqlite` | 1033 MB | 10-31 22:24 | 0 |
| `before-image-placeholder-wxgf-20261031.sqlite`（＋wal/shm） | 1079 MB | 11-01 00:00 | 0 |
| `before-quote-sync-20261101.sqlite`（＋wal/shm） | 1068 MB | 11-01 09:40 | 0 |
| `before-quote-target-fence-repair-20261101.sqlite`（＋wal/shm）、`quote-target-fence-repair-20261101.json` | 1074 MB | 11-01 10:15 | 0 |
| `before-quote-tail-sync-20261101.sqlite` | 1087 MB | 11-01 10:59 | 0 |
| `before-quote-tail-v2-20261101.sqlite` | 1091 MB | 11-01 11:13 | 0 |
| `before-image-reset-20261105.sqlite` | 1950 MB | 11-05 12:58 | 1 |
| `before-fence-restart-fix-20261106.sqlite`（＋wal/shm） | 3051 MB | 11-06 20:55 | 0 |

"仓库文档引用数"指在 `.scratch`、`docs`、`architecture`、`AGENTS.md` 里按文件名（不含扩展名）能 `grep` 到的文件数。**0 不等于可删**，只说明没有文档把它登记为回滚点。另外 `contact-sync-20261103-...sqlite` 引用数为 0。

## 步骤

### 1. 盘点（只读）

产出 `docs/verification/backup-inventory-20261106.md`（新建，中文；不含联系人信息；不提交任何备份内容）。每个条目包含：

- 精确路径、大小（`du -k`）、创建／修改时间（`stat -f '%SB %Sm'`）。
- 对应的 schema 版本（可选，`sqlite3 -readonly <备份> "SELECT max(version) FROM schema_migration"`）：判断它是否还能被当前代码打开（当前版本 42；低于某个版本的备份可能已无法被当前代码升级，那它作为回滚点的价值更低，**这一点只作参考，由用户判断**）。
- 引用情况：`rg -l "<文件名不含扩展名>" .scratch docs architecture AGENTS.md`；以及 `git log --all --oneline -S"<文件名>"` 是否出现在提交信息里。
- 进程占用：`lsof "<路径>"` 输出（无输出才算未被占用）。**当前 App 或开发后台可能占用真实库及其 `-wal`/`-shm`，备份目录通常不会被占用，但必须核对。**
- 是否孤儿：`-wal`／`-shm` 没有同名主文件，或主文件没有对应的 `-wal` 却留有 `-shm`（`before-image-placeholder-wxgf-20261031.sqlite-shm` 的时间戳比主文件晚很多，值得核对）。
- 分类（只给建议，不执行）：
  - **A 当前在用**：`managed/sqlite/notalone.sqlite`、`managed/media`——**绝不动**。
  - **B 最近一次大改前的快照**：每个"当前仍在使用的 schema 版本"保留最近一份，建议保留。
  - **C 已被后续备份覆盖的中间快照**：同一天内多份、且存在时间更晚的同类快照；建议"可删，需用户批准"。
  - **D 孤儿附属文件**：无主 `-wal`/`-shm`。
  - **E 归属未知**：`NotAlone-consolidation-20261031.M61JMC` 等；**不得猜测，列出让用户回答"这是什么"**。
  - **F 可再生缓存**：`Cache/`。

### 2. 提案保留策略（写进盘点文档，不改仓库规则文件）

给出一条可执行的规则供用户裁决，例如：

- 每次对真实库做迁移或批量写入前，才创建"改动前快照"；命名 `before-<主题>-<日期>.sqlite`。
- 保留：最近 **2** 份快照；任何被文档登记为回滚点的快照直到该文档结案。
- 清理：改动验证通过 **7 天**后，早于最近 2 份的快照可删。
- 每份快照旁放一个同名 `.md` 或写入 `docs/verification/` 说明：用途、对应提交、可删除条件。
- 把"快照只保留一份 `-wal`/`-shm` 合并后的单文件"写成操作要求（用 `sqlite3 .backup` 生成的单文件快照，不留 wal/shm）。

提案里要写出**每条规则对当前 20 个条目的效果**：按此规则会保留哪些、可释放多少 GB。数字用 `du` 算，不估。

是否把规则写入 `docs/agents/engineering.md`"开发磁盘占用"一节，**由用户决定**；本任务不改该文件。

### 3. 可选：只读盘点脚本

可新增 `scripts/backup-inventory.mjs`：只读，输出上面第 1 步的表格；**不实现任何删除或移动功能**。参数仅 `--dir`。需要有测试（合成临时目录）。不做也可以，不影响验收。

### 4. 受控清理（仅在用户批准后）

用户在对话里批准了具体文件名清单后：

1. 重新核对：每个路径存在、`lsof` 无占用、不在 A 类、不是真实库、不是 `git ls-files` 跟踪的文件。
2. **默认移到 `~/.Trash`**（`mv` 到废纸篓，可恢复），不是 `rm`。只有用户明确说"永久删除"才用 `rm`，并且逐个文件执行、逐个核对退出码。
3. 前后各记录一次 `df -h /` 和 `du -sh ~/Library/Application\ Support/NotAloneDesktop`。
4. 把实际执行的清单和结果追加到盘点文档的"执行记录"一节。
5. 废纸篓不会立刻释放空间——提醒用户自行清空，**不要代为清空废纸篓**。

## 验收

- [ ] 盘点文档已写，所有 `backups/` 条目、`contact-sync-*`、`launch/`、`resumable-history-*.json`、`Cache/`、`NotAlone-consolidation-*` 都有分类、大小、引用与占用核对结果。
- [ ] 保留策略提案已写，并给出对当前条目的逐条效果与可释放空间（`du` 实算）。
- [ ] 未经用户批准**没有任何文件被移动或删除**（`ls`／`du` 前后一致可证）。
- [ ] 若用户批准并执行了清理：执行清单与用户批准的清单逐项一致；前后磁盘占用已记录；真实库及其 `-wal`/`-shm`、`managed/media` 未被触碰。
- [ ] 盘点文档不含联系人名称、消息内容，备份文件内容未被读取。
- [ ] 数据处理影响与剩余风险已写入 `## Answer`。

## Test seam

无产品行为变化。若新增 `scripts/backup-inventory.mjs`，用合成临时目录断言其输出，且断言脚本在任何参数下都不会修改目录内容。

## 常用命令

```bash
du -sk ~/Library/Application\ Support/NotAloneDesktop/backups/sqlite/* | sort -rn
stat -f '%Sm %z %N' -t '%m-%d %H:%M' ~/Library/Application\ Support/NotAloneDesktop/backups/sqlite/*
lsof +D ~/Library/Application\ Support/NotAloneDesktop/backups
df -h /
```

## 停止条件

- 用户尚未回复批准清单：停在提案，把 `Triage:` 置为 `ready-for-human`。
- 任何待删文件被 `lsof` 显示正在使用，或无法确认归属。
- 发现某份备份是某个未结案任务的唯一回滚点：不列入可删清单，并在 Comments 写明。

## Answer

**盘点文档**：`docs/verification/backup-inventory-20261106.md`（新建，未提交；含逐条目表格、分类理由、保留策略提案与 du 实算）。

**执行范围**：仅完成步骤 1（盘点）与步骤 2（提案）。步骤 3（脚本）、步骤 4（受控清理）未做；**未移动、未删除任何文件**，未运行 `git add`/`commit`，未启动/停止任何 App 或 `pnpm run dev`。

**分类摘要**（`backups/sqlite` 20 条目）：
- B 保留（2 份主文件，4.89 GiB）：`before-fence-restart-fix-20261106.sqlite`（schema 42，被 `docs/verification/fenced-contact-recall-coverage-and-shared-reader-fence-20261106.md`＋提交 `ed2b64e02` 登记为回滚点）、`before-image-reset-20261105.sqlite`（schema 42，第二新快照）。
- C 可删待批准（9 份主文件共 8,097,228 kB ≈ 8.29 GB）：`before-quote-tail-v2/tail-sync/target-fence-repair/quote-sync`（11-01，schema 24/26）、`before-image-placeholder-wxgf/original-image-decoding/original-image-reader`（10-31，24）、`before-legacy-guard-repair/stable-source-upgrade`（10-30，18）；它们全部存在更晚、更大、schema 更新的覆盖快照，且除 `.scratch/fenced-contact-repair/issues/02`（已 resolved）自引外无文档登记、`git log --all -S` 全部 0 命中。
- 随属清理：8 件 wal/shm（4 组备份快照的对，共 128 kB，全部 wal=0 kB，非孤儿但为非单文件遗留）＋1 个 `quote-target-fence-repair-20261101.json`（22.6 kB）。
- `dated` 备份根/其他：`contact-sync-20261103-1793699318593.sqlite`（1,388,384 kB，schema 33，C′ 自独裁决，其 `-shm` 在 11-06 23:46 被改写过 → 删前重查 lsof）；`launch/` 4 个 json 16 kB、`resumable-history-…launch-before.json` 390 B、顶层空目录 `notalone-pre-dedup-backups`（低值可清）。
- F 可再生缓存：`Cache/` 1,234,616 kB 等，**App 在跑（Electron PID 22194 持有真实库），当前不可清**，用户退出后可清。
- A 绝不动：`managed/sqlite/notalone.sqlite`＋wal/shm（活跃中）、`managed/media` 4,395,816 kB（3,874 个 `.media`）。
- E 归属未知（待用户回答）：`~/Library/Application Support/NotAlone-consolidation-20261031.M61JMC`（3,055,416 kB，内含两张 dedup-ignored 大 tar＋patch/状态文件；从顶层文件名形态疑似 10-31 合并/工作树归档遗留，不猜测）、`NotAlone DB Observer Prototype`（7,576 kB，10-30 Electron 原型 profile）、`NotAlone-Quarantine`（60 kB）。
- D 严格意义上的孤儿附属：**未发现**（每件 wal/shm 都有同名主文件）；但 4 组 wal/shm 本身是"快照被打开过"的痕迹，属 R6 规则要清理的对象。

**提案摘要**（R1–R8，详见盘点文档 §9）：只在真实库迁移/批量写入前才做 `sqlite3 .backup` 单文件快照（R1）；保留最近 2 份（R2）；docs/verification 登记的回滚点直到结案才过保（R3）；删除时机为对应验收结案＋7 天（R4）；每个新快照登记证据（R5）；快照只保留单文件、wal/shm 一并去除（R6）；`Cache/` 只在 App 退出后清（R7）；任务专用快照另行批准、任务结束即过期（R8）。是否写入 `docs/agents/engineering.md` 由用户决定，本任务未改该文件。

**可释放空间（du 实算，KiB→换算）**：
1. 主提案（9 份 C＋附属＋json）：8,097,380 ≈ 8.29 GB（7.72 GiB）。
2. ＋R8（contact-sync 三件＋launch/resumable）：累计 9,485,816 ≈ 9.71 GB（9.05 GiB）。
3. ＋R7（App 退出后清 `Cache/`）：累计 10,720,432 ≈ 10.98 GB（10.23 GiB）。
4. ＋E 中 consolidation（若用户答复可丢）：累计 13,775,848 ≈ 14.11 GB（13.13 GiB）。

**本次实际执行的命令**（全部只读；输出超长处已裁剪保留结论/退出码）：
- `du -sk`（顶层/子目录/逐条目）、`stat -f '%SB %Sm'`（逐条目）、`ls -l`、`df -h /`
- `lsof +D <backups>`（无输出，exit=0）、`lsof <真库及 wal/shm>`（Electron PID 22194 多 FD 占用）
- 12 份备份：`sqlite3 -readonly '<备份>' "SELECT max(version) FROM schema_migration"`（7 份报 `unable to open database file (14)`，5 份成功 24/24/26/33/42；7 份改用 `file -b` 头部 `user_version`，与成功样本交叉验证一致；均已如实记录）——每库仅 1 条查询，未读任何其他表
- `rg -l '<名>' .scratch docs architecture AGENTS.md backend-ts/scripts scripts`（11 备份名＋json/contact-sync/resumable/launch/consolidation）
- `git log --all --oneline -S'<名>'`（11 备份名＋contact-sync，仅 `before-fence-restart-fix-20261106` 命中 1 提交 ed2b64e02）
- `rg -n "backups/sqlite|contact-sync-|resumable-history"` 于 `backend-ts/src desktop/src scripts backend-ts/scripts`：无创建 `backups/sqlite` 的产品代码
- 核对 `.scratch/fenced-contact-repair/issues/*` 状态（02 引用方已 resolved）

**数据处理影响**：只读盘点，未读取任何备份/数据库的消息正文或联系人内容；报告中无联系人名称，`wechat-history-*` 目录仅以通配形式提及。磁盘可用 54 GiB 无变化。

**剩余风险**（详见盘点文档 §11）：① 7 份 `sqlite3 -readonly` 打开失败原因未查明（已用 file 头交叉验证兜底）；② `contact-sync-…-shm` 在 11-06 23:46 有改写痕迹 → 用户批准删除时须先重查 `lsof`；③ consolidation 内部含 tar/patch 未检查归属，靠用户回答；④ `Cache/` 类清理必须等 App 完全退出；⑤ 若走"移废纸篓"流程，空间释放要等用户清空废纸篓。

## Comments

待用户回答/批准：
1. `~/Library/Application Support/NotAlone-consolidation-20261031.M61JMC`（2.91 GiB，内含 `wechat-message-dedup-ignored.tar` 1.7 GiB、`wechat-dedup-integrated-ignored.tar` 1.19 GiB 等）是什么、可否丢弃？仓库文档无登记，按停止条件不猜测。
2. `~/Library/Application Support/NotAlone-Quarantine`（60 kB，10-30 snapshot+viewer.log）是否旧隔离功能遗留？
3. 请在对话中批准拟清理的具体文件名清单（盘点文档 §9 表列出候选与释放数字）。批准后才进入步骤 4（默认移入废纸篓，逐个核对）。`before-fence-restart-fix-20261106.sqlite`、`before-image-reset-20261105.sqlite`、真实库与 `managed/media` 默认保留。
