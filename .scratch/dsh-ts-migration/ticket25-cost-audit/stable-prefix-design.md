# Ticket 25 稳定前缀设计审计

核对日期：2026-10-25。对象：`282f43af` 与 `5696cd91` 的回复请求装配，以及 `5696cd91` 最新固定 96 次 capture。只读分析；未调用模型、数据库、App、微信或 DBX，未修改产品源码。

## 结论

`5696cd91` 只改变了多消息正文的边界空行规范化，没有改变 system、tools 或用户 payload 的装配。最新费用比 `1.2716` 仍是真实 cache hit/miss 结构差异；它比 `282f43af` 的 `1.4111` 低，但两轮的新臂 system/tools 集合完全相同，因此这份下降不能归因于 569 的代码修复。

最小优化点是把 per-case 未知说明从 system 中段移到全部静态回复规则之后。该改动不删除未知项、不改变候选上限执行、不触碰 `ReplyRuntimeOutput` 参数和 `messages` 合同，只改变同一 system 中各文本片段的位置。当前 capture 上可把 48 个请求的共同 system 前缀从 `6,306` 字符增加到约 `7,144` 字符，增加 `838` 字符；这足以有合理机会跨过费用门禁，但必须用新的固定 96 次真实调用证明。

## 本轮证据

- capture：`<私有诊断目录>/ticket25-reply-stale-fix-20261025/rerun-5696cd91/capture.raw-96.json`，SHA-256 `dce751cdb9143da591d68c7abbe39ebefd984789c03fd53fa2c4181b1838fed5`
- machine audit：同目录 `machine-audit.json`，SHA-256 `0765a1620da4c17206dc2946fca50fc5f83439f06c84306501d9eafbb04eaaad`
- full summary：同目录 `full-summary.json`，SHA-256 `26f162d95ccb65c0a07f2d6e0fdc51e8fcce23414053a3abe144e46177b8852e`
- 旧臂：48/48 成功，hit/miss `264,960 / 9,351`，费用 USD `0.01104933`
- 新臂：48/48 成功，hit/miss `203,520 / 51,661`，费用 USD `0.01405071`
- 总 token 比：`0.9155965461`
- 费用比：`1.2716345697`

`282f43af` 与 `5696cd91` 两轮的新臂请求集合各自都有 14 个 system 变体、1 个 tool schema、48 个不同 user 首消息；两轮完整 system 字符串集合完全相同，tool schema 集合也完全相同。对排序去重的字符串以 NUL 连接后做 SHA-256，两轮的 system 集合都是 `689c692a8c19a21ac1dcd9488740c89ae94a5b24aabb9f14c61387282978cfa6`；对每个 tool schema 做键排序 JSON、再去重和 NUL 连接，两轮都是 `d553160a33f7dfdd0226c0cca9ab4db8ea07b7e00b48f40e4b9ac6d33a10ab12`。569 的 commit 仅涉及 `reply-contract.ts` 及其测试。

## 具体生成点

### 稳定内容

- `backend-ts/src/reply-prompts.ts:2`：`REPLY_SYSTEM_PROMPT`，长期回复、来源、当前意图和未知保留规则。
- `backend-ts/src/reply-candidate-prompt.ts:2-8`：`REPLY_CANDIDATE_ADMISSIBILITY_PROMPT`，未知存在时的单候选和不得补写规则。
- `backend-ts/src/reply-prompts.ts:3`：`REPLY_SKILLS_PROMPT`；本轮替换后的 Skill 使用说明、历史工具停止规则。
- `backend-ts/src/reply-loop.ts:33-36`：`ReplyRuntimeOutput` 的名称、`text/basis/citation_ids/risk_notes/messages` 参数结构。
- `backend-ts/src/reply-loop.ts:44`：DSH 的 `scope.systemPrompt.section` 把上述系统文本作为系统快照交给官方 adapter。
- DSH adapter `dsh-llm-deepseek@0.2.1-rc.2` 的 `lib/index.js:1714-1730` 把 `options.system` 写为 Messages API 顶层 `system`，把 tool schemas 写为顶层 `tools`；没有 NotAlone 侧手工 cache breakpoint。

### 动态内容

