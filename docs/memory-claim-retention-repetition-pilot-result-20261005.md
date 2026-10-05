# 记忆核心事实保留：重复测量对照结果（2026-10-05）

本轮按用户 2026-10-05 批准的[重复测量有限对照提案](memory-claim-retention-repetition-pilot-proposal-20261005.md)执行唯一一次真实运行：**16 次公开 V 调用**（2 个已冻结匿名窗口 × 4 次重复 × 2 臂，E=0／V=16／R=0），只用现有 ECNU `ecnu-max`，不读真实聊天或留出，不写业务记忆与水位。预算 16/16 闭账，0 重试、0 补位。

## 运行边界

- 冻结计划 `frozen-plan-v2.json`（计划 SHA `8a96dcfd…`）：两臂分别为 `baseline`＝提交 `e015b96` 的改动前产品提示（提示正文 SHA `f5eb0461…`）与 `candidate`＝当前仓库提示（正文 `620ef476…`，文件 `d93ca1d6…`），两臂仅差既有 6 行转述支持单叶。
- 两个窗口输入 SHA：`6f873ef4…`（W1）、`0b1549bd…`（W2），均为已登记匿名 C4 合成材料，正文留在仓库外私有目录。
- 执行序与臂序按冻结表轮换（4 个位置 baseline 先、4 个 candidate 先，每窗口 2/2）；阶段 1（8 次）全过后才开放阶段 2（8 次）。

## 最终结果

| 指标（每臂 8 个位置） | baseline | candidate |
| --- | ---: | ---: |
| 不必要降级位置数（非 `supported` 或 `issues` 非空） | 0 | 0 |
| 坏 auto | 0 | 0 |
| 硬拒 | 0 | 0 |
| 结构合法返回 | 8/8 | 8/8 |
| 转述候选保持 pending | 8/8 | 8/8 |
| 14 字段保真 | 8/8 | 8/8 |

- 16 个位置**全部**返回 `verdict=supported`、`issues=[]`；证据片段数 1，原始返回中的工具名均为 `SourceVerificationOutput`。以上由我独立聚合 16 份逐位置审计复核，与工具汇总一致。
- 阶段门：阶段 1 的 G1-a（8/8 合法、0 协议失败）／G1-b（两臂坏 auto 0、硬拒 0）／G1-c（候选降级 ≤ 基线且 ≤1）全部通过；阶段 2 安全门与运行门通过。
- **主判定＝「无可观测的对照信号」**（预注册分支：两臂降级都为 0）：不得当作收益通过，不自动追加预算，默认不加。
- 运行成本：延迟中位 17.4 秒（最短 5.1／最长 98.8 秒），SDK reported tokens 合计 94,336。

## 与 2026-10-04 判败的关系

2026-10-04 的 4 次对照中，候选臂窗口 2 出现过一次 `uncertain/pragmatics`，据此判败。本轮**候选臂 8 个位置全部 `supported`，该返回没有复现**，基线臂 8 个位置同样全部 `supported`。因此现有证据只能支持一个结论：在这两个匿名窗口上，两臂都稳定通过，观察不到这处提示单叶带来的差异。它既不构成"单叶有收益"，也不能推翻旧结论——本轮分辨率仍只有 2 个材料窗口，8 个位置是同一材料的重复而非独立场景。

## 运行时偏差（必须记录）

每一次调用都出现：

```text
钉扎工具失败（InternalServerError），退回默认工具选择
```

- 机制：runner 先按冻结协议用 `tool_choice=<工具名>` 绑定并调用；端点返回 500，异常被冻结 runner 内既有的回退分支捕获，改用默认工具选择重试并成功。该分支在两个版本的 runner 中都存在（v1 同样如此），不是运行中更改协议。
- 后果一：16 个位置实际执行的是"schema 可用但未强制具名工具"，与冻结文本描述的"强制具名工具"不完全等价；两臂受到同样影响，因此 A/B 对照仍是同条件比较。
- 后果二：模型在未强制的情况下仍一致选择了正确的具名工具 `SourceVerificationOutput`，故 verdict 结果本身可用。
- 后果三：回退分支在 `invoke` 抛错时重试，**失败的那次请求可能已经到达服务端**；真实 HTTP 次数可能大于 16，台账只记录成功返回的 16 次，SDK 内部重试次数不可观察。本轮因此不能作为"服务端调用次数"的精确证据。
- 生产核验适配器（`verification_adapters.py`）使用同样的具名 `tool_choice`，但它没有这层回退；因此本轮结果**不能**直接外推为生产路径的等价物。

## 结论与状态

- 按预注册判定：**验证完成、无可观测收益**。本轮不改产品提示、不回滚、不追加预算、不宣称提升。
- 任务 01 的整体目标（必需主张完整保留）**没有因此改变**：真实聊天严格覆盖仍是 6/12、可选 2/6；本轮不含提取（E）调用，无法改变覆盖。
- 是否继续投入、以及是否换用更高分辨率的材料（更多独立窗口），由用户另行决定；默认不加预算。

## 隐私与数据处理

只发送两个已冻结匿名窗口的公开输入；原始返回、逐位置审计、预算预约与关闭收据保存在仓库外私有目录 `~/.notalone/audits/memory-claim-retention-repetition-20261005/`（目录 0700、文件 0600），未进入 Git。未读取真实聊天、留出材料或业务库，未写业务记忆与水位，未使用 DeepSeek 官方 key 或端点。

## 验证记录

```bash
# 冻结一致性与 dry-run（运行前）
python .scratch/memory-core-claim-retention/product-prompt-comparison-v2/prepare_comparison_v2.py --check
python .scratch/memory-core-claim-retention/product-prompt-comparison-v2/run_comparison_v2.py --dry-run

# 唯一一次真实运行（16 次调用，阶段 1 判败即停）
python .scratch/memory-core-claim-retention/product-prompt-comparison-v2/run_comparison_v2.py

# 独立聚合复核：16 份逐位置审计
#   两臂各 8 个位置全部 verdict=supported 且 issues=[]；坏 auto／硬拒／降级均为 0
```

产物：`summary-v2.json`、`phase1-gates-v2.json`、`phase2-gates-v2.json`、`close-v2.json`、`p01..p16-*-V-response.json`、`p01..p16-*-audit.json`（均在私有目录）。
