# 01 — 提取接缝、证据契约与主体标注

**What to build:** 记忆提取核心接缝：消息窗口经模型运行时（fake 驱动）返回结构化事实候选，确定性外壳逐条校验证据契约——引用消息必须在窗口内、文本非空、五类分类/三值主体/受控主题合法、置信度必填——合法候选通过、非法拒绝；prompt 含上下文语气理解要求与负例示范；整体不可解析返回明确失败。

**Triage:** ready-for-agent
**State:** resolved
**Blocked by:** None — can start immediately

- [x] 提取运行时接缝与强化 schema（全字段 description、禁字符串数组、低温、function calling 路径）
- [x] 候选含事实文本、主体（self/contact/shared）、五类分类、消息引用、置信度、风险标记、受控主题（健康/工作/家庭/出行/财务/学习/情感/其他）、可选有效期
- [x] prompt 含"结合上下文理解语气（反讽/玩笑/抱怨）"要求与负例示范（闲聊不产出记忆）
- [x] 证据契约校验：窗口外引用、空文本、非法分类/主体/主题、缺置信度被拒且不进入结果
- [x] 整体不可解析返回明确失败（可重试语义）
- [x] fake model 单测覆盖合法、逐类非法、失败路径；不调真实 API；只用合成数据

## Comments

- 2026-08-23 完成（提交 94e98a9）。实现：`notalone/memory_extraction`（models 值对象与校验、runtime Protocol、adapters LangChain 结构化输出、flow 确定性外壳）+ 15 个单元测试。
- code-review 后重构：逐条字段解析从 runtime 下沉到外壳（非法字段逐条拒绝并计数，不再整窗失败）；MessageRef.sender 收紧为 self/contact 枚举并在窗口序列化中标注（主体判断的输入依据）；schema enum 由既有枚举推导消除双重维护；移除批内文本去重（属 03/04 裁决层职责）与 last_prompt 测试接缝。
- 验证：提取模块 15 例全绿，全量 209 例通过（1 例冒烟按凭据跳过）；全程 fake model 无外部调用。
