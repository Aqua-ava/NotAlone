# Ticket 25 模型可见面 alias inventory

核对日期：2026-10-25。范围是正式 Reply 生成中会进入模型 prompt、Tool schema、Tool 参数或 Tool 结果的字段；所有真实身份仍保留在业务内存、PG、公开 DTO 和审计来源中。

| 可见面 | 当前投影 | 边界 |
|---|---|---|
| 分层联系人／本人背景 | `profile_version_id`、`scenario_id`、`version_id`、`memory_id` 等统一为请求局部 `rN` | system prompt 与 `read_scenario` 共用同一个 alias map |
| 初始 generation payload | evidence 为 `cN`；结构化附属字段中的请求、候选、消息、会话、版本和资料标识分别投影 | 普通草稿、方向、目的、用户说明正文保持原文 |
| discussion / continuation | 会话 `sN`，证据 `cN`，其余关联标识 `rN`；JSON 对象和嵌套 JSON 字符串都递归处理 | 普通文本不按 UUID 形状猜测或改写 |
| Skill | 目录、选择、读取回执和输出 claim 使用 `kN` | claim 边界还原真实版本 UUID；未知或真实 UUID 输入拒绝 |
| `conversation_search` / `conversation_query` | 消息 evidence `cN`，session `sN` | 查询只接受当前请求别名；未知或真实参数拒绝 |
| `read_file` | 虚拟 Skill 路径与 `kN` 回执 | 不提供真实文件路径或 Skill 版本 UUID |
| `read_scenario` | 模型参数中的 scenario 使用 `rN`；回执中的 scenario、version、memory 引用使用 `rN` | Tool 边界反向解析当前请求别名；业务回执仍保存真实 ID |
| `ReplyRuntimeOutput` | citations 只接受当前请求 `cN`，Skill claim 只接受 `kN` | 真实 UUID、未知 alias、交换或未授权引用拒绝 |
| Tool schema/description 与错误 | schema 只使用字段名；错误返回稳定 code／通用原因 | 不回显真实身份或 Tool 原始参数 |

## 保持原样的字段

- `draft_text`、`current_text`、`confirmed_direction`、`confirmed_purpose`、`query`、`basis`、`risk_notes` 和各类说明文字是用户业务语义，不按内容形状扫描或改写。
- revision、时间戳、token、价格、布尔状态和 SHA-256 摘要不是关系身份；摘要不可逆且用于内部一致性绑定，继续保留。
- provider 的传输层 session/header 不属于应用模型 payload；本清单不宣称消除供应商协议自身携带的传输身份。
- 对 JSON 字符串的递归投影有深度和节点上限；超限返回 `reply_context_unavailable`，不会回退为原 UUID 文本。
