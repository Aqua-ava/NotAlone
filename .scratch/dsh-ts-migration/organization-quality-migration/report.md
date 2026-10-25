# 组织质量迁移交付

日期：2026-10-25。工程切片已冻结；根负责统一集成、本地提交、独立验收与真实质量协议。源码／测试精确清单和逐文件 SHA 见 `files.json`，本地导入依赖快照见 `dependencies.json`。

## 交付行为

| 原入口 | 迁移结果 |
| --- | --- |
| contact／owner `layered-memory/quality-input` | 管理端通过同一 `insertInputInTransaction` 保存实际来源、版本、主题上下文与纠错证据。原 body 为 `memory_versions`。 |
| `/api/layered-memory/quality-inputs/:id` | 读取、输入标注、输出逐项审核、删除；owner 隔离，审核绑定真实输入／输出摘要。 |
| `/api/layered-memory/quality-runs` | 原 `fixed_synthetic`／`_test` 限制、1–240 输入、1–750 次持久额度，保留一次性事实路径用途。 |
| run `execute` | 真实 L2/L3 文档工作区、独立核验、双层反例；195 秒 case 租约、30 秒阶段上限、190 秒执行上限。评测 checkpoint 不发布产品记忆。 |
| run 读取／标定／删除 | 原报告 schema 2、完整分母、人工／Agent 区分、失败和 unknown；来源、版本或范围改变依法失效。 |

`OrganizationQualityStore`、`OrganizationQualityService`、HTTP adapter 与运行器按持久化、业务、运输和模型执行分开。外部模块由原负责人接线，本聊天只新增 `organization-quality-*`。

## 接线 API

- `organization-quality-api.ts:10`：`createOrganizationQualityApi({ownerId,transaction,store?,contract?,runtime?})`，返回 `store/service/matches/handle`。
- `organization-quality-store.ts:42`：`insertInputInTransaction(client,scope,versions)`，管理端已持范围锁；来源、主题上下文及冻结输入由唯一 Store 产生。
- `organization-quality-store.ts:17`：单一 `qualityInputSourceRef({case_id,input_sha256})`，返回服务器侧冻结引用，不能由 HTTP body 覆盖。
- `organization-quality-runtime.ts:74`：`createOrganizationQualityRuntime({call,binding,profile,diagnosticProblemBudgetBound,sourceRef:qualityInputSourceRef})`。
- SDK 执行须证明 provider 安装时已绑定原累计问题 guard，并精确匹配冻结来源；缺失返回 `503 quality_evaluation_unavailable`，不认领或消耗 case。bound 不表示仍有额度，实际发送继续原子预留。
- 每物理请求沿现成 caller／provider／Unix 许可／PG 台账。质量原表独立累计，授权从 PG 配对 case/token/source_ref/hash；没有伪造后台任务、第二 provider 或新评测后端。

## 保留的质量合同

原正式 120 资格保持：八维各至少 15 个独立场景，人工输入支持、冻结记录、逐项人工输出审阅、完整模型阶段证据与人工标定。本次 1152 协议未改动、未运行。

原正常核验 DTO 为 `true`，正确拒绝反例为 `false`；实际 verdict 保留在独立 `*_isolation`。部分放行反例记录 `verifier_false_accept`。Agent 审阅不升级为人工；报告 `automatic_use_allowed` 保持 false。

官方流未暴露原始 response model／system_fingerprint，字段保留 null／unknown，无法授予正式资格。已知 token 用量从真实 normalized receipt 映射旧 DTO，并明确标记 `usage_measurement=normalized_llm_stream`。请求证据标为 normalized GenerateOptions，最终 wire hash／Unicode 字符数独立记录。

## 验证

- 依赖冻结后：本任务公开切片 **14/14**，类型检查通过；精确命令、原始日志名／SHA 见 `validation.json`。原日志保存在仓库外 0700 目录、0600 文件。
- 直接相关组 **55/55**：包含本任务、实际 quality caller、管理及 L2/L3 工作区；工具输出确认，未伪造未保存的关联组原始日志。
- 实际 SDK 公开六阶段：明确绑定合成 8 次问题账本，8 个本机假 provider 物理请求，持久重读和完成后不重放。
- 否定路径：owner／摘要／版本、未选来源隔离、来源删除、并发领取、取消收尾、过期 unknown、额度耗尽、部分反例放行、缺 guard／错 source_ref。最终实体字符数等号可发送、超一字符零 HTTP。
- 默认自动维护改变组织世代时，原触发器会清除冻结输入及 run；后台负责人在主产品合成验收中通过公开 disable 后冻结输入，保留原 404 证据，没有弱化失效规则。
- 新增源码／测试范围扫描 **13 文件、0 问题**；见 `scan.json`。全分支凭据策略审计会读取实际配置，由根统一执行。

## 数据影响与清理

复用 schema 079 原质量表、来源及用途删除触发器，没有 schema 变更。质量输入、输出、请求及审核属于含文字敏感资料，随实际参与依赖清除；无关未选来源不会误删独立报告。迟到结果不能重新插入已撤销目标。

所有运行仅连接随机合成 `_test` PG、临时合成 SQLite 和本机假 provider。夹具关闭自有 HTTP、官方 profile 子进程和许可，并删除测试库／临时账本；仅保留私有验证日志。实际外部模型调用、App／微信操作、真实业务库连接均为 0。

本聊天没有读取真实配置、改动用户文件、Git index／提交、push／PR 或打包。旧 Python 及兼容支路保留。真实模型质量、盲评、App／微信、统一候选集成和 Ticket 25 验收仍由根完成。

## 锁定 DSH 依据

版本 `0.2.1-rc.2`，官方提交 `687f282e8625c6b8d11ff58211a90524be2e4317`。普通业务模块由共享 profile 装配，质量运行调用现成模型端口；[官方启动边界](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/docs/architecture.md#L34)。模型使用官方 prepared call／终态流合同，取消后仍保存已发生请求的回执；[锁定 LLM 文档](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/llm/llm/README.md#L51)。未更改 DSH 核心或腾讯算法。
