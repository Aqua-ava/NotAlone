# 来源核验准备阶段失败合同修复

- 依据：Standards 独立探针在 `d4e7690bd9f57a2fae66b04d348219476c0cb497` 返回旧失败结果，在 `bcc6701ce67249d18b51625c07f4cad4e401ad04` 抛出 `complete_claim_policy_invalid`。本轮只读取该 overflow 探针，未接触 Spec 轴。
- 原因：`prepareSourceVerification` 位于 verification 的 try/catch 之外；61 条可解析 direct 候选超过核验合同上限时，协议错误绕过原 Flow 失败分类。
- 修复：只将准备请求及 verification_input 记录放回既有 verification try/catch；复用原 invalid_output、unavailable 和取消处理，没有新增重试、拆批、截断或模型调用。
- 61 条：默认、NULL、v1 legacy、v2 均返回 `failure_kind=invalid_output`、`extraction_completed=true`、空 accepted/trace IDs/verification，E1/V0；原结构拒绝计数仍保留。
- 取消：准备阶段协议错误遇已取消信号时优先抛 AbortError；verification_input 的追踪写入故障仍原样传播。
- 正向边界：60 条在默认与 v2 都保持 E1/V1，60 条有据候选全部保留。
- RED：新增 5 组中 2 通过、3 失败；GREEN 单例 5/5，小相关纯 Flow 回归 22/22，TSC 与精确 diff 空白检查通过。日志保留原失败和修复后结果。
- 数据与执行：全部为合成文本；真实模型调用 0、DB 操作 0、App/微信操作 0，没有读取凭据或真实资料。
- 写区：仅 extraction-flow.ts、新 extraction-flow-failure-contract.test.mjs 和本报告目录；Batch/host-reply 的受控 retry 透传由正式 seam 负责。
- 历史 complete-claim 与 output-capacity-update 的 manifest/摘要未重写；本修复作为独立增量交由根集成，本会话未操作 index/commit/push。
- Flow 源码已冻结。根在并行写区均冻结后统一重算 sourceStamp 并做最终集成验证；本轮未放宽版本、来源或 unknown 守卫。
