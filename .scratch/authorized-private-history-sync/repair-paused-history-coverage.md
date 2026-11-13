# 08 验收阻碍修复：关闭同步仍展示已保存的历史覆盖

日期：2026-10-23。本笔只改本地状态查询；所有新增测试使用合成资料，未操作真实微信、调用真实 CLI 或读取真实业务库。

## 根因与修复

实际 App 关闭总开关后显示已确认范围为零、覆盖列表为空，而持久数据仍在，重开后恢复。代码中关闭分支把 `bound_count` 写死为零，并只返回对象内存中的覆盖缓存。热关闭时绑定计数必然错误；在关闭状态下冷启动时，缓存尚未建立，覆盖列表也必然为空。`close()` 本身不清除覆盖缓存，不能把实际列表为空归因于该函数删除了覆盖数据。

这不符合票 05 的按联系人展示覆盖与汇总，以及 ADR-100 的独立持久覆盖状态语义：总开关控制新读取，不撤销已保存的授权或覆盖。

关闭分支先停止运行资源，再仅读取本地 active 绑定与历史状态；继续返回 `disabled`、无运行流及零新增消息。覆盖保留完整、不完整及原因、已保存计数；没有任务的绑定展示尚未开始，不补建任务。已撤销绑定从报告及旧缓存移除。元数据读取失败保留上次可用信息并给出稳定错误码，后续读取成功清除错误，不调用微信 CLI、解析会话、启动流或推进历史检查点。

宿主原有关闭状态冷启动播种一轮、随后不循环的行为保持。桌面现有视图会展示返回的持久覆盖，无需修改 UI 或状态协议。

## 红绿与验证

Python 命令均在 `backend/` 执行，使用 `PATH="$HOME/miniconda3/envs/NotAlone/bin:$PATH"`。集成数据库独立使用 `NOTALONE_TEST_DATABASE_URL=postgresql:///notalone_08_paused_test`。

- 红：`python -m unittest tests.unit.front_sync.test_cli_history_sync.HistorySyncEngineTest.test_disabled_cold_start_reads_saved_coverage_without_cli_or_jobs tests.unit.front_sync.test_cli_history_sync.HistorySyncEngineTest.test_disabled_hot_stop_preserves_binding_count_and_coverage`，两个断言均为 `0 != 1`。修复后同一命令 2 tests 通过；同时断言 CLI 命令数不变、状态不变、无新任务和写入。
- `python -m unittest tests.unit.front_sync.test_cli_history_sync tests.integration.persistence.test_cli_history_sync`：49 tests 通过（1.706 秒）。新增 PG 路径核对关闭状态重建引擎后完整/不完整覆盖和原因、游标与检查点原样保留；从未开始的任务不创建；热关闭后撤销绑定只改变展示范围。
- `python -m unittest discover -s tests/unit/front_sync -t .`：265 tests 通过（5.390 秒），含元数据读取失败后恢复清码。
- `perl -e 'alarm 120; exec @ARGV' -- python -m unittest tests.integration.persistence.test_cli_history_sync tests.integration.persistence.test_cli_pagination_sync tests.integration.server.test_sync_api tests.unit.server.test_sync_host`：77 tests 通过（3.134 秒）。
- 新库初次迁移命令误用仓库根目录下不存在的 `database/migrations`，随后一轮集成被跳过，未计为通过。改为 `NOTALONE_DATABASE_URL=postgresql:///notalone_08_paused_test python -m notalone.database_migrations --migrations backend/database/migrations`（仓库根目录）后，107 份迁移成功，再实跑上述 PG 测试，无跳过。

本票此前完整 Python 验证已于 600 秒退出 142，过程中有 F/E、没有最终摘要；本笔没有再次运行该整套，也不宣称全量通过。没有前端修改，不重复前端全套。

## 实际 App 关闭状态核验

以下为主 Agent 的独立真实证据，未使用合成测试替代：`npm run dev` 热更新后，总开关始终关闭。认证后的 `/api/sync/status` 返回 `sync_enabled=false`、绑定 290、覆盖 290（287 完整、3 不完整），项目 CLI 进程数为零。主 Agent 通过实际 NotAlone 同步设置页核对“后台读取已关闭。已确认范围：290个会话”，关系资料仍单列。此次只查询本地 DB/API 并操作 NotAlone；没有操作微信或发起新的微信读取。

## 审查与收尾

本笔三个代码/测试文件和本记录以 `4d9f0f26` 为固定审查基点，两位未参与本笔实现的 Agent 分别完成独立 Standards / Spec 审查，均为 0 个可操作问题。Spec 审查另独立运行纯合成 history 单元模块，27 tests 通过。

`notalone_08_paused_test` 已删除并查询确认不存在；`git diff --check` 通过，`node scripts/check_public_history.mjs --ref HEAD --working-tree` 返回 0 个问题。未修改迁移、账本、真实绑定、历史记录或授权设置；未 push。