- `backend-ts/src/reply-candidate-admissibility.ts:16-28`：从 `user_instruction.unknowns` 或 `risk_notes` 生成本轮 unknown 清单和 `limit=1|3`。
- `backend-ts/src/reply-system-prompt.ts:13-14`：动态 `unknownNotice` 当前位于 `REPLY_CANDIDATE_ADMISSIBILITY_PROMPT` 之后、`REPLY_SKILLS_PROMPT` 之前；随后才拼接 discussion 和 relationship background。
- `backend-ts/src/reply-system-prompt.ts:11,14`：relationship background 和 discussion notice 是 per-request 或 per-contact 内容。
- `backend-ts/src/reply-loop.ts:34`：`ReplyRuntimeOutput.description` 目前把 `candidateLimit` 插入 tool schema；未知和无未知请求混合时会造成 tool schema 变化。
- `backend-ts/src/reply-loop.ts:44`：候选数量上限、Skill catalog、已选择 Skill 内容都追加到 system。
- `backend-ts/src/reply-payload.ts:44-84`：用户 payload 单独包含当前输入、`user_instruction`、证据、discussion 和 `risk_notes`。
- `backend-ts/src/reply-loop.ts:133`：每轮以一个 user message 发出该 payload。

## 当前前缀布局

最新 capture 的新臂 system 长度为 `7,228–7,232` 字符，48 个请求的共同前缀仅 `6,306` 字符。首个差异在“本轮明确未知”的各 case 清单；其后的约 `901` 字符静态 Skill 规则及本轮统一尾部都在缓存分叉之后。

48/48 个新臂请求的 cache read 都是 128 的整数倍：42 次 `4,224`，6 次 `4,352`。这支持 provider 按较粗的 token 块复用稳定前缀，但不能从 capture 反推出完整缓存算法。

## 最小方案

以下是角色不变的保守最小方案。审计过程中还观察到另一个并行会话在当前工作树留下了更强的未提交草稿，见下节；两者都没有在本次审计中修改。

### 1. 将未知清单移到静态 Skill 规则之后

只调整 `replySystemPrompt` 的拼接顺序，将 `unknownNotice` 从当前中段移到静态 `REPLY_SKILLS_PROMPT` 之后、discussion/relationship background 之前。各片段原文、未知项、单候选规则和系统角色全部保留。

目标布局：

```text
静态回复规则
静态候选准入规则
静态 Reply Skills 规则
per-case 明确未知清单
per-case discussion/background
registerReplyAgentSetup 追加的候选上限/Skill 目录/已选内容
```

这不是把未知降级成普通 user 数据，未知仍在 system 中，模型仍逐项看到 original 文本。当前 capture 的模拟只重排现有片段，不改字符内容，共同前缀从 `6,306` 变为约 `7,144` 字符，增加 `838` 字符。

### 2. 让输出 tool schema 不再随本轮 candidateLimit 改变

让 `ReplyRuntimeOutput.description` 固定表达“通常 1–3 条；明确未知或上下文风险时只返回一条”，实际候选数量继续由 `reply-loop.ts:127` 的 `validateReplyCandidates(..., candidateLimit)` 强制执行。当前轮次的动态 `candidate_limit` 仍保留在 system 中。

当前 96 条全部为 `candidateLimit=1`，该改动对这次 capture 的请求字节可能只有极小变化；它的作用是在真实业务混合出现 `1` 与 `3` 时避免 tool schema hash 切换。

### 3. 不改逐消息合同

不修改 `reply-contract.ts`、`messages` 参数或正文规范化。569 的 `group.join('\n\n')` 修复保持原样。

## 并行工作树上的更强草案

审计进行中，工作树出现了另一个会话的未提交改动。它把 `unknownNotice` 和动态 candidate limit 从 system/tool 移到 `replyPayloadText` 的 user prompt 尾部，并把 `ReplyRuntimeOutput.description` 固定为不含本轮数字的说明；候选准入仍由 `reply-loop.ts` 的 `validateReplyCandidates(..., candidateLimit)` 执行。

这与上文保守方案相比更彻底：

