# 01 — 可恢复迁移命令

Triage: ready-for-agent
State: resolved
Blocked by: none

范围与测试见 ../spec.md；来源为 memory-extraction-recovery/issues/02-extraction-cli-edge-cases.md 遗留项 5。

## Comments

2026-09-22 用户确认测试边界；只使用新建隔离测试库。

## Answer

- 已增加 `python -m notalone.database_migrations --migrations database/migrations`，以文件名、SHA-256、时间记录成功版本；每文件 SQL 与账本同事务，连接中断可重跑，会话锁防止并发重复执行。
- 安装脚本改用统一命令，移除 owner 存在即跳过及手工增量清单。历史文件不修改；没有账本的旧库明确拒绝，自动接管不在本轮交付范围。
- 10 项独立迁移验收覆盖全仓库 35 个迁移、重跑、版本升级、SQL 失败回滚、账本失败回滚、连接中断、额外 COMMIT 拒绝、校验和、重复编号、旧库拒绝和并发。每项使用本机随机专用 `_test` 库。
- 命令验证：`python -m unittest discover -s tests -v` 在额外新建的随机隔离库和空环境配置下运行 979 项，结果 OK（3 项真实模型测试跳过）；`python -m compileall -q src/notalone/database_migrations.py tests/integration/persistence/test_database_migrations.py`、`zsh -n scripts/install.sh`、`git diff --check` 通过。
- Standards 与 Spec 双轴只读评审均 0 项问题。未读取真实聊天、未调用模型、未执行完整安装脚本、未迁移现有业务库；本次创建的测试库已清理。
