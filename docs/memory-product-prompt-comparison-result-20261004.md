# 产品来源核验提示匿名对照结果（2026-10-04）

状态：**未通过计划门槛，判败闭账**；预算 4/4 用完，不重试、不调参、不补跑。本文件只记录结果与限制，不把这次对照当作整体语义准确率证据。

## 对照设置

- 目的：检验已并入产品默认的“转述支持语义单叶”是否让产品来源核验提示在两个匿名 C4 窗口上更稳定。
- 两臂：`baseline` = 改动前的产品提示（从 `e015b96` 的 `verification_adapters.py` 取，SHA256 `f5eb0461…`）；`candidate` = 当前仓库提示（含单叶，SHA256 `620ef476…`）。工具 schema 与用户消息两臂完全相同（schema SHA256 `fb9a4529…`）。
- 材料：匿名 C4 的两处旋转窗口（输入 SHA `6f873ef4…`、`0b1549bd…`），正文留在仓库外私有目录，仓库内只记录路径与哈希。
- 运行：只连现有 ECNU 端点 `chat.ecnu.edu.cn`，模型 `ecnu-max`，thinking 开启，共 **4 次**公开调用（2 窗口 × 2 臂），未使用官方端点或回退，未写业务数据、未读真实聊天或留出。

## 结果（先审 raw，再编译）

| 窗口 | 臂 | verdict | issues | 编译后风险 | 去向 |
|---|---|---|---|---|---|
| 1 | baseline | supported | [] | 无 | pending（report/reported） |
| 1 | candidate | supported | [] | 无 | pending（report/reported） |
| 2 | baseline | supported | [] | 无 | pending（report/reported） |
| 2 | candidate | **uncertain** | **[pragmatics]** | **semantic:pragmatics** | pending（report/reported） |

四条结果都保留了 `subject=contact`、`speech_act=report`、`assertion_status=reported`，没有出现人物方向错误，也没有任何坏自动采纳。

## 门槛判定

| 门槛 | 结果 |
|---|---|
| 两个窗口都 supported | **失败**（窗口 2 候选臂返回 uncertain/pragmatics） |
| 完整 Fact 无新增 `semantic:*` 风险 | **失败**（同上，多出 `semantic:pragmatics`） |
| 转述候选保持 pending | 通过（4/4） |
| 坏 auto 为 0 | 通过 |
| 不必要降级为 0 | **失败**（候选臂 1 次） |

## 结论与限制

- 这次对照**没有复现**试点里“候选更稳定”的结论：产品提示上，基线两窗口都 supported，候选反而在一处返回 `uncertain/pragmatics`。样本只有 2 个窗口、4 次调用，单次不确定返回足以翻转判定，因此结论是“**未通过门槛、证据不足以支持该单叶在产品提示上带来稳定性**”，不是“该单叶有害”。
- 与试点的差异需要区分清楚：试点候选是带 `described_party` 的人物变体提示、窗口轮换也不同，两者不是同一提示的对照；试点里的 `contact` 方向错误本次两臂都没有出现。
- 因此本轮**不改动产品提示**：既不因为 4 次调用回滚已提交的单叶（本地契约与试点证据仍成立），也不追加预算去“跑出”想要的结果。若日后要判定单叶去留，需要新的、预注册的对照（更多窗口与重复、两臂随机顺序、以多次返回的不确定率为主指标）。
- 收据：私有目录 `product-prompt-comparison-20261004/` 保存 preflight、4 份原始返回与 `close-v1.json`（4 次调用、预算关闭、无重试）；仓库内计划与执行脚本见 [frozen-plan-v1.json](../.scratch/memory-core-claim-retention/product-prompt-comparison-v1/frozen-plan-v1.json)、[run_comparison.py](../.scratch/memory-core-claim-retention/product-prompt-comparison-v1/run_comparison.py)。
