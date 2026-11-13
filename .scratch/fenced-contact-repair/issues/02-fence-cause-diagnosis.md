# 02 查明围栏成因

Triage: ready-for-agent
State: resolved
Type: research
Blocked by: 无（不阻塞 01、03、04）

规格：[../spec.md](../spec.md) 第 1.3 节。

## 问题

2026-11-01 验收结束时围栏清零（285/285 完整覆盖，`docs/verification/source-recertification-20261101.md`）。2026-11-05 查询到 279 位联系人带围栏，原因码都是 `history_source_continuity_unverified`。围栏表只有 `reason`，没有时间戳和触发点，所以不知道是什么时候、因为什么出现的。

## 要回答

1. 围栏大约在什么时间段出现？（限定在 11-01 之后到 11-05 之间）
2. 是一次性同时出现，还是陆续出现？
3. 最可能的触发路径是 `backend-ts/src/history/sqlite/actions.ts` 里 `fenceContinuity` 的哪一个调用点（guardAcquire 不匹配、旧数据无守卫记录、guardRelease 非正常或 sourceLost、markContinuityLost）？
4. 具体原因更接近下面哪种：旧读取程序一张图失败就关闭共享进程；微信 11-03 重建数据库；开发 App 热重启或被强制结束；读取程序崩溃；其他。
5. 修复后还会不会再出现？换上新读取程序后有没有残留风险？
6. 顺手：2 位没有被围栏、有 182 条图片消息的联系人，为什么至今 0 张已保存、0 次尝试？（可能没有有效绑定或授权）

## 怎么查（只读）

- 数据库只读：`sqlite3 -readonly` 加 `perl alarm` 上限；避免相关子查询。可用的线索：`history_guard_lease`（state、runtime_id）、`database_instance`、`history_source_recertification` 的时间、`contact.source_revision`（围栏会使它 +1）、`media_extraction_attempt` 里 `history_source_unverified` 的时间分布（127 次）。
- 文件时间：开发日志、`backend-launch.json` 与其备份的修改时间、读取程序制品目录时间、`~/Library/Application Support/NotAloneDesktop` 下相关文件时间。
- Git 历史：`git log` 中共享进程（ADR-151，2026-11-02）、单图失败隔离（`8436fb54a`、`14902064b`）的落地时间。
- 其他会话的记录（`mcp__ccd_session_mgmt__list_events`）里提到过的重启、强杀、微信升级。
- 只读，不改数据，不重启 App，不修复任何联系人。

## 产出

在本文件追加 `## Answer`：对 1–6 逐条给出结论和证据，标明哪些是实证、哪些是推断。不含名称与正文。若发现仍会持续制造围栏的路径，另开任务单，不在这里修。

## Answer

> 只读调查（`sqlite3 -readonly` / python `mode=ro`，均外包 `perl alarm`），未改数据或源码、未重启 App、未修复任何联系人。以下只有计数、时间、原因码与哈希，不含联系人名称、ID 明文或聊天正文。【实证】= 直接查到的数据或文件；【推断】= 由代码与数据推出，不能单独证明。
>
> 用到的快照（均只读）：11-04 19:49 的整库副本（性能会话）、11-05 12:58 的整库备份 `backups/sqlite/before-image-reset-20261105.sqlite`、11-05 约 20:20 的整库 `.backup` 副本（3m 隔离夹具，随后仅删 fence/lease）、当前业务库（22:5x–23:2x 只读）。

### 0. 基线计数

- 当前：`history_continuity_fence` 279 行，原因码全部 `history_source_continuity_unverified`；活跃联系人 281，7 位已删除；`history_guard_lease` 281 行全部 `lost`。
- 11-05 12:58 快照：fence 2 行、联系人 285 活跃/2 删除、guard 285 全部 `lost`；`media_extraction_attempt` 21565 行（最后 11-05 01:04）。
- 11-04 19:49 快照：fence 0、guard 284 active/1 lost、recert completed 43；说明 11-01 清零后到 11-04 晚仍为 0。
- 11-05 ~20:20 快照：fence 已被夹具脚本删除，但 281 位活跃联系人的 `source_revision` 与当前完全一致（见 1）。

### 1. 围栏大约在什么时间段出现？

**结论：11-05 12:58 之后、17:48:24 之前；最可能是 11-05 17:48:06–17:48:24 的一次运行启动过程中写入。【实证】+【推断】**

