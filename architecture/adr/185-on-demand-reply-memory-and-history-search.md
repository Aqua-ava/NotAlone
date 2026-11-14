# ADR-185：先读近期语境，再按需检索记忆和历史

状态：已接受，2026-11-14 用户明确决定；已实现，50 个相关模块的 295 项合成测试及桌面／后台类型检查通过；真实模型效果另行验收。

## 背景与决定

固定取最近五条聊天做查询，不能解决短回复、表情或代词缺少主题的问题。回复模型已经能够看到最近五十条，因此由模型结合当前语境形成信息需求，再通过 DSH 官方只读工具补查；初始不再自动召回 L1，也不预计算记忆向量。

本决定局部替代 ADR-028 的固定查询构造、ADR-067 的初始 L1 注入、ADR-090 的历史工具装配及独立次数预算、ADR-182 的生成前语义预计算与不开放主动搜索条款。既有来源、人工保护、评分、删除和人工发送要求继续有效。

## 装配与范围

- 初始提供最近最多五十条合法聊天、本次独立输入、合法 L3 正文和 L2 目录；目录不当作已读正文。
- 信息不足时，模型调用 `search_relationship_memory` 搜索 L1，或调用 `search_relationship_history` 搜索历史原话。参数只有 `query`，身份和冻结范围由闭包固定；不提供 SQL、Shell、路径、微信读取或发送能力。背景关闭时两工具均不装配。
- L1 冻结当时合法范围的 ID、版本与正文摘要；历史冻结最多五百条合法消息身份、来源、解释修订、原作者和时间，另补齐初始消息 ID。新入库、改版或跨联系人消息不混入；历史窗口不等于全部历史。
- 本人 L1 沿既有 owner 范围读取；历史原话只属于当前 `owner_id + contact_id`。检索不创建联系人、不恢复读取授权、不触发同步。
- L1 在主动调用时沿用本机语义与词法混合评分，模型不可用时降为词法；历史消息按词法匹配。向量与得分仅在本机内存使用，不新增外部 embedding 服务。

## 预算、依据与删除

- 两搜索工具在同一请求内合计最多三次已接纳尝试，空结果、执行失败及超时也占次数；参数错误、重复查询和预算拒绝不执行，保留区分的无正文回执。Skill 降级不重置次数。
- 整轮去重后最多返回联系人 L1 五条、本人 L1 三条；补查消息合计最多十六条、2,048 估算 token。估算沿当前 UTF-8 字节策略，完整条目放不下时跳过，不截断原话。L2 原有两次成功读取预算独立保留，完整模型请求预算与物理调用上限继续生效。
- 实际结果和来源在同一短事务追加到候选输入，分配稳定材料编号；只有进入下一次真实 `model_request` 的结果才可作为候选依据。每次出站及保存继续复验精确来源、版本、作者和时间；未读目录、准备池和工具名称不冒充依据。
- 搜索池只存身份、版本和摘要，不复制正文或查询文字；它不是实际使用依赖。删除时在原事务定向剪除池与票据中的受影响锚点，保留次数和无正文状态，不因删除未使用资料撤下无关候选。实际使用资料仍沿既有闭包清除候选、运行记录及恢复副本。
- 未命中不证明不存在，能力失败不冒充空结果。旧上下文没有冻结范围时不补造范围；迟到结果、取消和重试均重新核验资格。

## DSH 与 DeepSeek 查证

声明、锁和实际解析的 DSH 包均为 `0.2.1-rc.2`，Cordis 为 `4.0.5`。参考源码固定到 `687f282e8625c6b8d11ff58211a90524be2e4317`；本机相邻仓库 HEAD 不同，使用 `git show` 只读查证，没有切换工作树。核对了公开类型和安装制品的相关编译实现，未宣称整个制品与源码可复现构建逐字一致。

工具通过公开 `defineTool` 和 agent scope 的 `tools.register` 注册；`restrict` 只限制全局工具，scope guard 和模型请求白名单同时约束新工具。官方 Agent loop 保存真实 tool call/result 并驱动后续模型步骤；既有取消、排空和 dispose 保留，不另造 Harness 或 provider。

依据：[官方工具扩展](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/tools/src/index.ts#L1065)、[工具事件保存](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/agent-loop/src/tool-calls.ts#L263)、[取消与释放](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/agent-loop/src/index.ts#L541)。

项目普通候选使用官方 DeepSeek Messages adapter。按 [Anthropic 兼容文档](https://api-docs.deepseek.com/guides/anthropic_api/)、[Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode/) 与 [Tool Calls](https://api-docs.deepseek.com/guides/tool_calls/)，由官方适配器完整回放 thinking、tool_use 及匹配的 tool_result；保持自动工具选择，不为本次检索切换 strict Beta 传输或手工拼模型循环。

## 验证与取舍

合成验证使用正式 SQLite、官方 DSH scoped Tools、正式 profile 和受控供应商替身；分别核验初始无 L1、主动结果实际入模、来源与删除、背景关闭、预算和 Skill 降级。模型会不会在真实聊天中正确决定何时查询，需要另做真实模型效果验收；本次不把合成工具调用视为该效果证明。

搜索可能增加模型轮次；没有信息缺口时可直接生成。保留五百条准备窗口作为当前有界读取合同，不声称可检索任意久远历史；若未来需要全历史，应单独替代冻结与索引策略。
