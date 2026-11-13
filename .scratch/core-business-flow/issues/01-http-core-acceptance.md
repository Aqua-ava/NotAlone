# 01：公开 HTTP 核心闭环验收

Triage: ready-for-agent
State: resolved
Type: task
Blocked by: None

**What to build:** 用同一份合成资料通过真实核心模块形成候选及来源依据，再通过删除证明来源不再可用。

- [x] 公开 HTTP 完成预览、显式确认联系人、导入和显式启动真实 Worker，五步完成。
- [x] 真实 PostgreSQL 检索和候选存储参与生成；仅模型为 scripted fake。
- [x] 候选依据包含本次来源的规范消息或派生记忆，同键重放不再次调用模型、不产生新候选。
- [x] 两个联系人和另一个用户隔离，模型工具没有发送能力。
- [x] 来源删除完成后消息、派生记忆不可检索，依据不可读，旧候选不能继续，另一联系人资料保留。
- [x] 提供可复现的隔离测试命令，如实记录通过、失败及证明边界。

## Comments

用户已确认该接缝及范围。正常路径若直接通过，不人为制造失败；遇到真实断点先记录失败，再在本范围内最小修复。审查基线 fba6fa5。

## Answer

新增 `tests/integration/server/test_core_business_flow.py`：每次通过本机管理库自建随机 `notalone_core_flow_<uuid>_test` 库，使用正式迁移命令应用全量迁移并在退出时清理。数据库只用于迁移及合成用户/空 Skill 库夹具；资料导入、Worker 启动、五步 SSE 进度、消息/记忆/依据读取、候选生成、重放和来源删除全部通过真实 BackendServer HTTP 观察。桌面绑定为明确确认的合成夹具，不代表微信现场集成。

真实 `PostgresMemoryExtractionRunner`、提取/来源核验/裁决 LangChain adapter、PostgreSQL 记忆/水位/目录/检索/台账/候选存储和 LangChain 回复 Tool 循环均参与，只有模型返回脚本化结果。三份资料分别属于同一用户的 A/B 联系人及另一用户；同一检索关键字不会串范围。依据包含本次来源消息与带 `auto`、消息证据链的派生记忆；新 HTTP 服务实例同键重放返回完全相同候选且模型调用数不变。模型仅获得受控读取、联系人历史检索和结构化输出工具。

发现并修复真实断点：历史 Tool 将初始上下文已包含的消息重复加入附加依据，生成器严格去重校验因而拒绝合法请求。`src/notalone/reply/tools.py` 改为按已知证据标识判断新增；完整 Tool 命中及轨迹仍保留，生成器校验不变。

实际 RED：首个合法 `/api/reply/generate` 返回 `500 {"error":"reply_generation_failed"}`，验收报告 `FAILED (failures=1)`；诊断公开生成器调用得到 `ReplyInvariantError: 运行时附加证据超出本次范围。`。修复后整个闭环 GREEN。早期夹具缺少 `time`、时间戳不一致及 fake 默认循环索引导致的失败均为测试夹具问题，不计作产品 RED；另一用户改用三字合成茶名以满足既有词法召回，不改记忆算法。

来源删除在 HTTP 目录中达到 `deleted + task_status=succeeded` 后，消息和记忆列表为空；实际 PostgreSQL Tool 搜索返回 `empty`，新背景润色只保留本次草稿依据。旧依据 404，旧候选继续被拒绝且不调用模型；B 和另一用户的来源、消息与记忆均保留。

实际验证（2026-10-04，Conda `NotAlone`；所有命令禁用业务 `.env`）：

```bash
conda activate NotAlone
NOTALONE_DISABLE_DOTENV=1 python -m unittest \
  tests.integration.server.test_core_business_flow -v
# 1 test，OK（最终 2.347 秒）；自建/自清理测试库，不会因默认共享库缺失而跳过。

NOTALONE_DISABLE_DOTENV=1 python -m unittest \
  tests.unit.reply.test_history_tools \
  tests.unit.reply.test_langchain_vertical_slice \
  tests.unit.reply.test_generator -v
# 36 tests，OK。

NOTALONE_DISABLE_DOTENV=1 \
NOTALONE_TEST_DATABASE_URL=postgresql:///notalone_core_flow_20261004_8c94b56c_test \
python -m unittest \
  tests.integration.server.test_first_import_api \
  tests.integration.tasks.test_worker \
  tests.integration.reply.test_postgres_reply_flow \
  tests.integration.persistence.test_postgres_retrieval \
  tests.integration.persistence.test_source_deletion \
  tests.integration.persistence.test_source_reply_deletion -v
# 56 tests，OK；该一次性库由本任务创建并正式迁移，完成后已清理。

python -m compileall -q tests/integration/server/test_core_business_flow.py src/notalone/reply/tools.py
git diff --check
# 均通过。
```

合计相关验证 93 个测试通过。无真实聊天、业务库、外部模型调用、App 改动、schema 变更或外部发送。证明核心数据契约与模块接线，不证明真实模型候选/记忆质量或微信渠道集成。HTTP SSE 客户端关闭后，现有服务器会因尝试复用已断开的连接打印 `ConnectionResetError`；不影响五步事件、业务结果或通过计数，本任务未扩展修改服务器。跨范围目标及删除后候选继续沿用现有失败映射，本次只验证拒绝与零模型调用，不扩展错误分类。

实现已完成，主 Agent 负责按固定基线进行 Standards/Spec 审查及精确路径本地提交；未 push 或创建 PR。

主 Agent 已按固定基线 fba6fa5 完成并行双轴审查：Standards 0 项，Spec 0 项；仅审查本任务路径，另一会话的记忆诊断改动未纳入。
