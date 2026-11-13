# Python 运行与退役清单

基准：`3c168296`；盘点日期：2026-10-23。仅01研究交付，不改变产品装配、不执行02。表内票号均指 [迁移规划](../planning.md) 的具名任务；“承接”是职责映射，不表示该票已执行。源码存在不等于端到端可用。

## DSH 一手查证与交互边界

候选提交 `687f282e8625c6b8d11ff58211a90524be2e4317`，根 package 版本 `0.2.1-rc.2`。通过官方 Git 远端 `git ls-remote ... refs/heads/master` 核对完整提交，读取该提交官方归档源码；02才固化可运行版本及依赖闭包。GitHub API因限流403不可用，未以API失败冒充源码验证失败。

- [官方运行架构](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/docs/architecture.md#application-launch)：支持的 Node 应用由 profile 启动；NotAlone 普通 TS 业务与 DSH 同后台，Electron独立。03替换进程监督，不能另启长期Python业务层。
- [Agent合同](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/agent/README.md)及[源码183行](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/agent/src/runtime-types.ts#L183)：取消、闲置等待与作用域卸载是公开能力；取消是否阻止业务迟到落库仍须03/05/22验证。
- [模型文档及示例](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/llm/llm/README.md#use-this-package)与[prepareCall实现956行](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/llm/llm/src/index.ts#L956)：单次语义请求和Agent循环都走官方模型服务；模型默认值、路由、终止和重试影响费用比较。未验证供应商参数等价或结构化输出。
- [官方minimal配置](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/bundle/sdk-minimal/cordis.patch.yml#L20)含session-log-deepseek、token-meter、compaction等，不能直接继承。02须证明临时会话清理、无额外日志上报及无不必要工具；PG继续保存权威业务资料。

本次两份文档不调用DSH直接接口；盘点的后续模型适配、后台退出与评测会涉及上述边界。仅阅读证据，未安装或启动DSH。

## 产品、宿主、供应商与模型

| 资产／源码证据 | 当前职责／限制 | 承接及最终处置 |
| --- | --- | --- |
| `backend/src/notalone/server/command.py:56`，`server/*`、`application/*` | HTTP、事件及业务装配；产品仍Python | 03宿主、04—23按领域移交；24单写入切换；26删除旧装配 |
| `backend/src/notalone/tasks/command.py:226`，`tasks/*` | Worker领取、租约、停止、恢复；不能因Agent会话恢复而重放 | 10提取、13/14整理、15学习、20补齐、22统一任务；26退役旧Worker |
| `backend/src/notalone/database_migrations.py:151`、`database_adoption.py:331`、`managed_postgres.py:18`、`startup_database.py:56` | 本机PG、既有库接纳、启动兼容检查；不是允许新建替代空库 | 03/24保留原库、身份、历史SQL和失败停写；26移除Python启动入口 |
| `backend/src/notalone/startup_diagnostics.py:135`、`parent_lifetime.py:1` | 诊断和父进程生命周期 | 03/23；26删除Python依赖 |
| `desktop/src/main/backend/process.ts:20`、`host.ts:1`、`quit.ts:1`、`startup/diagnostics.ts:184`、`startup/managed-runtime.ts:1` | Electron生成Python子进程、启动诊断、监督退出 | 03替换为官方profile后台；23错误映射；24/25生命周期验收 |
| `desktop/scripts/dev.mjs:1`、`development-server.mjs:1`、`development-lease.mjs:1`、`development-status.mjs:1` | 热更新、实例复用与退出 | 03/26调整后端启动及Python变更监听；保留npm run dev硬边界 |
| `native/macos/Package.swift:1`、`desktop/scripts/probe-runtime.mjs:1`、`prepare-probe.mjs:1`、`prepare-probe-runtime.mjs:1` | Swift前台探针与权限宿主，不是Python业务 | 21保留原生实现；03/26仅消除业务Python接线；不扩大OCR范围 |
| `desktop/scripts/prepare-runtime.mjs:18`、`verify-runtime.mjs:22`、`prepare-replacement-kit.mjs:1`、`install-runtime-copy.mjs:1`、`managed-runtime.mjs:1` | Python/PG运行时制备、隔离导入与分发校验 | 03/26迁移清单和验证；保留PG；发布门禁不因本任务开放 |
| `desktop/scripts/build-wechat-components.mjs:205`、`wechat-components.mjs:12`、`desktop/wechat-sources.lock.json:1` | 微信CLI/LLDB内嵌CPython，与业务后端不同 | 18/26具名保留第三方调试运行依赖及许可证，不以删除Python业务为由盲删；最终报告仍须披露内嵌Python |
| `backend/src/notalone/reply/adapters/deepseek_provider.py:13`、`server/reply_wiring.py:142`、`memory_extraction/evaluation_provider_contract.py:167` | 默认DeepSeek `deepseek-flash`，兼容ECNU评测路由；具体实际配置本次未读取 | 02模型合同、05前后台仲裁、10/13/14/15语义调用、23配置用量；不用DSH示例model id静默替换 |
| `scripts/compare_tencent_extraction.py:26` | 腾讯方案提示词对照通过ECNU端点，不代表生产腾讯供应商 | 25仅历史隔离复现；26移出产品依赖，禁止当成供应商迁移需求 |
| `backend/src/notalone/memory_extraction/recall.py:22`、`scripts/prepare_memory_embedding.py:9` | fastembed本机模型BAAI/bge-small-zh-v1.5；Qdrant快照46fbe35fd4374a00fee7de77dfddaeb6dd6a2c59；512维；运行时local_files_only、threads=2，无隐式下载 | 03提供TS显式准备，05首条检索前验证embedding/分词/排序兼容，11裁决召回；26退役Python准备入口。权重保留，不换云embedding |
| `backend/src/notalone/retrieval/lexical.py:1`、`ranking.py:1` | 中文词法与确定性排序；不等同embedding | 05/11迁移并对照；25独立测检索 |
| `backend/src/notalone/reply/fidelity_evaluation.py:228`、`backend/README.md:205` | 生成后语义复核已退出产品；离线保真仍保留 | 05不复活复核调用；25/26隔离历史诊断并迁移必要评分能力 |

## 全部注册CLI

来源 `backend/pyproject.toml:25`。注册不代表桌面实际调用；业务能力必须保留，兼容CLI是否保留具体命令由承接票明确，不能静默丢能力。

| 命令 | 当前目标 | 承接／处置 |
| --- | --- | --- |
| `notalone-memory-evaluate` | `notalone.memory_extraction.evaluation:main` | 25/26：离线评测隔离迁移 |
| `notalone-ingest-preview` | `notalone.ingest.preview:main` | 16/26：保留预览，退役Python入口 |
| `notalone-ingest` | `notalone.ingest.import_command:main` | 16/26：保留导入，退役Python入口 |
| `notalone-extract-memory` | `notalone.memory_extraction.command:extract_main` | 10/26：保留提取 |
| `notalone-memory-add` | `notalone.memory_extraction.command:memory_add_main` | 09/26：保留手录 |
| `notalone-memory-list` | `notalone.memory_extraction.command:memory_list_main` | 09/26：保留查看 |
| `notalone-memory-delete` | `notalone.memory_extraction.command:memory_delete_main` | 09/17/26：保留删除 |
| `notalone-memory-trace` | `notalone.memory_trace.command:memory_trace_main` | 12/26：保留来源链 |
| `notalone-source-trace` | `notalone.memory_trace.command:source_trace_main` | 12/26：保留来源链 |
| `notalone-task-cleanup` | `notalone.tasks.command:cleanup_main` | 22/26：保留清理 |
| `notalone-task-worker` | `notalone.tasks.command:worker_main` | 22/26：迁移Worker |
| `notalone-front-sync` | `notalone.front_sync.command:front_sync_main` | 21/26：保留前台定位边界 |
| `notalone-server` | `notalone.server.command:main` | 03/26：替换业务后台 |
| `notalone-retrieval-evaluate` | `notalone.retrieval.evaluation:main` | 05/25/26：合成检索评分迁移 |

## 锁文件和依赖

| 文件 | 承接／处置 |
| --- | --- |
| `backend/pyproject.toml:12` | 26退役产品依赖：fastembed 0.9.0、deepagents 0.7.6、httpx 0.28.1、langchain 1.3.15、langchain-core 1.5.5、langchain-deepseek 1.1.0、langgraph 1.2.11；PyYAML/psycopg为范围约束，实际包闭包以运行锁文件为准 |
| `desktop/scripts/runtime/requirements.lock:1`、`python-wheels.lock.json:1` | 26消除旧业务运行闭包，历史复现环境另隔离；不能仅删除pyproject后宣称退役 |
| `desktop/scripts/runtime/build-wheels.lock.json:1`、`psycopg-build-wheels.lock.json:1` | 26清理Python/psycopg构建专用链 |
| `desktop/scripts/runtime/component-sources.lock.json:1` | 03/26拆出业务Python，保留PG等仍需组件 |
| `desktop/scripts/runtime/attribution-sources.lock.json:1`、`desktop/scripts/distribution-notices.lock.json:1` | 26根据最终分发依赖更新许可证，不整份盲删 |
| `desktop/package-lock.json:1`、`desktop/wechat-sources.lock.json:1` | 03/18/26保留并按职责更新；DSH由02另固定已验证闭包，不在01安装 |

## 可执行Python与旧实验逐项账本

下表由基准Git树扫描 `__main__`、`def main`、`def *_main` 生成；上方CLI补齐无独立main的注册目标。实验/benchmark入口不等于生产可用。所有旧实验以26为清退责任票，25仅承接必要对照；保留历史证据但不得保留隐蔽产品依赖。

| 文件:行 | 承接／处置 |
| --- | --- |
| `backend/benchmarks/database_queries.py:318` | 25/26：隔离历史实验；必要合成runner迁为TS后退役Python |
| `backend/benchmarks/source_processing_batch.py:171` | 25/26：隔离历史实验；必要合成runner迁为TS后退役Python |
| `backend/src/notalone/database_adoption.py:331` | 03/23/24/26：迁移宿主、诊断、数据管理；预算模块由23承接 |
| `backend/src/notalone/database_migrations.py:151` | 03/23/24/26：迁移宿主、诊断、数据管理；预算模块由23承接 |
| `backend/src/notalone/experiments/context_directions_probe.py:45` | 25/26：隔离历史实验；必要合成runner迁为TS后退役Python |
| `backend/src/notalone/experiments/conversation_paths_prototype.py:258` | 25/26：隔离历史实验；必要合成runner迁为TS后退役Python |
| `backend/src/notalone/experiments/hindsight_baseline.py:436` | 25/26：隔离历史实验；必要合成runner迁为TS后退役Python |
| `backend/src/notalone/experiments/hindsight_comparison.py:535` | 25/26：隔离历史实验；必要合成runner迁为TS后退役Python |
| `backend/src/notalone/experiments/hindsight_lifecycle.py:661` | 25/26：隔离历史实验；必要合成runner迁为TS后退役Python |
| `backend/src/notalone/experiments/hindsight_runtime.py:219` | 25/26：隔离历史实验；必要合成runner迁为TS后退役Python |
| `backend/src/notalone/experiments/hindsight_smoke.py:152` | 25/26：隔离历史实验；必要合成runner迁为TS后退役Python |
| `backend/src/notalone/experiments/organization_quality.py:92` | 25/26：隔离历史实验；必要合成runner迁为TS后退役Python |
| `backend/src/notalone/experiments/organization_quality_construct.py:596` | 25/26：隔离历史实验；必要合成runner迁为TS后退役Python |
| `backend/src/notalone/experiments/organization_quality_suite.py:12` | 25/26：隔离历史实验；必要合成runner迁为TS后退役Python |
| `backend/src/notalone/experiments/problem_budget.py:25` | 25/26：隔离历史实验；必要合成runner迁为TS后退役Python |
| `backend/src/notalone/experiments/reply_comparison.py:369` | 25/26：隔离历史实验；必要合成runner迁为TS后退役Python |
| `backend/src/notalone/front_sync/command.py:97` | 21/26：迁移前台定位后退役旧入口 |
| `backend/src/notalone/ingest/import_command.py:156` | 16/26：迁移导入后退役旧入口 |
| `backend/src/notalone/ingest/preview.py:87` | 16/26：迁移导入后退役旧入口 |
| `backend/src/notalone/managed_postgres.py:18` | 03/23/24/26：迁移宿主、诊断、数据管理；预算模块由23承接 |
| `backend/src/notalone/memory_extraction/bounded_proof.py:397` | 03/23/24/26：迁移宿主、诊断、数据管理；预算模块由23承接 |
| `backend/src/notalone/memory_extraction/command.py:1098` | 09/10/17/26：迁移记忆CRUD及提取后退役 |
| `backend/src/notalone/memory_extraction/evaluation.py:497` | 25/26：隔离历史实验；必要合成runner迁为TS后退役Python |
| `backend/src/notalone/memory_extraction/replica_experiment.py:156` | 25/26：隔离历史实验；必要合成runner迁为TS后退役Python |
| `backend/src/notalone/memory_trace/command.py:22` | 12/26：迁移来源追溯后退役旧入口 |
| `backend/src/notalone/problem_budget.py:149` | 03/23/24/26：迁移宿主、诊断、数据管理；预算模块由23承接 |
| `backend/src/notalone/reply/fidelity_evaluation.py:228` | 25/26：隔离历史实验；必要合成runner迁为TS后退役Python |
| `backend/src/notalone/retrieval/evaluation.py:904` | 25/26：隔离历史实验；必要合成runner迁为TS后退役Python |
| `backend/src/notalone/server/command.py:56` | 03/23/24/26：迁移宿主、诊断、数据管理；预算模块由23承接 |
| `backend/src/notalone/startup_database.py:56` | 03/23/24/26：迁移宿主、诊断、数据管理；预算模块由23承接 |
| `backend/src/notalone/startup_diagnostics.py:135` | 03/23/24/26：迁移宿主、诊断、数据管理；预算模块由23承接 |
| `backend/src/notalone/tasks/command.py:226` | 22/26：迁移任务能力后退役旧入口 |
| `experiments/pgvector/evaluate.py:623` | 25/26：隔离历史实验；必要合成runner迁为TS后退役Python |
| `experiments/pgvector/runtime.py:300` | 25/26：隔离历史实验；必要合成runner迁为TS后退役Python |
| `scripts/benchmark_memory_recall.py:137` | 25/26：隔离历史实验；必要合成runner迁为TS后退役Python |
| `scripts/compare_tencent_extraction.py:279` | 25/26：隔离历史实验；必要合成runner迁为TS后退役Python |
| `scripts/prepare_memory_embedding.py:14` | 03/05/26：显式本地模型准备迁移 |
| `scripts/replay_grounded_extraction.py:86` | 25/26：隔离历史实验；必要合成runner迁为TS后退役Python |

## 评测辅助模块的处置

`backend/src/notalone/memory_extraction/evaluation_*.py`（包括deadline、provider_contract、records、review、offline、phased_audit等）不是全部拥有独立CLI，仍由25/26承接评分、受控回放及历史证据解析；`memory_extraction/cases/`、`semantic_evaluation_cases.py`、`retrieval/recall_cases.py`保留合成材料并移植断言。`application/organization_evaluation.py`由13/14/25承接整理质量，`reply/quality/`由05/25承接独立质量合同，不能恢复已退役产品复核。`backend/tests/`全部测试按对应领域迁移，26核验仅历史离线工具可以保留Python且与产品包隔离；不能只扫描带main的文件。

## 桌面测试中的Python资产

以下是基准树的全部桌面Python资产，统一由25迁移对应HTTP/宿主合成验证，26核验不再作为产品或测试启动的隐蔽依赖；需要保留历史模型响应解析的文件隔离为历史工具。文件名含public不自动证明任何外部文件是合成；未来运行前仍核对输入来源。此处只枚举源码文件，未执行或读取外部夹具。

- `desktop/tests/fixtures/ambiguity-public2.py:1` → 25/26。
- `desktop/tests/fixtures/assistant-budget-backend.py:1` → 25/26。
- `desktop/tests/fixtures/assistant-generation-ownership.py:1` → 25/26。
- `desktop/tests/fixtures/assistant-input-budget-page-backend.py:1` → 25/26。
- `desktop/tests/fixtures/assistant-lifecycle-backend.py:1` → 25/26。
- `desktop/tests/fixtures/backend-command.py:1` → 25/26。
- `desktop/tests/fixtures/contact-database.py:1` → 25/26。
- `desktop/tests/fixtures/contact-relationship-overview.py:1` → 25/26。
- `desktop/tests/fixtures/continuous-sync-support.py:1` → 25/26。
- `desktop/tests/fixtures/deepseek-v-off-forced-public.py:1` → 25/26。
- `desktop/tests/fixtures/evidence-snapshot-arrangement.py:1` → 25/26。
- `desktop/tests/fixtures/explicit_review_bridge.py:1` → 25/26。
- `desktop/tests/fixtures/expression-preference-backend.py:1` → 25/26。
- `desktop/tests/fixtures/expression-preferences-page.py:1` → 25/26。
- `desktop/tests/fixtures/fixture_cleanup.py:1` → 25/26。
- `desktop/tests/fixtures/fixture_cleanup_check.py:1` → 25/26。
- `desktop/tests/fixtures/foreground-probe-manual.py:1` → 25/26。
- `desktop/tests/fixtures/foreground-probe-paused.py:1` → 25/26。
- `desktop/tests/fixtures/foreground-probe-verified.py:1` → 25/26。
- `desktop/tests/fixtures/foreground_recovery_diagnostics.py:1` → 25/26。
- `desktop/tests/fixtures/full140-e2-v-off-public.py:1` → 25/26。
- `desktop/tests/fixtures/full140-mixed-v-off-public.py:1` → 25/26。
- `desktop/tests/fixtures/full140-v4-public.py:1` → 25/26。
- `desktop/tests/fixtures/grounded_public21.py:1` → 25/26。
- `desktop/tests/fixtures/historical-reply-basis-backend.py:1` → 25/26。
- `desktop/tests/fixtures/historical_reply_basis_fixture.py:1` → 25/26。
- `desktop/tests/fixtures/import-bootstrap-prepare-failure.py:1` → 25/26。
- `desktop/tests/fixtures/import_backend.py:1` → 25/26。
- `desktop/tests/fixtures/import_http_check.py:1` → 25/26。
- `desktop/tests/fixtures/import_http_runner.py:1` → 25/26。
- `desktop/tests/fixtures/import_priority_check.py:1` → 25/26。
- `desktop/tests/fixtures/layered-memory-page.py:1` → 25/26。
- `desktop/tests/fixtures/layered-reply-page.py:1` → 25/26。
- `desktop/tests/fixtures/main16-public.py:1` → 25/26。
- `desktop/tests/fixtures/manual-connection-change-backend.py:1` → 25/26。
- `desktop/tests/fixtures/manual-package-model.py:1` → 25/26。
- `desktop/tests/fixtures/memory-correction-database.py:1` → 25/26。
- `desktop/tests/fixtures/memory-database.py:1` → 25/26。
- `desktop/tests/fixtures/memory-processing-pages.py:1` → 25/26。
- `desktop/tests/fixtures/memory-skill-evolution-page.py:1` → 25/26。
- `desktop/tests/fixtures/memory_current_status_fixture.py:1` → 25/26。
- `desktop/tests/fixtures/memory_editing_backend.py:1` → 25/26。
- `desktop/tests/fixtures/memory_editing_http_check.py:1` → 25/26。
- `desktop/tests/fixtures/memory_event_updates_fixture.py:1` → 25/26。
- `desktop/tests/fixtures/message-events-backend.py:1` → 25/26。
- `desktop/tests/fixtures/module_guard.py:1` → 25/26。
- `desktop/tests/fixtures/observation_measurements.py:1` → 25/26。
- `desktop/tests/fixtures/overview-reply-retrieval.py:1` → 25/26。
- `desktop/tests/fixtures/owner-facts-overview.py:1` → 25/26。
- `desktop/tests/fixtures/page_database_guard.py:1` → 25/26。
- `desktop/tests/fixtures/page_database_guard_test.py:1` → 25/26。
- `desktop/tests/fixtures/page_resource_guard.py:1` → 25/26。
- `desktop/tests/fixtures/page_resource_guard_test.py:1` → 25/26。
- `desktop/tests/fixtures/real-sync-python.py:1` → 25/26。
- `desktop/tests/fixtures/reference21-v4-public.py:1` → 25/26。
- `desktop/tests/fixtures/remaining-public8.py:1` → 25/26。
- `desktop/tests/fixtures/reply-model-smoke-backend.py:1` → 25/26。
- `desktop/tests/fixtures/rewrite-backend.py:1` → 25/26。
- `desktop/tests/fixtures/setup-database.py:1` → 25/26。
- `desktop/tests/fixtures/setup-python.py:1` → 25/26。
- `desktop/tests/fixtures/skill-learning-page.py:1` → 25/26。
- `desktop/tests/fixtures/source-deletion-arrangement.py:1` → 25/26。
- `desktop/tests/fixtures/source-deletion-backend.py:1` → 25/26。
- `desktop/tests/fixtures/source-deletion-database.py:1` → 25/26。
- `desktop/tests/fixtures/startup-database.py:1` → 25/26。
- `desktop/tests/fixtures/sync_read_causes.py:1` → 25/26。
- `desktop/tests/fixtures/test_ambiguity_public2.py:1` → 25/26。
- `desktop/tests/fixtures/test_contact_database_safety.py:1` → 25/26。
- `desktop/tests/fixtures/test_deepseek_v_off_forced_public.py:1` → 25/26。
- `desktop/tests/fixtures/test_full140_e2_v_off_public.py:1` → 25/26。
- `desktop/tests/fixtures/test_full140_mixed_v_off_public.py:1` → 25/26。
- `desktop/tests/fixtures/test_full140_v4_public.py:1` → 25/26。
- `desktop/tests/fixtures/test_main16_public.py:1` → 25/26。
- `desktop/tests/fixtures/test_observation_measurements.py:1` → 25/26。
- `desktop/tests/fixtures/test_reference21_v4_public.py:1` → 25/26。
- `desktop/tests/fixtures/test_remaining_public8.py:1` → 25/26。
- `desktop/tests/fixtures/test_reply_model_smoke_backend.py:1` → 25/26。
- `desktop/tests/fixtures/trace-database.py:1` → 25/26。
- `desktop/tests/fixtures/tracing-pipeline.py:1` → 25/26。

## 既有缺口与责任

- `.scratch/local-app-first-use/issues/02-database-lifecycle.md:4`、`05-model-setup.md:4`仍open：03承接原PG/模型首用界面，05补本地检索模型准备；原票保持状态，不把迁移当首用已通过。
- `.scratch/local-app-first-use/issues/01-wechat-preparation-feasibility.md:4`、`03-wechat-component-preparation.md:4`、`04-first-connection-scope.md:4`仍open：18协调原微信准备及绑定职责，19/20承担增量和缺口恢复，25做实际桌面验收。
- `.scratch/local-app-first-use/issues/06-recovery-and-deletion-ui.md:4`、`07-integrated-development-acceptance.md:4`、`08-release-readiness.md:4`、`09-clean-machine-release-acceptance.md:4`未作为本次已成功基线；03/17/24/25分别承接恢复、删除、切换和开发验收；发布不在01授权内。
- 26验收应再次扫描Python启动、动态import、测试fixture、package scripts与锁文件，按上表逐项销账；第三方微信LLDB内嵌Python单列保留，不冒称系统零Python。

## 本次验证与限制

静态核对注册CLI、基准树可执行入口、桌面Python资产、锁文件、源码位置及官方固定提交；只导入合成case定义统计样本，未运行模型、数据库、App、构建或安装。未读取.env、缓存权重或私人资料。文件由主会话整合提交，本子会话不git add/commit。实际运行两条离线评测CLI退出0；retrieval.evaluation仅6例in-memory合同，不能与109例混同，其固定0延迟非性能实测；109例召回门槛模块8测试通过；坏输出保真夹具维持quality_verified=false。性能、实际供应商配置、Python完全退役与DSH集成均未验证。
