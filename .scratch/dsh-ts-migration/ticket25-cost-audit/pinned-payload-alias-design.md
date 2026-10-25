# Ticket 25 pinned 请求的稳定 payload 设计审计

核对日期：2026-10-25。对象：稳定 system/tools 后的 pinned 8-call、`56f8e3b8` 请求装配，以及锁定 DSH `0.2.1-rc.2`／commit `687f282e8625c6b8d11ff58211a90524be2e4317`。只读设计审计；未调用模型、数据库、App、微信或 DBX，未修改产品源码。

## 结论

稳定 system/tools 只消除了第一个前缀分叉，费用仍然失败的原因是 user payload 太早在随机 evidence UUID 处分叉。

推荐下一层采用**请求内确定性 evidence alias**：

- 模型只看到按 evidence 稳定顺序生成的短别名，如 `c1`、`c2`；真实 UUID 到 alias 与 alias 到真实 UUID 的映射只存在当前请求内存。
- 模型输出的 `citation_ids` 中只接受当前请求的 alias；在现有 UUID 合同之前一次性映射回真实 evidence UUID，再执行候选、来源和持久化校验。
- 不需要把真实 UUID 或真实↔alias 表发送给模型。仅把 ID 字段原地替换为 alias，比移动 JSON 块更小，也能让同一 case 的重复 payload 字节完全一致。
- 不新增数据库 schema。真实 UUID 仍是唯一持久化身份；alias 不进入 PG、HTTP 结果或来源回执。

这能显著改善缓存资格，但 provider 明确是 best-effort，最终必须重跑固定 96 次才能验收。

## Pinned 证据

- capture：`<私有诊断目录>/ticket25-stable-prefix-pinned-20261025/sample-r1/capture.sample-8.json`，SHA-256 `041a7f65cc00196245049b388dca8292c8ba75c7cf953392e2d4e6e0a0c7c63b`
- summary：同目录 `summary.json`，SHA-256 `6e8a5e5a858519187df8d4aab2435c4b001a98ade72892ceb7c3a82074f04731`
- 新臂 commit：`56f8e3b88d4ed2eb67ff7f3a7101fa365319bce4`
- 4 个新臂请求的 system 只有 1 个 SHA-256：`c7dbf84e830e75db4835d314ddbd29b58a028d27b66679f5802adef8d41e3cd4`
- 4 个新臂请求的 tools 只有 1 个 SHA-256：`0b4c304d02d156535cae05c434572976359adc1751d51dec81fc80ed875123bd`

| 指标 | 旧臂 | 新臂 | 新/旧 |
|---|---:|---:|---:|
| 记录数 | 4 | 4 | — |
| 物理调用 | 4 | 4 | 1 |
| 输入 token | 22,897 | 21,253 | 0.928 |
| 输出 token | 1,209 | 789 | 0.653 |
| cache hit/miss | 22,016 / 881 | 15,872 / 5,381 | — |
| 费用 USD | 0.000923598 | 0.001328166 | 1.438035 |

新臂四个请求的 cache hit 分别是 `3,328`、`4,224`、`4,224`、`4,096`，仍是 128 token 对齐。system/tools 已稳定，因此当前 hit 只能解释稳定系统、工具和约 443 字符的共同 user 前缀。

## UUID 分叉位置

以 pinned `stale` case 为例：

- 3 个新臂 user payload 长度各为 `3,368` 字符，但完整文本 hash 各不相同。
- 三个 payload 的共同前缀只有 `443` 字符，结束于 `evidence:[{"evidence_id":"`。
- 每个 payload 有 3 个唯一 evidence UUID、共 6 次 UUID 出现；另外 3 次来自重复的 `citation_policy.allowed_evidence_ids`。
- UUID 之后仍有 fidelity contract、`risk_notes` 和本轮未知/候选上限等公共内容，但都位于首个随机分叉之后。
- 旧臂同 case 三次 user 文本逐字节相同，LCP 为完整 `3,474` 字符；这不证明 old/new 提示等价，但解释了旧臂更高缓存率。