【实证】
- 11-04 19:49 整库副本 fence=0；11-05 12:58 整库备份 fence=2，且这 2 条现在仍在（fence 表 rowid 1、2），说明其余 277 条新围栏都产生在 12:58 之后。
- 对比 12:58 快照与当前 `contact.source_revision`：276 位活跃联系人各恰好 +1，另 4 位活跃为 +0；其余 1 位活跃联系人是 12:58 之后新建（不在对比集）。说明 12:58 后每一位只被围栏一次、只发生一轮插入。
- 11-05 20:18–20:27 做的整库 `.backup` 副本（3m 夹具，只删了 fence/guard 两张表）里，281 位活跃联系人的 `source_revision` 与当前完全相同 → 那轮 +1 发生在这个副本之前（≤20:18）。
- 11-05 17:48:06–17:48:24 存在一组唯一的活跃：127 条 `media_extraction_attempt`（`adapter_version=image-preflight-v1`，专用运行代次 `dedeecea…`）在 18 秒内全部失败，错误码 `history_source_unverified`，分别来自 127 位不同联系人；这 127 位当前全部带围栏。而 `media.imageSyncTargets` 的 SQL 明确 `NOT EXISTS (... history_continuity_fence ...)` → 17:48:06 计算取图目标时这 127 位尚未被围栏，围栏是在这 18 秒内出现/写入的。
- 17:35 之后到 20:18 之间，业务库除上述 127 条尝试外没有其它活动：`sync_capture` 为 0、无新增 `read_goal`、无新增 `media_file`、无 `model_call`/删除操作。

【推断】
- 17:48 出现了一个新的后端运行代次（有 127 条该代次的尝试记录），它在启动扫描时对每位联系人尝试来源准备/读取都得到失证，从而批量写围栏；之后没有任何页面读取。
- 该代次没有留下 dev 日志（`/tmp/notalone-dev.log` 已被 19:50 那次启动覆盖），各会话 transcript 里也没有对应启动调用 → **无法证实是谁/什么在 17:48 启动了这次运行**（推断为用户手动启动或未登记在工作树会话里的运行）。围栏表无时间戳，只能靠上述旁证定位到分钟级。

### 2. 是一次性同时出现，还是陆续出现？

**结论：一次性单批，不是跨天陆续出现。【实证（计数）】+【推断（批次）】**

- 279 条围栏只有一种原因码；277 条新围栏对应每联系人 `source_revision` 恰好 +1（无 +2/+3），若是多轮陆续发生，应出现 +2 以上。
- fence 表 rowid 集中在连续区间 1..282：现存 279 行，缺 94、109、129。缺的 3 条可由 11-05 20:00、21:26、21:33 三次联系人硬删除解释（删除闭包会清理该联系人的围栏）；12:58 时只有 rowid 1、2 两行，故 3..282 共 280 次插入都发生在这之后、且是一次批量。
- 13:47、15:02、15:37、17:27 这几次运行都还在正常读取历史（`sync_capture` 分别为 2016/459/4697/1857 页）并成功取图 206 张，17:35 后所有读取/取图活动同时归零；没有"先围一部分、其余继续读"的分段特征。
- 无法证明 277 条在同一个 SQL 事务内，但时间窗 ≤ 约 20 秒，属同一批量事件。

### 3. 最可能的 `fenceContinuity` 调用点

**结论：最可能是 `history.markContinuityLost`（任务单第 4 项）。【推断，代码+数据一致】**

依据：
- 17:48 那次运行**没有成功读取任何历史页**（17:35 后 `sync_capture` 为 0）、没有新建 `read_goal`、也没有任何图片取图成功 → 失败发生在"读前重验之后、建立目标/页读取之前"。
- 127 条准备失败记录的错误码是 `history_source_unverified`（读取程序/来源层失证码），而 TS 侧严格预检失败抛的是 `history_source_continuity_unverified`。前者正是 `continuity.ts:8` `lostCodes` 的成员，会被 `SqliteHistoryService.withChannel` / `ensureSourceReady` 的 catch 判定为 `isSourceContinuityLost`，然后执行 `history.markContinuityLost`（`actions.ts:140-143`）→ `fenceContinuity`。
- 排除其它三项：
  - guardAcquire 不匹配（第 1 项）：`history.readPreflight` 在 276 位联系人的数据上都应先命中 metadata-only 重验——实测 279 位被围栏联系人的最新 `read_goal.support_json` 全是 normal-use 支持档（`same-source-instances-normal-use-v1`），且 17:48 token 的 binding/conversation/source_generation 与当前 verified binding、guard lease、continuity scope 全部一致；因此不会先走严格预检造围栏。
  - 旧数据无持久守卫记录（第 2 项）：276 位都有 guard 行。
  - guardRelease 非正常/`sourceLost`（第 3 项）：该次运行在失败前没有成功取得守卫，没有对应的 release 痕迹。
- 无法证实读取程序内部具体是哪一个 Go 检查失败（`ensureMessageGuard` 的进程/文件/守卫校验，或 inspect 阶段的其它来源校验）：Go 日志未留存、微信数据目录受 macOS TCC 限制不可读。

### 4. 具体原因更接近哪种？

**结论：最接近"其他"——读取程序在该次启动时对全部联系人报来源失证，上游很可能是微信本机来源在 11-05 17:25 之后的某种变化或读取程序建立来源守卫失败。【推断，无法进一步证实原因】**

