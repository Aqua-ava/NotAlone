# 修复 104 迁移漂移

日期：2026-10-23
State: resolved

## 原因与修复

本机已经执行的 104 与提交版本只有 `message_count` 的 `COMMENT ON COLUMN` 文本不同。库中原文为“本绑定历史同步累计写入的规范文字消息数量。”，后来文件改成了计入重叠消息的说明。表、字段与约束一致，不能因此忽略文件校验。

恢复该句后，104 的 SHA-256 精确等于原执行账本：`1c0c37ef68097621de81bdfb9a590c673f4bd30e04c34ac5f032605d59eb2580`。以新增 `107_history_message_count_comment.sql` 前向应用准确注释；没有 UPDATE、DELETE 或补写既有迁移账本，没有改变校验规则。

## 验证

- 红：`NOTALONE_TEST_DATABASE_URL=postgresql:///postgres python -m unittest tests.integration.persistence.test_database_migrations.DatabaseMigrationCommandTest.test_executed_104_upgrades_without_rewriting_its_ledger -v`，从原始104升级失败，错误为 `migration_history_mismatch`。
- 绿：同一用例通过，检查原104摘要、升级前全部账本名称／checksum／applied_at 不变、新注释生效及重复迁移不再执行。
- `NOTALONE_TEST_DATABASE_URL=postgresql:///postgres perl -e 'alarm 120; exec @ARGV' -- python -m unittest tests.integration.persistence.test_database_migrations -v`：20项通过。每例创建并清理自己的随机 `_test` 库；postgres 只用于建库管理连接，不使用共享 `notalone_test`。
- 实机：先通过应用菜单正常退出，确认 `npm run dev:status` 为 stopped；恢复源码后只读诊断从 mismatch 变为 `migration_pending`。再次以后台 `npm run dev` 启动，开发监督器和宿主存活；正常启动应用105、106、107，诊断返回 `ready`，Computer Use读取真实管理后台为“已连接”。
- 业务库只读复核：账本107项；原104摘要与执行时间均不变；历史授权表0行，没有静默授予历史读取。未手动迁移或改写账本。
- Standards / Spec 两轴独立静态审查均无发现；`git diff --check` 通过。

## 边界与后续

本修复只恢复不可变迁移并前向修订注释，正常启动补齐已批准功能的待执行结构；不删除业务资料、不扩大读取授权、不发送消息、不打包、不push。全历史同步、CLI账号核验及票08其他真实验收仍待继续。首次shell后台启动未留下进程，随后以独立会话后台执行同一 `npm run dev`，未创建第二开发实例。开发输出约3.6MiB，复用既有CLI构建目录约838MiB，磁盘可用151GiB；未新增整包产物。
