# 语用记忆最小验证规格

> 状态：prototype；只验证状态模型和真实模型输出的安全外壳，不接入正式记忆采纳链路。
> 日期：2026-09-09

## 要回答的问题

当一句联系人消息可能是事实、计划、假设、引用、吹牛或玩笑时，系统能否先保留语用解释和证据状态，而不是把字面内容直接写成 `confirmed_memory`？

最小安全底线是：假设、吹牛、玩笑、引用和不确定表达不能被一次模型输出直接确认成长期事实；后续确认或撤回可以改变候选状态。

## 工作范围

本 prototype 只包含：

- 一个可双击打开的 `prototype.html`，用于手动推动状态变化；
- 一个可选的真实模型冒烟脚本 `run_live_smoke.py`；
- 一个限定单一联系人、单一上下文窗口的真实数据验证脚本 `run_real_contact.py`；
- HTML 只使用合成中文；真实脚本只读已确认联系人范围，不写入记忆表、不发送聊天消息。

本 prototype 不修改现有 `memory_candidate` schema、`MemoryAdoption` 或正式提取流程。现有 `.scratch/memory-extraction/spec.md` 与 ADR-024 继续作为正式链路约束；如果 prototype 证明新维度可行，再单独提出规格修订。

## 模型选择

合成冒烟和真实数据验证使用当前 DeepSeek API 的新模型名：

- `model=deepseek-v4-flash`；
- non-thinking：`extra_body={"thinking": {"type": "disabled"}}`；
- `temperature=0.0`；
- 不设置 `top_p`；
- 使用现有 `langchain-deepseek` 依赖和结构化 tool output。

使用 `deepseek-v4-flash` 是为了避免已经退役的 `deepseek-chat` 别名；使用 non-thinking 是因为温度在 thinking 模式下不生效。prototype 不下载模型权重，真实冒烟只在进程环境或项目 `.env` 显式设置 `NOTALONE_DEEPSEEK_API_KEY` 时运行。

真实数据验证只读取 `owner_id + contact_id` 范围内的 active 消息，默认围绕 `--focus 贷款` 选取最多 80 条上下文，并只发起一次批量结构化调用；不会把整段历史上传。

## 解释输出

模型只提出解释，不拥有记忆状态迁移权。结构化结果包含：

```text
proposition
dialogue_act
assertion_status
literalness
time_status
alternatives
evidence_relation
source_message_ids
model_confidence
```

其中 `model_confidence` 只用于观察，不直接当作现实事实概率。

## 确定性算法

状态决策由纯函数完成：

```text
纠正/撤回                         -> invalidated
假设/引用/不确定/反讽/夸张/证据不足 -> pending
未来计划                          -> plan_candidate
明确、字面、证据支持               -> candidate
```

prototype 不把 `candidate` 自动提升为 `confirmed_memory`。这一步留给正式链路的 ADR-024 采纳门槛和用户确认流程。

算法还校验：

- 来源消息 ID 必须存在于当前窗口；
- `dialogue_act`、`assertion_status`、`literalness`、`time_status` 和 `evidence_relation` 必须是受控枚举；
- `alternatives` 和证据关系必须可见；
- 当前窗口原文中的高精度强语用信号（假设、引用、不确定、吹牛/玩笑、纠正/撤回）拥有降级优先级；它们只会阻止升级，不会单独生成记忆；
- 任何模型声称的 `confirmed`，只要命中不确定状态，就必须被算法降为 `pending`。

## 最小合成案例

1. “我现在在上海。”——明确事实，允许生成 `candidate`。
2. “我下个月准备去上海。”——未来计划，只生成 `plan_candidate`。
3. “如果我有 30 万，我就加仓。”——假设，必须 `pending`。
4. “明天 100w 到手，我贷款 30w 加仓。”，上下文带有“你又开始吹了”——吹牛/夸张，必须 `pending`。
5. “他说他要贷款 30 万。”——引用，不能记成联系人事实。
6. “我可能下个月去上海。”——不确定，必须 `pending`。
7. “我上次说错了，没有贷款，那是吹牛。”——纠正/撤回，必须 `invalidated`。
8. “我已经提交贷款申请了。”——后续证据可以支持原计划，但仍只在明确证据和正式采纳门槛通过后进入确认层。

## 验收标准

### prototype.html

- 可以手动选择 8 个解释场景；
- 每次操作都显示完整状态；
- “贷款 30 万”场景不会进入确认状态；
- “纠正/撤回”会让旧候选失效；
- 页面不依赖网络、构建工具或额外下载。

### run_live_smoke.py

- 无 API Key 时明确退出，不读取真实聊天数据；
- 有 API Key 时只发送上述合成对话；
- 每个结果必须符合结构化字段契约；
- 负例即使模型输出 `confirmed`，确定性安全门也必须把最终动作压成 `pending` 或 `invalidated`；
- 即使模型把负例误判为 `asserted + literal + direct`，原文强语用信号仍必须阻止它变成 `candidate`；
- 只输出合成案例和统计，不输出凭据。

### run_real_contact.py

- 必须通过精确联系人名匹配到唯一联系人，匹配歧义直接停止；
- 默认最多读取一个围绕 focus 的 80 条消息窗口，只做一次模型调用；
- 只输出动作和受控字段统计，不输出真实原文、命题文本或凭据；
- 只读数据库，不能写入记忆、台账或消息。

## 明确不做

- 不下载本地模型；
- 不把真实联系人整段历史上传；
- 不引入 Mem0、LangMem、NLI 模型或外部 benchmark 作为运行依赖；
- 不修改数据库迁移；
- 不改现有正式自动采纳策略；
- 不把 prototype 的通过结果宣称为真实联系人或生产环境验收。
