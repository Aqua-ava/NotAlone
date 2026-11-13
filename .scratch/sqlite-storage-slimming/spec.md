# SQLite 业务库瘦身

> 状态：待用户确认方案。本文只记录只读分析的证据和拟定方案，尚未改动任何代码、迁移或数据。
> 数据来源：开发机本机业务库的只读元数据统计（表大小、行数、列字节数、状态分布），未读取任何聊天或联系人内容；下列数字是该开发库的快照，不代表正式用户。

## 用户问题

本机业务库 `managed/sqlite/notalone.sqlite` 约 1.9GB，普通打开时的完整性检查和后台连接明显偏慢（一次开发启动中后台从 `connecting` 到 `connected` 用了约 13 秒）。需要弄清库为什么这么大、哪些是可避免的膨胀，并在不破坏来源追溯与删除链的前提下瘦身。

## 现状证据

库内共 95 张表，其中 9 张为空、41 张不足 100 行。前 5 张表加索引约 1.5GB，占总量的绝大部分，所以体积问题不来自表的数量。

| 表 | 行数 | 表 MB | 索引 MB | 说明 |
| --- | ---: | ---: | ---: | --- |
| `read_goal` | 119,223 | 471.6 | 39.0 | 同步读取目标，每个读取任务一行 |
| `sync_capture` | 557,810 | 246.9 | 129.1 | 每次接受一页的抓取批次记录 |
| `capture_record` | 185,415 | 180.3 | 161.4 | 抓取到的单条记录，含 `raw_payload` |
| `message` | 164,150 | 79.0 | 134.6 | 规范化聊天消息 |
| `message_alias` | 184,077 | 78.3 | 78.0 | 消息别名键 |

全库表合计约 1,220MB，索引合计约 656MB（约 35%）。

### 膨胀点

1. **空抓取**：`sync_capture` 中 534,725 行（约 96%）没有任何 `capture_record`。增量同步每接受一页（含“没有新消息”的空页）就写一行，见 `backend-ts/src/history/sqlite/actions.ts` 增量页接受处。连同索引约 376MB 的表中约 96% 是这类行。
2. **重复的 JSON 列**：`read_goal` 的 `support_json`（约 1,250B/行，共 142MB）、`target_json`（约 1,050B/行，共 119MB）、`eligibility_json`（约 596B/行，共 68MB）合计约 330MB。11.9 万行里 `support_json` 仅 4,814 种不同值，`eligibility_json` 仅 1,693 种，`target_json` 有 69,499 种。
3. **终态读取目标只增不减**：`read_goal` 状态分布为 history/complete 47,328、history/invalidated 22,046、incremental/invalidated 49,500、running 共 349（history 125、incremental 224）。作废占约 61%，涉及 285 位联系人，平均每位约 400 张。已确认 `continuity.ts` 在运行时重新校验（`history_runtime_revalidated`）时会把该联系人进行中的目标全部作废再新建；**开发时热更新频繁重启后台很可能是主要放大因素，但尚未逐次验证**，正式用户的增长速度应慢得多，但同样没有上限。
4. **长文本 ID 与 `owner_id` 重复**：主外键普遍是 36 字符文本 UUID，`owner_id` 在每行重复。这是索引体积偏大的原因之一，但改动面覆盖全库，本规格不处理。

### 已核对的相关约束

- 删除：`backend-ts/src/storage/sqlite/deletion/` 的统一删除模块要求每种行在领域注册里声明复合主键和 `ownerKey`，新增表必须注册；`secure_delete` 已开启。
- 结构基线：`backend-ts/src/platform/cutover/structure.ts` 与 `backend-ts/test/sqlite-cutover-structure.test.mjs` 固定了表结构基线，新增或修改表需同步更新。
- 打开校验：普通打开已改为 `quick_check`（提交 `a496bb823`），迁移、升级与显式 `check()` 仍做完整 `integrity_check`。

## 方案

按收益和风险排序，每项独立成任务：

1. **空抓取不再逐页落行**（[01](issues/01-empty-capture-compaction.md)）：先核实空抓取的所有依赖，再让空页只更新游标与计数，并对存量空抓取做一次性清理。预计影响最大（约 360MB 量级的粗估）。
2. **读取目标 JSON 去重**（[02](issues/02-read-goal-json-dedup.md)）：把 `support_json`、`eligibility_json` 按内容摘要存入一张去重表，`read_goal` 只存引用。粗估可省约 200MB。
3. **终态读取目标的保留与源头减量**（[03](issues/03-terminal-read-goal-retention.md)）：评估“重新校验时复用目标而非作废再新建”，并为已作废／已完成的旧目标定义保留期。
4. **整理与实测**（[04](issues/04-vacuum-and-measure.md)）：清理后做 `VACUUM`，并用同一工作负载对比大小、完整性检查耗时与后台连接耗时。

粗估各项互相重叠，合计约 600–800MB，**是估算，不是承诺**；以任务 04 的实测为准。

## 进展

- 任务 01 已完成（`df643ec52`）：新增空页每个增量目标只留最新一条，并建 `sync_capture(owner_id, goal_id)` 索引；存量未批量清理，原因见任务 01 的 Answer。该项对已有数据的收益要等任务 03 的分批清理才能兑现。

- 任务 03 已完成（`0f9d15fab`）：创建新读取目标时分批清理无用旧目标；真实库副本实测整库由约 1.98GB 降到约 1.39GB。重新校验时复用目标的方案因 `goal_immutable` 不采用。新增迁移 41（`capture_record` 外键子表索引）。
- 任务 02 决定不做（wontfix）：JSON 去重改动面大，收益在 03 之后仅约 80MB，见任务单。

## Implementation Decisions

- 来源追溯优先：任何删除或合并之前，先证明没有读取路径、删除链、续读或验收依赖被清理的行；证明不了就保留。
- 数据变更走已有迁移注册机制，随版本发布；不在运行时偷偷改旧库，不手工改用户库。
- 新增去重表必须按统一删除模块的要求登记行种类与所有者，并更新结构基线和对应测试。
- 清理由后台在安全点执行，不阻塞启动，不改变总开关、授权与联系人隔离（`owner_id + contact_id`）语义。
- 完整 `integrity_check` 保留在迁移、升级和显式检查中，不因瘦身放松。

## Testing Decisions

- 每项任务先建立“清理前后行为不变”的测试：增量续读、游标恢复、重复页幂等、删除链、来源追溯、结构基线。
- 用合成数据生成接近真实比例的测试库（大量空页、重复 JSON、作废目标）验证迁移与清理，不用真实聊天夹具入库。
- 性能结论使用相同工作负载对比修改前后，记录大小、`quick_check`／`integrity_check` 耗时和后台连接耗时。

测试 Seam：`SqliteStorage.open` 加注册表模块（`registryModule`）可注入迁移；`sqlite-storage.test.mjs` 与 `sqlite-cutover-structure.test.mjs` 为现成入口。

## Out of Scope

- 把文本 UUID 主键改为整数代理键、移除逐行 `owner_id`：改动覆盖全库，收益不明确，另行评估。
- 调整 `message`、`capture_record.raw_payload` 等保存来源内容的表的保留策略。
- 放松或跳过任何完整性检查。
- 打包、发布和真实用户库的线上迁移（需用户明确发起发布任务）。

## 待用户确认

1. 是否接受“空抓取不逐页落行”这一行为变化（需先通过任务 01 的依赖核实）。
2. 旧的已作废读取目标是否允许设保留期，还是必须永久保留作审计。
3. 是否优先在源头减少作废再新建，而不是事后清理。

## Comments