- system 不再含 per-case unknown 或 candidate limit，当前 96 条 capture 的空 discussion/background 条件下，system 可完全一致；模拟 system 长度约 `7,135` 字符，比当前共同前缀增加约 `829` 字符。
- tool schema 不再因 candidateLimit 变化；未知项和本轮上限仍原样出现在 user prompt，并由静态 system 准入规则约束。
- 未知清单本来就是 `user_instruction` 字段的数据，完整禁止规则仍留在静态 system；该重排没有删除信息，但改变了逐项说明的角色/优先级，因此必须用实际模型盲评确认质量没有变化。
- discussion/relationship background 仍在 system 中；它们在真实资料上会变化，未来若要求跨真实联系人也达到系统全稳定，需另做同样的数据/指令分层评估。本次 96 条合成 capture 的空背景条件不能证明这一点。

如果并行草案被正式集成，建议保留它当前的方向；它比只重排 system 更能确保 system/tools 稳定，也直接覆盖真实业务中 `candidateLimit=1/3` 混合的情况。其实现测试和模型质量仍需按本文的 RED/回归条件独立验收。

## 候选 RED 测试

1. `reply-system-prompt.test.mjs`：构造两个不同的结构化 unknown，计算两个输出的公共前缀；断言公共前缀已包含 `REPLY_SKILLS_PROMPT` 的最后一条读取边界，同时两个完整 system 都逐项包含各自的 unknown 原文和单候选提示。当前布局会在 Skills 之前分叉，测试应在改序前 RED。
2. `reply-loop` / `reply-service` 测试：分别用 `candidateLimit=1` 与 `3` 建 `ReplyRuntimeOutput`，断言名称、描述、`text/basis/citation_ids/risk_notes/messages` 参数 schema 完全相同；当前描述含“1到1/1到3”，测试应在描述固定前 RED。
3. `reply-service.test.mjs` 实际请求断言：未知请求的 system 仍包含逐项 unknown 和“候选数量上限是 1 条”，tool 描述仍明确未知只能一条，且额外候选仍被准入器拒绝。
4. 保持 569 的逐消息测试为绿色回归：无边界空行时只规范化为 `messages.join('\n\n')`，不改写消息文字，不改变消息顺序。
5. 保持来源、候选引用、风险说明、五种输入模式和独立盲评入口相关测试为绿色；本次只允许 system 片段位置与固定 tool 描述变化。

以上是候选 RED 设计，本次没有修改或执行测试。

## 预期缓存与费用影响

最新新臂若保持全部其他条件不变，费用门禁需要新臂总费用从 `0.01405071` 降至不高于 `0.012154263`（旧臂 `0.01104933 × 1.10`），即节省 USD `0.001896447`。按每 1M token 的 miss-hit 差额 USD `0.147` 计算，相当于每个新臂调用至少把约 `269` 个 miss token 转为 hit token。

当前静态尾部约多出 `838` 字符。按本轮的 `6,306` 共同字符对应约 `4,224` cache read token 粗估，增量接近 `561` token；按 128-token 块可能落为 `512` 或 `640` token。相应费用比在固定其他条件时约为：

| 每调用新增 hit token | 费用比估算 | 门禁 |
|---:|---:|---|
| 256 | 1.1082 | 仍失败 |
| 384 | 1.0264 | 可过 |
| 512 | 0.9447 | 可过 |
| 640 | 0.8629 | 可过 |

这只是基于现有字符/token 比例和价格差的敏感性估算，不是 provider 缓存命中承诺。真正的验收仍是同样 16 case × 3 repeat × 双臂、固定 96 分母的新真实调用，并重新报告 cache hit/miss、费用 CI、质量盲评和逐消息合同。

## 不能证明的部分

- 不能证明 provider 会连续缓存 reordered 前缀；128 token 对齐只是观测现象，不是公开保证。
- 不能证明 +838 字符一定对应 +269 以上 hit token；字符与 token 不是线性关系。
- 不能证明 system 文本重排后模型语义与质量逐字等价；必须在固定材料和新 system/tools hash 下重新跑 96 次及独立盲评。
- 不能保证真实产品中 history/scenario/skill tool 可用性使整个 tool 数组稳定；本方案只消除 `ReplyRuntimeOutput` 自身随候选上限变化的 schema 漂移。
- 没有供应商账单回执；“费用”仍是供应商 usage 与冻结价目表的估算。