把每个 evidence 的 UUID 按 evidence 数组顺序替换成 `c1`、`c2`、`c3` 后，3 个新臂 user payload 的完整文本完全相同，LCP 从 `443` 扩展到完整 `3,368`（含现有末尾运行约束）。替换只在模型投影中发生，真实 UUID 不动正式 context、数据库行或对外结果。

## Alias 的安全合同

### 生成

1. 使用 `buildReplyPayload` 已经排序后的 `evidence` 数组顺序，生成 `c1…cN`。
2. 同一真实 evidence UUID 的所有出现位置使用同一 alias；`evidence[].evidence_id` 与 `citation_policy.allowed_evidence_ids` 必须同步替换。
3. 映射必须双向、一对一、请求局部；不得按 UUID 哈希生成 alias，否则 alias 会随真实 random UUID 漂移，无法让重复材料获得相同 payload。
4. 不把真实 UUID 或真实↔alias 映射追加到模型输入。模型只需要 alias；真实映射留在端侧当前调用内存。
5. alias 与真实 UUID 集合都不得跨 owner/contact/request 复用。不同联系人的 `c1` 必须分别解析到各自请求的 evidence，旧请求 alias 在后续请求默认无效。
6. Skill 版本使用同一请求局部的 `k1..kN` 投影：`skill_selection.version_id`、受控目录、读取回执和 `ReplyRuntimeOutput.used_skill_version_id` 只出站 alias；claim 边界再还原为真实版本 UUID，PG 与 `SkillUse` 继续保存真实值。模型直接返回真实 UUID、未知或未读取的 `kN` 均拒绝。
7. 系统拥有的 DTO／序列化关联字段采用有界递归；自由正文即使是合法 JSON 也逐字保留，不解析订单号、数字或用户主动输入的标识。仅 `generation_input`／候选讨论正文及 `submission`、`continuation`、`input_payload`、`payload_json` 的系统 envelope 继续解析；深度或节点数超过上限时按不可用拒绝，不能静默回退到原系统身份。

### 输出还原

在 `reply-loop.ts` 当前调用 `validateReplyCandidates(args, ports.evidenceIds(), candidateLimit)` 之前：

1. 深拷贝模型参数，只处理每个 candidate 的 `citation_ids`。
2. 每个元素必须精确等于当前请求的 alias；用当前请求反向映射得到真实 UUID。
3. 保留引用顺序和重复引用；例如 `c2,c1,c2` 必须映射为 `id2,id1,id2`，不能排序、去重或重绑。
4. 接着走现有 `replyUuid`、evidence allowlist、候选数量、逐消息正文和来源校验；不要放宽现有 validator。
5. 持久化的 candidate、`context_receipt.evidence_ids` 和 HTTP 结果全部使用真实 UUID；alias 和映射不得写入业务表。

### 系统提示与 schema

`backend-ts/src/reply-prompts.ts:2` 当前静态规则要求 `citation_ids` 原样复制输入 evidence 的 UUID。需要把它改成“原样复制输入 evidence 的 `evidence_id` 不透明字符串”，并在静态 system 中说明“不得猜测或改写 alias”。这与 56f 的静态 system 策略一致，不会重新引入 per-case system 文本。

`ReplyRuntimeOutput` 的 `citation_ids` 仍是 string array，参数 schema 和逐消息合同不变；`candidateLimit`、`messages` 和额外候选拒绝逻辑不变。

### 历史 Tool

当前 pinned 96 没有调用历史 Tool，但产品真实能力不能只在初始 evidence 上支持 alias：

- `backend-ts/src/reply-history.ts:55` 的工具结果会返回真实 `evidence_id`、重复的 `message_id`，并暴露 `source_ids`。
- 正式实现必须在 history Tool 结果进入模型前，把可引用 evidence ID 注册到同一个请求局部 alias 表并替换；`source_ids` 不应进入模型可见结果。
- 若真实 `session_id` 等操作参数仍由工具返回并被模型用于下一次工具调用，需要独立的参数级 alias→真实值 resolver；不能盲目把任何 UUID 都当引用 alias。

