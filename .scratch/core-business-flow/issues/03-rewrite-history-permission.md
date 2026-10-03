# 03：普通润色的历史查询权限

Triage: ready-for-agent
State: resolved
Type: task
Blocked by: 01

**What to build:** 用户未要求联系人背景的润色请求无法读取历史资料，明确要求背景时仍保留已确认范围内的检索能力。

- [x] 公开 HTTP 普通润色中，scripted 模型主动尝试历史工具，历史消息或记忆不进入模型输入和依据快照。
- [x] 仅有上下文组装过滤不算完成；运行时工具暴露和输出引用校验必须遵守相同请求权限。
- [x] 明确授权背景的润色仍可读取并引用当前联系人历史，跨联系人资料不可用。
- [x] 不修改提取、核验或采纳语义，不调用外部模型，不增加发送能力。
- [x] 行为失败先复现，逐片修复并跑相关回归，双轴审查并独立本地提交。

## Comments

与 02 业务上独立，在文件责任不重合时并行实现和验证，按 02、03 顺序本地提交。审查基线 fba6fa5，仅审查本任务变更。

## Answer

实现、专项验证与双轴审查完成，在 02 的独立提交 56d2778 之后，与本记录一起本地提交。

### 失败复现与最小修复

- 在公开 `BackendServer` HTTP 入口，以真实 PostgreSQL 检索和真实 LangChain Tool 循环复现：普通润色主动调用 `conversation_search` 后返回 200，依据为 `user_draft + 2 message`；调用 `conversation_query` 时为 `user_draft + 3 message`。Scripted 模型根据真实 Tool 返回引用了历史消息，原运行时因此确实读取并保存了未授权的历史依据。
- 统一本次请求权限：`ReplyToMessage` 允许历史；`RewriteDraft` 仅在 `include_relationship_context=true` 时允许。`message`、`confirmed_memory`、`owner_memory` 均属于历史背景；当前 `user_draft` 与用户显式选择的 `continued_candidate` 保留。
- Context 组装、Context 依据复验、Runtime 输入和工具注册、Generator 运行前后校验使用同一权限规则。普通润色只注册受控 Skill `read_file` 与结构化输出工具；主动调用未注册的历史工具不能读取资料，模型可继续基于草稿返回候选。
- 授权背景润色仍实际执行两种历史工具，并引用当前联系人消息、关系记忆和本人记忆；另一联系人和另一用户的匹配资料不进入模型各轮输入或 HTTP 依据。普通润色显式继续候选仍可引用所选候选。模型猜测不可用历史消息 UUID 的输出被既有引用校验拒绝。
- 两条既有历史预算测试原先使用普通润色夹具；在新权限规则下不再产生历史调用轨迹。仅将这两条夹具改为明确要求背景，保留其原预算断言，没有新增低层测试接缝。

### 实际验证

命令均在 `source /Users/local-user/miniconda3/etc/profile.d/conda.sh && conda activate NotAlone` 后执行，设置 `NOTALONE_DISABLE_DOTENV=1`：

```sh
python -m unittest tests.integration.server.test_rewrite_history_permissions -v
python -m unittest tests.unit.reply.test_history_tools tests.unit.reply.test_context_retrieval tests.unit.reply.test_generator tests.unit.reply.test_langchain_vertical_slice tests.unit.reply.test_unified_inputs tests.unit.reply.test_runtime_limits tests.unit.reply.test_skill_runtime_resources tests.unit.reply.test_ledger_wiring -q
python -m unittest tests.integration.reply.test_postgres_reply_flow tests.integration.server.test_core_business_flow tests.integration.server.test_rewrite_history_permissions -v
python -m compileall -q src/notalone/reply/context.py src/notalone/reply/generator.py src/notalone/reply/adapters/langchain_runtime.py tests/integration/server/test_rewrite_history_permissions.py tests/unit/reply/test_runtime_limits.py
git diff --check -- src/notalone/reply/context.py src/notalone/reply/generator.py src/notalone/reply/adapters/langchain_runtime.py tests/integration/server/test_rewrite_history_permissions.py tests/unit/reply/test_runtime_limits.py
```

- 第一条最初 RED：1 测试的 search/query 两个场景均观察到历史依据进入快照；修复后同一测试 GREEN，随后完整 HTTP 权限模块 4 测试全部通过。
- 第二条首次 96 测试中 1 失败，为上述预算夹具授权冲突；调整夹具后 96 全部通过。
- 第三条在 Python 临时驱动中自建 `notalone_rewrite_<uuid>_test`，正式迁移后传入 `NOTALONE_TEST_DATABASE_URL`，结束时 `DROP DATABASE ... WITH (FORCE)`；HTTP fixture 各自另建并清理专用测试库。6 条 PostgreSQL 回复纵切、1 条核心 HTTP 闭环与 4 条 HTTP 权限测试，共 11 条全部通过。首次临时驱动前缀过长导致 PostgreSQL 截断库名、丢失 `_test` 后缀，被既有测试保护拒绝；缩短前缀后重跑通过。
- Python 编译检查和任务路径的 `git diff --check` 通过。没有把编译检查宣称为静态类型检查。

### 数据影响与证明边界

上述专项验证只使用合成资料和自建测试库，没有读取业务 `.env`、真实聊天或业务库，没有外部模型调用。没有 schema、提取、来源语义核验或采纳算法改动，没有发送能力。普通润色仍复验记忆及 Skill 的 revision 元数据；本任务不扩大到无关版本冲突处理。验证证明请求权限、实际工具读取和持久化依据一致，不证明真实模型表达质量或微信渠道集成可用。

主 Agent 按固定基线 fba6fa5 并行执行 Standards/Spec 审查，两轴均 0 项发现；仅审查本任务路径，共享 HTTP 夹具提取归属 02。

主 Agent 扩展回归为 727 项：725 项通过、真实模型冒烟显式跳过 1 项、既有旧库接管维护进程检查失败 1 项。首次驱动因设置测试遗留假密钥误触发模型请求路径并失败，随后分子进程隔离、显式跳过及阻止外部网络；完整记录见 [spec](../spec.md)。本任务路径的 Python 编译与差异检查再次通过，README 已记录普通润色与明确授权背景的权限。
