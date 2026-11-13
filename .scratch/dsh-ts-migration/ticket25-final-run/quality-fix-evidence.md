# Ticket 25 质量根因修复证据

核对日期：2026-10-25。Ticket 状态保持 `claimed`；本文件只记录修复和定向复测，不把新的 5 条探针加入原 96 条正式分母，也不认证全量质量或生产切换。

## 根因

1. 五个配对新增假事都来自“为风格变体补写未知”：新增候选分别编码了未知联系间隔、突然想到对方的心理触发、客观原因、本人仍在考虑或第三条兜底。历史检索、联系人绑定和来源白名单均正常；`risk_notes` 不能为正文补证。
2. `style-conflict:new:1` 的完整 SSE 含 `message_start`、342 个 `text_delta`、`message_delta end_turn` 和 `message_stop`，没有 `tool_use` 或 `ReplyRuntimeOutput`。业务返回 `reply_candidates_rejected` 是正确的，不能把拼出的文本 JSON 当成功。采集器的 `response_complete=false` 则是下游先关闭与上游 `end` 竞争造成的传输标记错误。

## 修复

- 结构化未知或上下文风险非空时，实际 DSH 系统提示逐项列出“不得写入正文”的未知，`ReplyRuntimeOutput` 的候选上限收紧为 1，准入器拒绝额外候选。没有未知时仍保留最多 3 条产品能力；不维护假事实句式黑名单。
- 未知清单已进入预检和正式生成共用的 system/tool 描述，因此序列化预算仍覆盖实际出站内容。
- 诊断采集器以协议终止事件判断传输完整性：Anthropic SSE 必须有 `message_stop` 且无 error，旧流必须 `[DONE]` 或有非空 `finish_reason`。传输完整不等同于业务成功；缺少工具调用仍失败。

## 真实模型定向复测

- 固定 `deepseek-flash`、temperature 0、top_p 1、thinking disabled、4096 输出上限、0 自动重试；仅公开合成材料，未操作 App、微信或 DBX，未发送外部消息。
- 使用原 Ticket 25 累计 ProblemBudget，每次真实 HTTPS 出站前逐次预留。共 10 次调用：首轮 5 次暴露“突然想起你”仍可能成为唯一候选，加入逐项未知禁区后第二轮再调 5 次。
- 最终 5/5 调用成功、5/5 单候选、5/5 SSE 传输完整；`prototype-gap:1`、`prototype-thought:2`、`paired-decline:2`、`group:3`、`missing:2` 的原新增假事未复现。
- 10 次合计 input 53,004、output 1,925、total 54,929 tokens，按原价格快照估算 USD 0.003950016；失败、空候选和费用均未删。
- 最终探针 SHA-256 `f7a4fbccc7bc06d681488f3dc602b26cc1b19c59dcdc8a70a0e0c415f15743ba`，私有诊断文件权限 `0600`、目录 `0700`。该探针不替代盲评。

## 确定性验证

- 新增候选准入、SSE 终态、系统未知禁区测试先红后绿。
- `reply-*` 435/435 通过；后端严格 TypeScript 检查通过。
- 后端有界全量 1267/1267 通过，0 失败、0 跳过，约 251 秒。

## 剩余风险

- 尚未重新执行完整 96 条同材料对照、两名独立盲评、第三裁决和非回复域质量矩阵，因此不能从 5 条定向复测推断 `overall=passed`。
- 自由文字中的未知仍依赖模型理解；确定性单候选上限只覆盖显式结构化未知与上下文风险，不声称语义真值已被本地规则证明。
- `style-conflict:new:1` 的工具调用失败是否会在全量重跑中再次出现仍未验证；工具调用合同本身没有放宽。
- 延迟五阶段、实际 App/微信范围、主动停止和 DBX 未保存查询仍按原报告保持未闭合。
