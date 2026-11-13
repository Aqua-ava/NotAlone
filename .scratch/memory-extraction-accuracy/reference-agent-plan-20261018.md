# 指代消解的 Agent 快速验收

2026-10-18。用户明确授权三个执行会话并行，由 Agent 完成验收，不等待人工；本次 `reviewer_kind=agent`。此变更只替换验收执行者，不降低至少15窗口、假事实0、错人0、一般错误≤1及歧义不得auto的门槛，不冒充旧人工认证。任务07依赖的01评测骨架已存在，不依赖另一新会话全部结束。

## 工程修复与验证接缝

复用窗口→结构候选→来源校验→语用／三门去向接缝。已标 `unresolved` 的目标消息被省略句或传递依赖引用时，E2原编译器没有传递未定信息；后继可以丢失alternatives而进入理想auto。共享编译器修复由核心事实会话唯一维护，新增专用依赖未决说明，只降不升，不推定后句人物，不改变v3/v4冻结合同或正向proof。

`test_reference_dependency_safety`先复现11个失败断言，再以实际修复转绿。4个测试方法覆盖16个给定标签控制窗口及跨消息／同消息传递、无关事实负控。这些是标签合同验证，其中未标歧义分支仅作程序对照，不是语义已消歧证明，也不计真实模型质量15窗。

## 独立新场

- 原 `cases/reference.py` 的16个窗口、输入、顺序与目标均保留；legacy对象、旧matcher、旧Gold和旧批次不修改。当前质量以[source-fidelity-v2的独立Agent审阅](reference-agent-gold-20261018.md)为准；18个必需命题及A15一个可选命题，A12/A14仍是窗口分母。
- 只用既有官方DeepSeek `deepseek-flash`、显式 `GroundedV2ExtractionRuntime`（E2）及 `LangChainSourceVerificationRuntime`（legacy四槽V）；thinking disabled／reasoning_effort none、温度0、零重试。此配置与固定思考max的旧v4场不同，不合并成绩或冒称同模型模式对照。
- 新独立预算最多32次HTTP；调用I/O120秒、每调用墙钟180秒、每窗Agent审核600秒。仅持久领取后读取现有授权官方凭据一次；旧余额不借用，未知响应不重发。
- 复用既有 `EvaluationBudget`、`EvaluationTransport`、`EvaluationRecordStore` 与 `evaluate_case` 的一次性装配，不新增生产执行入口。冻结源码、原输入、E/V提示与schema、Agent Gold及装配字节。逐请求前检查源码；保存脱敏HTTP原件和结构候选，禁止保存推理正文或凭据。
- 逐窗保存完整结果后进行独立Agent语义审阅，显式绑定case、结果摘要及reviewer_kind。此次为可见E/V的来源语义复审，不冒称旧RAW盲审协议。一般错误保留并继续；假事／错人／bad_auto、语义未知、技术／记录错误立即关闭。未运行窗口保留分母。
- `evaluate_case`旧matcher只辅助，不决定新Gold成绩；所有必需命题、主体、时间、风险、歧义和最终去向按来源独审。V=supported不是语义通过证明。生产空放行表保持，评测auto是理想三门潜在去向，不写任何业务资料。

本场仅合成文字、无业务库／真实联系人／App／微信／OCR／外部发送。运行时的bounded15正式来源验收由集成会话独立运行，不用其15个有限模板替代本票广泛指代主集。
