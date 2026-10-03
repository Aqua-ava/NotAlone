# 02：失败任务的业务恢复入口

Triage: ready-for-agent
State: resolved
Type: task
Blocked by: 01

**What to build:** 用户通过 HTTP 或 CLI 明确恢复指定联系人已失败的原任务，并能继续执行至完成。

- [x] 自动重试耗尽的失败任务通过公开 HTTP 恢复，复用原任务、已成功步骤不重复执行。
- [x] CLI 提供对应显式恢复入口，遵守现有预检查和全局串行规则。
- [x] 跨用户、跨联系人、缺失、未失败的任务，以及来源已进入删除路径的导入任务不能被恢复；既有删除任务遵守自己的来源状态许可。
- [x] 错误和状态只显示必要元数据，不复制正文；不新增自动重试预算或隐式重建任务。
- [x] 公开接口先验证失败，再完成最小修复和相关回归，双轴审查并独立本地提交。

## Comments

01 建立真实 HTTP/数据库反馈回路后执行本任务。审查基线 fba6fa5，仅审查本任务变更。

## Answer

实施、专项验证和双轴审查完成，与本记录一起独立本地提交。

- 导入提交返回原 `task_id`。`POST /api/tasks/retry` 接收显式 `contact_id + task_id`，只把同范围失败原任务恢复为 `queued`；随后用户显式 `/api/tasks/run` 可固定执行该任务。`GET /api/tasks/status` 指定任务时读取 PostgreSQL 的任务及步骤元数据，宿主重启或未装配时仍可查看。无 `task_id` 的执行与宿主进度查询保留原输入契约。
- CLI 增加 `--retry-task-id`；数据库、owner、联系人和模型预检查全部完成且取得全局锁后才恢复。锁忙或准备失败不改变失败任务。指定任务贯穿命令、Worker 与原子领取，较早的其他排队任务不会被执行。任务宿主使用真实业务任务身份报告进度，内存状态按 `owner_id + contact_id` 隔离。
- 恢复与来源状态检查处于同一联系人事务及行锁内。导入只允许 `active` 来源；删除允许 `delete_requested/deleting/delete_failed/deleted`，真实删除后的失败验证仍可续跑。步骤 `attempt_count` 每轮重置后仍最多自动尝试三次；任务 `retry_count` 累计失败和恢复。没有 schema、提取/核验/采纳算法或自动模型预算变更。
- 新增 10 个公开 HTTP/CLI 合成回归。模型暂时不可用由脚本化模型边界触发，业务 Worker、导入、状态存储与删除均为真实模块。覆盖三次耗尽、成功步骤不重做、指定原任务、第二轮三次预算、联系人/用户隔离、缺失与未失败拒绝、来源删除路径拒绝、实际删除后的验证恢复、宿主重启、CLI 预检查与全局锁忙、畸形任务身份拒绝。
- 提取不继承 `TestCase` 的共享核心夹具供 01/03 使用；01 的原测试体经 AST 比对保持全部断言且实际运行通过。旧首导入 JSON 期望增加原 `task_id`，同时验证重复导入复用身份；旧宿主 fake 补齐真实结果契约。

实际观察的 RED：公开导入缺少任务身份；删除请求中的导入恢复错误地返回 `queued`；CLI 未识别恢复参数；空或重复空任务查询错误地返回 200。分别最小接线后通过。

专项验证在 Conda `NotAlone`、`NOTALONE_DISABLE_DOTENV=1` 下执行。每次新建随机 `_test` 库、应用正式迁移，并在 `finally` 或类清理中删除；没有使用业务库、业务 `.env`、真实聊天或外部模型。

```bash
python -m notalone.database_migrations --migrations database/migrations
python -m unittest \
  tests.integration.server.test_failed_task_recovery \
  tests.integration.server.test_core_business_flow \
  tests.unit.application.test_import_service \
  tests.unit.tasks.test_command \
  tests.integration.server.test_import_task_api \
  tests.integration.tasks.test_worker \
  tests.integration.tasks.test_task_retention \
  tests.integration.persistence.test_source_deletion \
  tests.integration.persistence.test_source_reply_deletion \
  tests.integration.server.test_first_import_api \
  tests.integration.server.test_server_command -v
```

最终相关回归 **87 tests，全部通过**。相关文件 `python -m compileall -q` 与本任务路径 `git diff --check` 通过。一次扩展回归的自建库名前缀过长被 PostgreSQL 截断，库名检查阻止了六个类执行；缩短名称并确保不超过 63 字符后重跑通过。SSE 关闭与既有子进程测试仍可能打印连接重置诊断或资源警告，未扩大本任务修复其生命周期。

数据处理影响：新增端点只返回内部任务身份、状态、计数、步骤和错误分类，不复制聊天正文、联系人名称、来源文件名或模型输入输出；没有外部发送能力。验证证明合成核心模块的恢复接线，不证明真实模型质量或微信现场集成。

主 Agent 按固定基线 fba6fa5 分别审查 Standards／Spec。Standards 最初发现 1 项 P3 文档冲突；补充 ADR-034 并同步 ADR-018、索引、README 与 spec 后，复核无未解决发现；Spec 为 0 项发现。扩展验证的 725 通过、1 跳过、1 既有旧库接管失败，以及首次驱动误触发假密钥模型请求路径的纠正，见 [spec 的验证记录](../spec.md)。
