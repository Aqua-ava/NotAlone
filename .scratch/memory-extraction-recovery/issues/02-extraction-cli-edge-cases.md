# 提取链路与 CLI 边界遗留项（第二轮审查）

Triage: needs-triage
State: open

## 背景

2026-09-18 第二轮只读审查发现。同轮已修复：裸 `psycopg.OperationalError` 不可重试（`_failure_info` 增补）、`normalize_cli_events` 空 talker 恒真退化、`run_worker` 注解 NameError、前台会话多个同名候选各自绑定时的列表序静默确认（matcher 按"已绑定同名候选数 > 1 才要求选择"收紧，保留显式选择后单一绑定自动识别的既有集成契约；残余风险：单一绑定 + 其他同名未绑定会话仍自动归入绑定方，若前台切换到另一个同名会话会串数据，属既有集成契约接受的取舍）。以下为遗留项。

## 遗留项

1. **extract_main 对不存在的联系人静默成功**（`memory_extraction/command.py:295-302`）：不存在的 `--contact-id` → 空消息 → `batches=0 …` exit 0；失败文案暗示有联系人检查（对比 worker_main 有 `contact_exists`）。脚本化调用无法区分"没有消息"与"联系人不存在的误输入"。
2. **memory_add/memory_list/memory_delete 三个 CLI 入口对非法 `NOTALONE_OWNER_ID` 直接裸 traceback**（`command.py:366,439,490`）：`UUID(owner_id)` 无 try/except，与 extract_main/worker_main 的友好报错不一致。
3. **裁决失败路径丢失本批提取统计**（`memory_extraction/command.py:146-154`）：`adoption.adopt` 抛错时 outcome 被失败 outcome 整体替换，flow 已返回的 `rejected_count` 丢失、本批通过契约的 facts 不再计入 `extracted`。统计口径漂移，不影响数据正确性。
4. **extract_main 的 `--batch-size 0/超 20` 未包装**（`command.py:319` → `run_extraction` 的 ValueError）：需 DB 与 key 就绪才可达，报错形态与 CLI 其他错误不一致。
5. **install.sh 迁移幂等声明不覆盖"中途失败后重跑"**（迁移执行段）：以 `public.owner` 存在作为"已初始化"标记整体跳过迁移；全新安装若在 001-025 中途失败，重跑永久跳过剩余迁移。注意增量清单是手工硬编码：新增迁移（036+）必须同步追加（035 已按此追加）。建议改为按迁移记录表逐个应用。
6. **naive datetime 防御不一致**（`observation_store.ensure_baseline`、`conversation_repository.create_cli_bindings_batch`）：接受 naive datetime，写入 `timestamptz` 按数据库会话时区解释；构造函数允许注入 naive 时钟时 baseline 偏移一个本地 UTC 偏移量。仓库其他路径（`background_tasks.cleanup_terminal_tasks`、`memory_store._now`）明确拒绝 naive，此处防御不一致。
7. **同批次重试会改写"不可变"来源行的统计计数**（`observation_store._insert_observation` 重试路径 `UPDATE event_count/non_text_count/is_reliable`）：批次身份键不含计数，同一键携带不同计数重试时历史统计被静默改写（`record_count` 不更新）。
8. **naive `time_iso` → UTC 假设与 CLI 契约待核对**（`normalizer._occurred_at`，`test_naive_time_iso_is_interpreted_as_utc` 固化）：若真实 CLI 对缺 create_time 的事件输出无时区本地时间（微信场景 +08:00），发生时间整体偏移 8 小时。需要用真实 CLI 输出核对一次契约；若确认为本地时间需按中国偏移处理或拒绝。

## 为什么测试没抓到

extract_main 空分支需真实 DB fixture；三个 memory CLI 入口无非法 env 用例；失败统计路径只断言 failed_batches/skip；安装脚本无自动化测试；naive 时钟夹具一律 aware；observation 重试测试传相同计数。

## Answer

2026-09-18 第三轮已修复：install.sh 的 keg-only `postgresql@16` 安装后 psql/createdb 不可达（安装后重解析并把公式 bin 补进 PATH）、`.env` 先以受限 umask 创建再写入、冷启动连接改为有界重试（10×2s）、conda 环境探测覆盖自定义路径注册；新增迁移 035 补齐 `memory_extraction_watermark` 对 contact 的外键级联（先清孤儿行——notalone_test 实际清理了 443 条孤儿——DO 块约束守卫，重复执行幂等验证通过），并同步追加进 install.sh 增量清单；watermark store 集成测试夹具改为真实 owner/contact 并新增级联回归测试。

2026-09-18 本轮已修复遗留项 1、4：`extract_main` 在空消息成功分支前验证 `owner_id + contact_id`，不存在或越界时返回 1；`--batch-size` 在构造数据库和模型组件前限制为 1–20，并输出稳定中文错误。CLI seam 单元测试覆盖两个失败分支。其余遗留项尚未处理，本 ticket 保持 open。

## Comments

2026-09-22：遗留项 5 已在 `.scratch/migration-and-sync-boundary/issues/01-migration-runner.md` 完成。统一版本账本取代 owner 跳过判断与手工清单；10 项隔离迁移验收及全量 979 项测试运行通过（3 项真实模型测试跳过）。无记录旧库拒绝并提示核验，未迁移现有业务库。本票其他未完成项保持 open。

- 2026-10-04：收尾分类并关闭。8 条遗留项中 5 条已由后续提交修好（不存在的联系人不再静默 exit 0、三个入口的非法 `NOTALONE_OWNER_ID` 不再裸 traceback、`--batch-size` 提前校验、`install.sh` 改用统一迁移命令、裁决失败保留本批统计），均带单测；`tests/unit/memory_extraction` 178 项、全量单元 733 项通过。
- 2026-10-04：第 6 条（naive datetime 防御不一致）已修：`observation_store.ensure_baseline` 与 `ObservationBaseline`、`conversation_repository.create_cli_bindings_batch` 统一为“必须是带时区的 datetime”，与 `background_tasks`／`memory_store` 口径一致；新增 `tests/unit/persistence/test_naive_datetime_guards.py` 用假 DSN 证明校验发生在连接之前。
- 2026-10-04：仍留在票面、需要真实数据或产品决定的两条如实保留：①`--batch-size` 之外的批次重试语义与 `record_count` 统计口径（需要真实微信 CLI 数据分布）；②CLI naive 时间戳按本机时区换算还是直接拒绝（属外部 CLI 契约选择）。两者都不阻塞本票关闭，已在上文标注为限制。
