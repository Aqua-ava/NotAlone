# Ticket 25 费用比独立审计

核对日期：2026-10-25。核对对象：提交 `489136fd` 记录的 `282f43af` 固定 96 次同材料对照。只读核对正式私有证据；未调用模型、数据库、App 或微信，未修改产品源码。

## 判定

**1.411（95% CI 1.309–1.521）是真实的供应商 token 计费结构差异，不是比较器公式或分母错误。**

- 96 条记录逐条按冻结价格快照重算，落盘金额全部吻合，最大十进制残差 `1e-19`，差异来自 JSON 双精度序列化。
- 新臂总 token 比 `0.915`、费用比 `1.411` 并不矛盾：新臂少用了约 8.5% token，但缓存未命中 token 约为旧臂的 6.83 倍，而未命中单价是命中单价的 50 倍。
- 16/16 个 case 的三次重复费用合计都高于旧臂；逐 case 比值范围 `1.115–1.895`，不是少数离群记录或单次失败造成的门禁失败。
- 结果仍是基于供应商 usage 与冻结官网价格的费用估算，不是供应商账单/发票回执。

## 正式输入与摘要

- capture：`<私有诊断目录>/ticket25-reply-20261025/rerun-282f43af/capture.assembled-96.json`，SHA-256 `dd10ccbfcd87945c501ce44a7ca8f12e183b496000e88d0bce83e55882f4fa4e`
- normalized run：`ticket25-reply-run-v2-final.json`，SHA-256 `7ffe9a2824b6295d30d6ebc2d5ab6d608b2ad12195b539ecb22f482f93f831f3`
- normalized summary：`ticket25-reply-summary-v2-final.json`，SHA-256 `84d556feb2888c32075492b1728824c9305c82ae9a6da844103ef39273af0d09`
- formal report：`ticket25-reply-report-v2.json`，SHA-256 `63cbbcb8de3f46c51774b1d153d3868381cc3cd669c0a88181e42f31782c7217`
- machine audit：`rerun-282f43af/machine-audit.json`，SHA-256 `37678f92f56927e1cd14767cb14a92c280eda2f53ccc805578cff661980a2a21`
- report status：`overall=failed`；population `96/96`，missing `0`；两张臂各固定分母 48。

## 价格快照

`config.json` 的冻结快照为：

- billed model：`DeepSeek-V4.1-Flash-1017`
- currency：`USD`
- source page：`https://api-docs.deepseek.com/quick_start/pricing`
- source page SHA-256：`b856a6e93fa4793ecc8f3fd03a01bb7d8f7572f78a4739da8ce6dbdb09328d66`
- cache hit：`0.003 USD / 1,000,000 tokens`
- cache miss：`0.15 USD / 1,000,000 tokens`
- output：`0.6 USD / 1,000,000 tokens`

2026-10-25 再次只读取得官网页面，字节 SHA-256 与快照完全一致。页面明确价格单位为每 1M token，`$` 列值与快照一致；快照采用 OFF-PEAK 价格。正式调用范围为 `2026-10-25T05:36:21.106Z` 至 `2026-10-25T05:39:51.285Z`，当天为星期日；官网页脚定义周末全天 off-peak，因此未把 PEAK 价格误用于本次运行。

## 旧/新费用公式

两臂落盘费用都对 96 条供应商 usage 使用同一公式，没有臂间公式切换：

```text
cost_usd =
  cache_hit_tokens  * 0.003 / 1_000_000 +
  cache_miss_tokens * 0.15  / 1_000_000 +
  output_tokens     * 0.6   / 1_000_000
```