因此最小正确范围不能只改初始 payload；初始 evidence、动态 history evidence 和最终引用还原必须共用同一个请求局部映射器。Ticket 25 的 pinned 合成材料可以先验证初始 evidence 分支，但不能据此宣称真实历史 Tool 路径完成。

## DSH 是否支持显式 cache breakpoint

结论：**不支持，也不需要在本项目里手工增加；DeepSeek Messages 路径的显式 `cache_control` 会被忽略。**

锁定依据：

- 安装包 `@deepseek-ai/dsh-llm-deepseek@0.2.1-rc.2` 的 `lib/types/wire-types.d.ts` 中，system 是 string，messages text/tool blocks 均没有 `cache_control` 字段。
- 该 adapter 的 `lib/index.js:1714-1730` 把 system/tools/messages 序列化为固定 body，没有 cache breakpoint 参数。
- locked README `README.md:179-181` 明确：未改变的已组装前缀有资格被 DeepSeek 自动复用；tool schema 变化会从首个改变 token 起阻止复用。`systemPromptUpdate: in-history` 只处理 continuing session 的后续 system 快照，不是任意请求的显式断点。
- 官方 DeepSeek Anthropic compatibility 文档明确将 tool/text/tool_use/tool_result 的 `cache_control` 标为 **Ignored**：`https://api-docs.deepseek.com/guides/anthropic_api`，本次页面 SHA-256 `19b5e723f1c65f609c010999cdf3cc1929327c4369c54b0151e8ea82dc3dd033`。
- 官方 Context Caching 文档说明缓存默认开启、按 complete prefix unit 命中、固定 token 间隔持久化、best-effort 且不保证命中：`https://api-docs.deepseek.com/guides/kv_cache`，本次页面 SHA-256 `2d738124f30f07c768ade795cf5157c8584b705aaa0ef036383abad746185fb6`。

因此不能靠新增 ignored 字段或 DSH 私有修改解决问题；必须让自动识别的共同前缀更长且精确成为可复用单元。

## 能否用更小改动达到旧臂 hit 规模

不能直接追求旧的绝对 `5,504` hit token：

- pinned 新臂 4 次输入分别为 `5,325`、`5,315`、`5,309`、`5,304`，都低于 `5,504`；cache hit 不可能大于输入 token。
- 凭空增加静态文字来抬高 system token 属于无效 padding，会增加 miss 成本，且不是语义等价优化，不应采用。
- 仅把 UUID 块移到 JSON 末尾但不改其值，只能延长共同前缀，三次 payload 仍不能完整相等；但比原地保留 UUID 小改动更能延长前缀。
- 更小的有效改动是原地 alias 化，而不是搬运整块 JSON：它不改变字段顺序、消息结构或正文/事实顺序，却能让重复 payload 完整相同。
- 如果必须最大化跨不同 case 的前缀，再考虑把稳定用户字段提前、动态 IDs 置尾；这属于第二级排序优化，不能替代 alias。

验收目标应是比较费用与 cache hit/miss 结构，不应把旧臂绝对 hit token 当作新协议必须达到的指标。

## Cache 预期

pinned 8-call 要把费用比降到 1.10，需要新臂总费用从 `0.001328166` 降至 `0.0010159578`，节省 `0.0003122082 USD`，相当于每个新调用把约 `531` 个 miss token 转为 hit token。

只做 alias 的 illustrative 上限：若 `stale` repeat 2/3 因 payload 完全一致而各命中完整输入，保持 repeat 1 与 contact-style 的当前 hit/miss 和输出不变，pinned 费用比约为 `1.0917`。这是由文档中的“user input 末端 cache prefix unit”推导的敏感性估算，不是命中保证；真实值仍受缓存是否已持久化、执行顺序、token 化和 best-effort 影响。

## 候选 RED 测试

