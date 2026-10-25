# Ticket 25 请求局部证据 alias 小样验证

核对日期：2026-10-25。对象：提交 `98ec114f3119decfe327c2d7505fed5542a0a176`。结论：**alias 工程链路与缓存方向通过小样，费用门禁仍失败，不启动完整 96；Ticket 25 保持 `claimed / not approved`。**

## 小样合同

- 使用独立 ProblemBudget `ticket25-payload-alias-pinned-20261025`，固定 `stale` 三次重复与 `contact-style` 一次，共四对双臂。
- 源码快照精确为 `98ec114f`；新增 alias 文件 SHA-256 为 `9cdd2c2f684947dfd05020a47dfdbd9643f48af1e485b8502f0dbd928d99fd35`。
- 8/8 成功、8 次物理调用、0 自动重试、0 失败；ProblemBudget `used=8/8`，`r1=regressed`。
- 模型可见 evidence 只出现 `c1…cN`。四个新臂来源审计均为 `verified`；PG、候选输出和引用白名单使用真实 UUID。
- `stale` 三次新臂 prompt 只有 1 个字节变体；`contact-style` 只有 1 个变体。真实来源 UUID 均未出现在模型请求中。
- 新臂 system 与 `ReplyRuntimeOutput` 各只有 1 个变体。

## 费用与缓存

| 指标 | 旧臂 | 新臂 | 新/旧 |
|---|---:|---:|---:|
| 记录数 | 4 | 4 | — |
| 物理调用 | 4 | 4 | 1 |
| 输入 token | 22,897 | 20,787 | 0.908 |
| 输出 token | 1,276 | 654 | 0.513 |
| cache hit/miss | 22,016 / 881 | 15,488 / 5,299 | — |
| 费用 USD | 0.000963798 | 0.001233714 | **1.280055** |
| 持久结果延迟 ms | 8,882.793 | 6,675.584 | 0.752 |

费用比相对稳定 system/tools 小样的 `1.438035` 有改善，但仍高于 `1.10` 门禁。按 case 汇总，`stale` 为 `1.299846`，`contact-style` 为 `1.210550`；固定四对不构成完整 96、置信区间、质量盲评或签收证据。

## 失败证据

另有一轮使用独立 ProblemBudget，实际执行源码为旧提交 `56f8e3b8`，不是要求的 `98ec114f`。该轮 8 次物理调用与费用保留，ProblemBudget 按 `unknown` 结案，不纳入 alias 效果。

## 私有证据

- pinned sample summary：`<私有诊断目录>/ticket25-payload-alias-pinned-20261025/sample-r1/summary.json`，SHA-256 `a4d5acdac899faf4b045b2df6a13e452236057fe8e6ea0b487a76868dfe13025`
- pinned sample capture：同目录 `capture.sample-8.json`，SHA-256 `095b577229b91f84d7b246c51fb6125b7a22f66d232dc4c1a910a6a6c93b8e2b`
- invalid-source summary note：`<私有诊断目录>/ticket25-payload-alias-20261025/invalid-source-note.json`

## 处置

不创建下一轮 96 预算，不把本小样写成费用通过。待独立审查给出精确 RED 后，先补齐续写/讨论附属字段与历史关联参数的 alias 覆盖；新一轮完整 96 必须使用新 ProblemBudget、新源码快照、完整固定分母和重新盲评。