旧臂原始 OpenAI Chat usage 使用 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`；新臂原始 Anthropic/DSH usage 使用 `cache_read_input_tokens` 作为 hit、`input_tokens`（该响应中为非缓存输入）作为 miss、`cache_creation_input_tokens` 作为 write。normalized usage 映射后，两臂均满足 `cache_hit + cache_miss = input`。

## 汇总复算

| 指标 | 旧臂 | 新臂 | 新/旧 |
|---|---:|---:|---:|
| 逻辑/物理调用 | 48 / 48 | 48 / 48 | 1.000 |
| 成功 / 失败 | 48 / 0 | 46 / 2 | — |
| 输入 token | 274,311 | 255,067 | 0.930 |
| 输出 token | 15,187 | 9,683 | 0.638 |
| 总 token | 289,498 | 264,750 | 0.914514 |
| cache read token | 264,960 | 191,232 | 0.722 |
| cache write token | 0 | 0 | — |
| cache miss token | 9,351 | 63,835 | 6.827 |
| cache hit 比例 | 96.59% | 74.97% | — |
| 费用（USD） | 0.01130973 | 0.015958746 | 1.411063 |

费用分量：

| 分量 | 旧臂 USD | 旧臂占比 | 新臂 USD | 新臂占比 |
|---|---:|---:|---:|---:|
| cache hit | 0.000794880 | 7.03% | 0.000573696 | 3.59% |
| cache miss | 0.001402650 | 12.40% | 0.009575250 | 60.00% |
| output | 0.009112200 | 80.57% | 0.005809800 | 36.41% |
| 合计 | 0.011309730 | 100% | 0.015958746 | 100% |

## 调用、失败与门禁口径

- 96 条均为 `logical_calls=1`、`physical_calls=1`；无自动重试。
- 新臂两个失败项是 `stale:new:1`、`stale:new:2`，均为 HTTP 200 后业务准入拒绝；供应商 usage 和已发生费用完整保留。
- 费用、token 和调用均按 `all_terminal_observations` 汇总，每臂分母固定 48。两次失败计入新臂 token 与费用，未删分母、未补跑、未退款。
- 两笔失败费用合计 `0.000860004 USD`；即使错误地只扣掉这两笔费用而不扣分母，费用比仍为 `1.335`，依然超过 `1.10`。
- `backend-ts/src/reply-comparison.ts:315-320` 校验 usage 分量、币种、价格快照 SHA，并把 `cost.amount` 纳入测量；`:338-347` 对非延迟指标使用全部终态观测，费用门禁为 `total_ratio <= 1.10`。
- `backend-ts/src/reply-comparison.ts:72` 的 `upperGate` 在 CI 下界大于门禁时判 fail。费用 CI 下界 `1.3085` 大于 `1.10`，所以报告判 `failed` 正确。
- 独立按 `reply-comparison-statistics.ts:2-26` 的 seed 102、10,000 次 paired-case bootstrap 复算，得到 `1.411063394086331`、CI `[1.3085107655943984, 1.5211425281334474]`，与正式报告一致。

## 缓存差异的结构证据

- 旧臂 48 个请求均为 `system + user`；第一个 system content 在 48/48 中完全相同，system content hash 只有一个。
- 新臂 48 个请求均为单一 `user` message；48/48 的第一个 user message hash 不同，DSH `system` 字符串有 14 个变体。
- 新臂各 case 的 `system` 在三次重复中稳定，但跨 case 只在约 6,306 个字符的公共前缀后分化，随后是“本轮明确未知”等动态上下文；实际 cache read 主要落在约 4,096 或 4,224 token 的稳定前缀。
- 旧臂 system 内容完全一致且 user 重复相同；新臂把随 case 变化的动态内容放入 system 尾部并在 user 块引入逐次变化。该结构差异与新臂在所有 case 中更低的 cache hit 比例一致。

因此，当前费用差异是协议/请求装配导致的真实 provider cache 结果，不能归因于比较器把 token 或币种算错。同时，证据不足以称其为“无法避免”的 provider 行为：稳定提示、工具定义和动态未知内容的排列顺序是当前装配可优化的候选，需以新的固定分母实测判断能否收回缓存命中。

## 审计限制

- 比较器只验证 `cost.amount` 非负并与冻结快照 SHA/币种绑定；它本身不根据 usage 与三项费率重新计算金额。本次审计独立重算弥补了该检查，但后续若要让报告自证公式，应把费率完整绑定并重算金额，避免只信任采集器输出。
- 没有供应商账单回执，不能证明最终结算金额；这里“真实差异”指原始供应商 usage 对应到冻结公开价目的费用估算真实存在。
- 官网页面使用 `$` 列价，快照声明 USD；没有另行取得供应商账单币种回执。