1. `reply-payload` 纯函数测试：同一 case 的两个 evidence 集合，内容与顺序完全相同、仅真实 UUID 不同；模型 payload 必须逐字节相同，LCP 等于完整 payload，且模型文本不含真实 UUID。当前实现会在任一 UUID 处 RED。
2. alias 映射测试：`c2,c1,c2` 还原后严格等于真实 `id2,id1,id2`；重复、顺序和候选隔离保持。未知 alias、跨请求 alias、重复 alias 指向两个真实 ID、模型直接返回任意真实 UUID 都必须拒绝。
3. `reply-loop`/`reply-service` 集成测试：假模型实际收到 alias，返回 alias 后 PG、candidate DTO、`context_receipt.evidence_ids` 和来源审计全为真实 UUID；alias 不进入持久化。
4. History Tool 测试：工具返回真实 evidence 后，模型结果只看到新请求局部 alias；模型用该 alias 返回候选时持久层映射回真实消息 ID，`source_ids` 不进入模型可见文本。
5. Source audit RED：v2 catalog 只保存真实来源，模型 alias 以独立 `model_alias_mapping` 保存于同一私有 attempt；alias 连续，真实 ID 唯一，mapping 与请求 payload、PG snapshot 和输出一一对应时审计通过。交换或复用 alias、把 alias 写入 catalog、映射到未授权 evidence 时必须失败，`runtime_sources` 仍能证明外发序列与真实来源一一对应。
6. Collector 通过 `captureReplyRuntimeSourceAttempt` 从实际 DSH wire request 中的 `c1..cN` 与完成后按 `reply_request_id` 查询的有序 `reply_context_evidence` 共同生成 v2 catalog 和 mapping；attempt 绑定实际源码树摘要、提交、工作树状态、argv、request 与 catalog 摘要。测试必须启动实际 host/PG 装配，不得预置 mapping 或来源快照。
6. 绿色回归：56f 的 system/tools 单哈希、未知项/候选上限 user prompt、额外候选拒绝、569 的 `messages.join('\n\n')` 逐消息规范化、引用至少一条和所有引用属于本轮 evidence 均保持。

## 最小实施范围

1. 新增纯函数模块：稳定顺序 alias 投影、请求局部双向 map、候选 `citation_ids` 还原；不接触产品身份或数据库。
2. `reply-payload.ts`：模型 payload 使用 alias；保留内部真实 payload 供来源/持久化审计，或返回显式 `text + aliasMap` 投影，避免重复生成时漂移。
3. `reply-service.ts` / `skill-review-service.ts`：把同一 alias map 传给实际生成和预检路径；预检序列化内容必须与实际出站一致。
4. `reply-loop.ts`：在现有 `validateReplyCandidates` 前还原 alias；随后保持原 validator 与持久化路径不变。
5. `reply-history.ts`：工具结果进入模型前投影 alias，扩展当前请求 map；不要泄露出站不用的 `source_ids`。
6. `reply-system-prompt.ts` 的静态提示只改“复制不透明 evidence_id”，不要新增 per-case system 内容。
7. `reply-comparison-sources.ts` 与 collector：核对 payload alias、映射唯一性和最终真实 UUID；原始 alias 输出可作为私有诊断证据，但业务持久化不能使用 alias。
8. 无 schema migration；alias map 只在单次请求内存中存在，完成、失败或取消后销毁。

## 不能证明的部分

- 不能保证 DeepSeek 自动 cache 一定命中完整 alias 化 payload；官方明确 best-effort。
- 不能保证 alias 后 token 数线性下降；短 alias 会减少字符，但实际 tokenization 仍以 provider usage 为准。
- 不能用 pinned 8-call 代表完整 96 次费用或质量；必须用固定分母完整重跑。
- 不能证明 alias 化对模型选择引用没有行为影响；需独立盲评和故障/拒绝用例。
- 本次 synthetic capture 没有历史 Tool，不能据此证明真实历史检索路径已完成 alias 全链路。
- 不能消除 provider 收到的鉴权身份、匿名用户 ID 或 session header；这些不是模型 prompt 内容，但也不应宣称“完全匿名”。
