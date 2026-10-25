# Ticket 25 稳定前缀优化验证

核对日期：2026-10-25。对象：提交 `56f8e3b88d4ed2eb67ff7f3a7101fa365319bce4` 的缓存前缀优化。结论：**工程合同通过，真实小样未显示费用改善，不启动完整 96。**

## 唯一改动

- 逐例候选上限和明确未知禁区从 system 移到 `replyPayloadText` 的 user 消息尾部。
- `ReplyRuntimeOutput` 描述固定；实际候选数量仍由 `validateReplyCandidates(..., candidateLimit)` 强制。
- 569 的多消息只补边界空行规范化和任意实际文字差异拒绝保持原样。
- 没有删除 unknown、候选依据、引用、风险说明或候选上限执行。

## 离线验证

- `npm run typecheck` 通过。
- 直接合同测试 21/21 通过；全部 `reply-*.test.mjs` 为 441/441，0 失败、0 跳过。
- 相邻真实请求合同断言 system 完全一致，`ReplyRuntimeOutput` 名称、描述和参数 schema 完全一致。
- 未知案例的 user prompt 仍逐项包含“本轮明确未知”和“本轮候选数量上限是 1 条”。

## 真实供应商小样

使用独立 ProblemBudget `ticket25-stable-prefix-pinned-20261025`，选择 `stale` 三次重复与 `contact-style` 一次，固定四对双臂共 8 次物理调用。

- 8/8 成功、8 次物理 HTTPS、0 自动重试、0 失败；四个新臂 SSE 均完整，system 均不含候选上限或未知说明。
- 四个新臂 system 只有一个变体，长度均为 7,132 字符；`ReplyRuntimeOutput` 只有一个变体。
- 所有新臂 user prompt 都包含本轮候选上限；三个 `stale` 请求均逐项包含未知禁区，候选均已保存。
- 旧臂费用 USD `0.000923598`，新臂 USD `0.001328166`，比 `1.438035`。
- 旧/新总 token 比 `0.914378`；旧/新累计最终持久结果延迟比 `0.856310`。
- 新臂 cache hit/miss 为 `15,872 / 5,381`，hit 率约 `74.68%`，没有显示费用改善。
- 固定四对不构成正式 96、置信区间、质量盲评或签收证据；只能作为是否继续投入的信号。

另有一次快照接入失败：执行器仍固定 `5696cd91`，8 次请求均保留，但按 `unknown` 结案，不纳入本轮代码效果。失败证据位于 `ticket25-stable-prefix-20261025/sample-r1/`。

私有证据：

- pinned sample summary：`<私有诊断目录>/ticket25-stable-prefix-pinned-20261025/sample-r1/summary.json`，SHA-256 `6e8a5e5a858519187df8d4aab2435c4b001a98ade72892ceb7c3a82074f04731`
- pinned sample capture：同目录 `capture.sample-8.json`，SHA-256 `041a7f65cc00196245049b388dca8292c8ba75c7cf953392e2d4e6e0a0c7c63b`
- pinned ProblemBudget：`used=8/8`，`r1=regressed`，`no_improvement_rounds=1`
- invalid-source sample summary：`<私有诊断目录>/ticket25-stable-prefix-20261025/sample-r1/summary.json`，SHA-256 `044edc0f939f40f5cd7e5c48b51ec9779254c17b85fecabf303fe9af1b235d80`

## 处置

小样没有给出“明确改善”信号，故不创建下一轮 96 预算、不请求新的完整盲评，也不把 system/tool 稳定写成费用已解决。Ticket 25 继续保持 `claimed / not approved`；若继续优化，应针对真实 cache 对齐与非缓存 token 组成提出新的可证伪改动，而不是重复同一请求装配。
