# 核心事实依赖保留：Agent 快速工程验收

2026-10-18，基线 `5b4153b7`，实现提交 `d159417d`。本轮按用户持续授权完成独立工作树内的实际修复、Agent 验收与本地提交；不等待人工复核，`reviewer_kind=agent`。这改变的是验收执行者，不降低假事实、错人或错误 auto 门，也不把旧不完整模型批次补签通过。

## 最新证据与复现

旧自由 E14 的核心扩写不当作当前生产红。当前生产已采用原文分句 E2；[B01 原单窗](../grounded-evaluation/remaining-public8-result-20261016.md)必需 raw/接受/完整各 3/3、bad auto 0 可复用；同场 B02 只有 E 返回，V 远端未知且旧预算关闭，仍不可报告完整通过。

本轮在当前 `compile_labels` 重现新程序缺口：合成原文“前年冬天，我表弟在书店做收银。”的 prefix 和 reported_event 已显式合并，后继“这段经历是他自己告诉我的。”依赖事实分句时，引用只保留“我表弟在书店做收银”，丢失历史前件。首个永久回归在修改前真实失败；修复后通过。原模型标签没有改，错误发生于 V 之前的编译，排除了 V 拒收和后处理裁剪。

修复只在 E2 内将显式 prefix/condition 与相邻事实形成的组合用于依赖遍历，引用其中任一成员保留整个组合和其外部依赖。普通邻接内容不增加来源；原文、否定、条件、作者及来源 ID 保留，8 个依赖成员的路径预算和外部环拒绝仍有效。原 draft/v3/v4 路径保持旧投影。无需提示、schema、依赖库或模型调用数变化。

并行指代会话另复现“前件 unresolved=true，后继依赖却无 alternatives”的错误。共享编译器由本会话唯一修改：E2 后继保留独立说明“所依赖原文仍有未决指代，当前候选不能据此消歧。”，不声称后句主语本身未知，不新增人物解释、来源证明或自动采纳权限。该会话的独立测试及完整交付另计。

## 三层回放与正例损失

冻结一个合成窗口、两项必需主张（历史第三人经历及该经历的转述来源）。模型标签为给定输入，V 为预设 supported、返回逐字来源的合成控制；没有新真实模型调用。raw 在此指 V 前的编译候选，模型原始标签本身不是正文；raw/接受统计两项核心陈述是否出现，完整契约另要求必要历史前件、report/reported、双 null 时间、来源和 pending 去向均保留，并核对两候选数量及其余原字段。此分层避免把核心句出现算作完整历史保真。

| 同一给定标签回放 | 必需 raw | 必需接受 | 必需完整契约 | 完整正例损失 | bad auto |
| --- | --- | --- | --- | --- | --- |
| 基线 | 2/2 | 2/2 | 1/2 | 1 | 0 |
| 修复后 | 2/2 | 2/2 | 2/2 | 0 | 0 |

额外候选 0，可选机会分母 0；不能由此推断可选召回率。这里的正例损失指必要限定在编译中丢失，非 V 误拒；raw/接受损失均 0。来源事实由 Agent 对合成原文独立核对，没有假事或错人；bad auto 单独为 0，不能把它替代覆盖。首版统计仅显式计入正文、语用与时间，不能直接称全字段审计。复核将两臂的给定主题显式固定为 family（原测试 helper 缺省 other），补齐所有字段、来源、去向及候选数量断言后重新比较，数值不变；首版脚本及结果另存，不覆盖。此数值只认证确定性编译回归，不是模型准确率、原私有六窗或新留出成绩。

## 验证与独立审查

unittest 使用仓库指定 Conda Python 与当前工作树 `PYTHONPATH=src`，从 `backend/` 执行；mypy、Git 与公开检查从仓库根执行：

- `python -m unittest tests.unit.memory_extraction.test_core_dependency_retention tests.unit.memory_extraction.test_grounded_extraction tests.unit.memory_extraction.test_e2_field_semantics -v`：首红后 56 项通过。
- `python -m unittest tests.unit.memory_extraction.test_core_dependency_retention tests.unit.memory_extraction.test_grounded_runtime tests.unit.memory_extraction.test_grounded_v3 tests.unit.memory_extraction.test_grounded_v4 tests.unit.memory_extraction.test_e2_calendar_followup tests.unit.memory_extraction.test_bounded_negative_reference_notes -v`：78 项通过，含 Flow 回归；与上组有重叠，不相加宣称独立样本。
- 独立 Spec Agent 提供传递否定及 8/10 成员预算反例，3 项通过；纳入永久回归后单模块 7 项通过。
- 指代会话在自身测试树、指向本工作树源码执行其 4 个测试方法通过，含 16 个窗口控制、跨消息及同消息传递和负控；其原 11 个失败转绿。
- `python -m mypy --follow-imports=silent backend/src/notalone/memory_extraction/grounded.py` 仍报告原有事件索引 `str | None` 问题（第 213 行）；基线源码单独核验也复现。新增的局部变量类型冲突已修复，不把整体 mypy 报为通过。
- `git diff --check` 通过。提交后 `node scripts/check_public_history.mjs --ref main --working-tree` 报 12 个既有工程说明的本机路径命中，涉及历史及当前 `docs/agents/engineering.md`；本轮修改文件无命中。未修改历史或无关规范文件。

Standards：硬违规 0；非阻塞建议 1（相邻分句判断存在重复，未扩大重构）。Spec：本轮实现缺陷、超范围 0；明确整体固定集/留出门仍未覆盖。两轴均为独立 Agent，非人工验收。

## 状态、数据影响与剩余范围

工程修复已交运行时集成会话，生产源码冻结；运行时与指代会话各自独立冻结新官方合成场次。本轮只处理合成原文与已封公开证据，未读新真实联系人、未运行真实 App/微信、未迁移或写业务库、未改水位、未发送外部消息、无远端 Git；无桌面行为变更，桌面交互不能验证这个纯编译缺口。未生成 App/运行时构建目录；核对 Git 未跟踪和无存活 mypy 进程后清除本轮类型缓存，7.7 MiB→0。

生产放行表保持空；`proof`/`evidence` 合同由运行时会话独占，本轮未修改。原票继续 `claimed`：替代验收要求的原新六窗同期比较及四个独立留出未在本轮覆盖，旧 6/12、2/6 和所有关闭预算保持，不因工程修复或 Agent 回归通过而结清整体质量验收。
