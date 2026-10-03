# 02 — 本机 Hindsight 最小闭环

> Triage: ready-for-agent
> State: open
> Blocked by: None
> 规格：[Hindsight 本机记忆召回对照实验](../spec.md)

## 交付行为

在隔离本机环境启动实际 Hindsight，以少量合成已采纳关系记忆演示 retain → recall → 本地权威复验 → 真实回复上下文 → 当前性校验。此任务使用独立 smoke 夹具，可与 01 并行。

## 验收

- [ ] 锁定部署版本、镜像或源码、embedding/rerank 模型与配置；文本和推理请求仅在本机流转，记录启动、停止和资源位置。
- [ ] 使用新空 bank、chunks/world，关闭自动归纳与 LLM；不执行 reflect、mental models 或手动归纳，不连接业务配置。
- [ ] 每条 local memory 的 document、范围、层和 revision 映射明确；多 chunk 去重后本地按 ID 回读，所有最终证据来自权威记录。
- [ ] 实验适配器注入已有 RetrievalPort/Context；复验、消息、本人请求委托本地，生产默认装配与常量不变。
- [ ] 明确 smoke 的评分字段、方向、模型和临时 tau_B；低分拒绝、低词面正例选入、confidence/auto/manual 保持原值。临时阈值不冒充正式校准或收益。
- [ ] 实际核验 scores 与真实重排完成情况，能识别部分超时；无法核对时记录失败或能力缺口，不伪造分数。
- [ ] 在已确认接缝完成 red → green、相关测试和类型检查，并保存实际服务 smoke 结果。

## 完成记录

仅代码或替身通过不能将真实服务前提标成完成。记录实际运行、数据流和剩余限制后再改 State。

## Comments