逐项判断：
- 旧读取程序一张图失败就关闭共享进程：**不成立**。17:48 只有 image **准备**（`adapter_version=image-preflight-v1`）失败，没有 image-open 请求；该缺陷在 16:50 `8436fb54a`、17:07 `14902064b` 已修，17:27 那次运行还成功保存 206 张图片。
- 微信 11-03 重建 `message_resource.db`：**不成立**（时间不符；17:27 与 17:48 两次 token 的 `source_generation` 相同；12:58 只有 2 条围栏）。
- 开发 App 热重启或被强制结束：**不成立为主因**。17:35 是正常退出（`backend-launch.json` 未变、读取进程 0）；17:48 是新启动；此前 13:47/15:02/15:37/17:27 多次重启都能正常重验并继续读取，单纯重启不会批量造围栏。
- 读取程序崩溃：**无证据**（无崩溃日志、无共享进程异常重建记录）。
- 追加的一个可证实旁证：微信主进程从 11-05 17:25:14 起一直运行到当前（未再重启），所以 17:48 不可能是"微信没开"导致的失证；但 17:25 微信是一次新启动，其后到 17:48 之间可能有数据/文件层面变化（当前无法读取微信数据目录来核对）。
- 因此最接近：某次启动时读取程序对每位联系人都返回来源失证（TS 侧按失证处理并写围栏），具体触发条件（来源文件集合/结构变化、守卫建立失败、别名/凭证不匹配等）**无法证实**。

### 5. 修复后还会不会再出现？新读取程序有哪些残留风险？

**结论：由"图片失败关共享进程"这一条链路的批量围栏不会再因取图触发；但"读取程序报来源失证 → markContinuityLost 批量围栏"这一类风险仍然存在，新读取程序没有消除它。【推断，代码依据】**

- 已消除的：image-open-local 制品只对 5 个已查证单图码保留共享进程，来源类错误仍会关进程（按设计）；17:27 的 206 张成功取图证明正常路径可用。
- 残留风险（代码仍然如此）：
  - `continuity.ts:8` 仍把 `history_source_unverified` 列入 `lostCodes`；`service.ts` 的 `withChannel` catch 仍会调用 `history.markContinuityLost`；`actions.ts:140-143` 仍直接写围栏。围栏唯一清除方式是逐位"修复同步"。
  - 因此只要出现让读取程序对**大多数/全部**联系人报 `history_source_unverified` 的全局条件（微信未运行/多开、来源文件或 schema 变化、制品别名/凭证缺失或不匹配、守卫建立失败、微信版本变化导致认证不通过等），下次启动就可能再次批量围栏。本次 17:48 事件正属于这一类，而不是已修复的图片链路。
  - 建议（只记录，未实现、不应在本任务外顺手改）：在历史/图片读取前增加"微信进程唯一且来源守卫可建立"的只读预检；把基础设施性/瞬时性来源守卫不可用与真实来源失证区分开，前者按 blocked/transient 处理而不写围栏；并在批量修复前后核对围栏数与 `source_revision`。另注意围栏期间图片退避可能已进入 24 小时档（spec 第 9 节），修复后不会立刻重试。
- 已知限制：旧读取程序（image-pick-standard）在来源类错误时仍会关闭共享读取进程（`docs/verification/image-open-isolation-20261105.md` 的对照表），只是单图错误不再关进程；这次事件后已切换到 image-open-local，但上述"失证→围栏"代码路径未改。

### 6. 顺手：2 位没有被围栏、有 182 条图片消息、0 张已保存、0 次尝试的联系人

**结论：它们的读取授权已被撤销，属于"身份变更后停读等用户重新确认"，不是图片或围栏缺陷。【实证】**

- 两位分别是 180 条、2 条图片消息；两者都**没有 verified `conversation_binding`**，也没有 `revoked_at IS NULL` 的 `read_grant`：各有一条读取授权在 **11-05 15:43:23 因 `display_name_changed` 被撤销**（此前 10-31 还各有一次 `account_changed` 撤销）；binding 为 `needs_confirmation`（一位另有 `revoked`）。
- `media.imageSyncTargets` 的工作集 SQL 要求存在未撤销 read_grant + verified binding，因此这两位被直接排除：尝试 0 次、保存 0 张（其中一位在 13:58 缺密钥期间有过 1 次 `media_association_unverified` 尝试，属撤销前的历史记录）。
- 历史协调器同样不会读取它们，所以它们也不会产生围栏（围栏只在仍有资格、被尝试读取时出现）。
- 恢复方式只能是用户重新确认这些会话的读取范围；不在本任务范围。

### 限制与未能证实

- 围栏表、guard lease 表都没有时间戳；时间只能由相邻快照、`source_revision` 增量、`media_extraction_attempt` 时间与各表活动缺口反推。
- 17:48 那次运行的 dev 日志已被 19:50 的启动覆盖（`/tmp/notalone-dev.log` 只剩 19:50–20:27）；各会话 transcript 中没有对应启动调用，无法确认启动者。
- 微信数据目录（`~/Library/Containers/com.tencent.xinWeChat/...`）受 macOS TCC 限制不可读，无法核对 17:35–17:48 之间微信文件/mtime 变化。
- 127 条尝试记录的失败码只有 `history_source_unverified` 一层；取图准备路径之外的读取失败（历史读取 run 内）没有同样口径的错误落库，因此"全部联系人同时报失证"的直接证据是围栏 + 活动停止，无法逐条复原读取程序的返回。
- 未尝试复现（不允许重启 App、改动数据或运行读取程序）。

## Comments
