# ADR-045：ECNU 回复输入预算采用明确标注的估算与余量

> 状态：已采纳；接入代码与合成公开链路已验证，真实 App／模型体验待单独记录。
> 决策日期：2026-10-12。用户明确同意估算策略，并要求验证后升级原库、体验真实 App。
> 局部修订：持续助手会话输入预算的计量放行策略；ADR-042 的不自动摘要、不静默截断与显式新开继续有效。

现有生成入口只接受精确计量或已核实的保守上界，生产 ECNU 装配未提供这些能力，导致短请求也在模型调用前被拒绝。ECNU 公布模型容量，但公开材料不足以证明其完整输入模板与网关 framing；不能把底模 tokenizer、任意 padding 或合成计量器冒充真实上界。DSH 与 Deep Agents 使用近似计量处理上下文增长，说明严格计量不是所有 harness 的通用调用前提。[ECNU 能力](https://developer.ecnu.edu.cn/vitepress/llm/model.html)、[DSH 估算](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/llm/token-meter/src/estimate.ts)、[Deep Agents 计量](https://github.com/langchain-ai/deepagents/blob/deepagents%3D%3D0.7.6/libs/deepagents/deepagents/middleware/summarization.py)。

对已核实的 ECNU `ecnu-max` 配置，允许明确标记为 `approximate` 的完整请求估算，另计输出预留与正数安全余量；每次初始与后续调用均重新检查。估算只在内存中进行，持久回执只含计量、配置及状态元数据。计量器必须绑定真实模型实例、接收地址与有效配置；未知容量、错配配置、缺少计量器或不完整请求仍拒绝，不用猜测容量放行其他供应商。

正常短请求可以生成，接近预算提示，估算超限要求显式新开。估算不能保证供应商真实计数不超限；真实超长错误须明确报告、保留历史，不能伪造精确计数、静默裁剪、摘要或无限重试。成功与失败界面都应如实区分估算和已核实计量，旧计量回执继续可读。联系人、授权、来源删除、强制出站台账与人工发送约束不变；本决定不批准新的读取或外发范围。
