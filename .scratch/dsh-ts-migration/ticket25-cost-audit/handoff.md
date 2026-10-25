# Ticket 25 交接

状态：`claimed`，未获最终 approve。禁止创建或启动完整 96、调用真实模型、push、打包、PR、App/微信操作。

## 当前提交

- 源代码切片：`030d3e1c9b2d3bf1841cd4d34f84e2ffc909da75`；本交接文件由紧随其后的独立提交保存。
- 此前 alias/Skill 基座：`fb64f0ee`；来源采集基础：`cf88db24`。
- 本轮只提交分层资料/system、`read_scenario`、偏好和 v2 实际采集切片，共 14 文件。

## 已完成

- [reply-system-prompt.ts:10](../../../backend-ts/src/reply-system-prompt.ts:10) 用同一请求局部 map 投影分层资料 JSON。
- [reply-preparation.ts:93](../../../backend-ts/src/reply-preparation.ts:93) 的 `read_scenario` 只接受 alias，边界反解真实场景，回执再投影为 alias。
- [reply-payload.ts:80](../../../backend-ts/src/reply-payload.ts:80) 投影表达偏好 ID 与 scope。
- [reply-comparison-sources.ts:62](../../../backend-ts/src/reply-comparison-sources.ts:62) 绑定源码树、提交、工作树状态和 argv。
- [reply-comparison-sources.ts:89](../../../backend-ts/src/reply-comparison-sources.ts:89) 从实际请求与完成后 PG 来源生成 v2 catalog/mapping。
- 模型可见面清单：[model-visible-alias-inventory.md](./model-visible-alias-inventory.md)。

## 验证

- 第四轮 2 个 RED：2/2 通过。
- 相关定向套件：58/58 通过（含 system、scenario、inventory、实际 DSH+PG 采集、来源审计）。
- TypeScript：通过。
- 公开扫描（提交前）：0 issues；提交后由接手 agent 复扫。
- 未调用真实模型；未执行完整 96。

## 下一步

1. 先检查 [reply-comparison-capture-runtime.test.mjs:35](../../../backend-ts/test/reply-comparison-capture-runtime.test.mjs:35) 与 [reply-model-surface-inventory.test.mjs:13](../../../backend-ts/test/reply-model-surface-inventory.test.mjs:13)。
2. 复核第四轮 findings 是否还能在完整 Tool continuation/error 面复现。
3. 新用户可见独立审查 approve 前不得固定 96 源码或启动真实调用。

## 剩余风险

- 工作树存在其他任务未提交文件，不可 reset/checkout/批量暂存。
- v2 collector 的实际 96 runner 尚未接线，当前是生产装配函数加实际 host/PG 回归。
- 传输层 provider headers/会话身份不属于应用模型 payload，本切片未消除。
