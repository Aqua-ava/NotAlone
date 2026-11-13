# 02 — 本机 Hindsight 最小闭环

> Triage: ready-for-agent
> State: resolved
> Blocked by: None
> 规格：[Hindsight 本机记忆召回对照实验](../spec.md)

## 交付行为

在隔离本机环境启动实际 Hindsight，以少量合成已采纳关系记忆演示 retain → recall → 本地权威复验 → 真实回复上下文 → 当前性校验。此任务使用独立 smoke 夹具，可与 01 并行。

## 验收

- [x] 锁定部署版本、镜像或源码、embedding/rerank 模型与配置；文本和推理请求仅在本机流转，记录启动、停止和资源位置。
- [x] 使用新空 bank、chunks/world，关闭自动归纳与 LLM；不执行 reflect、mental models 或手动归纳，不连接业务配置。
- [x] 每条 local memory 的 document、范围、层和 revision 映射明确；多 chunk 去重后本地按 ID 回读，所有最终证据来自权威记录。
- [x] 实验适配器注入已有 RetrievalPort/Context；复验、消息、本人请求委托本地，生产默认装配与常量不变。
- [x] 明确 smoke 的评分字段、方向、模型和临时 tau_B；低分拒绝、低词面正例选入、confidence/auto/manual 保持原值。临时阈值不冒充正式校准或收益。
- [x] 实际核验 scores 与真实重排完成情况，能识别部分超时；无法核对时记录失败或能力缺口，不伪造分数。
- [x] 在已确认接缝完成 red → green、相关测试和类型检查，并保存实际服务 smoke 结果。

## 完成记录

仅代码或替身通过不能将真实服务前提标成完成。记录实际运行、数据流和剩余限制后再改 State。

## Answer

2026-10-04：已运行真实本机闭环。固定 Hindsight 源码 `f7dd3f4fd7420f7beec60c32c965e5e5cf7be066`、版本 0.10.2；独立 venv 与 pg0 PostgreSQL 18.1，本机 CPU embedding/rerank 的模型与快照 SHA 记录于 [runtime-manifest.json](../../../experiments/hindsight/runtime-manifest.json)。公开依赖安装仅发生在外置 venv，未改产品依赖、业务配置或默认装配。

新 bank 先通过 API 确认 memory/mental model 均为空及 resolved chunks/关闭自动归纳，然后写入三条新合成记忆，显式 world recall。单次 smoke 的词法 A 为空，B 选入「对方乳糖不耐受」，真实 Context.build 和 validate_current 通过；完整耗时 54.6 ms。HTTP `scores.reranker`、模型 CPU 初始化和同次重排完成数量已核对。临时 tau_B=0.003 只用于接入验证，不构成独立校准、Recall 收益或 P95 结论。[运行说明](../../../experiments/hindsight/runtime.md)及[实际 smoke 产物](../../../experiments/hindsight/smoke-result.json)包含本轮数据流和映射。

接缝 red 先因模块缺失失败；旧 chunk 高分不能提升当前 revision 的排序也先失败再通过。最终 10 个实验 unittest、28 个现有 Context unittest、4 个新增模块的 mypy 与 git diff --check 通过。所有 Python 命令先激活 Conda NotAlone，显式 PYTHONPATH=src 指向本任务工作树。

部分超时用本机 HTTP 替身按锁定源码的警告和 placeholder 分值验证确定性拒绝；真实超时/删除/重启故障验证属于 03。Context 的正常降级仍可能返回空结果，实验适配器同时保留 failure 诊断，评测必须观察该失败。日志证明只支持串行独占调用；缺诊断或并发日志不能验收。当前服务保留供 03/04 使用，不代表正式环境部署。

## Comments
