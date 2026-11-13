# 证据 04a：R3 合成探针（5 真两读 + 5 细节没说）

日期：2026-11-06。依据 `.scratch/memory-auto-adoption-alignment/followup.md` 第 4 节。真实库只读备份、仓库外私有隔离副本；副本内真实联系人读取授权全部撤销、可进入模型提示的真实记忆与候选清空，仅保留全合成账号/联系人/10 个合成窗口。所有外发经问题账本（probe round），由 DSH host 进程 OS env 绑定，发送前预留。

## 1. 探针数据（全合成，无真实人名/聊天）

- 1 位合成联系人、10 个合成窗口、共 31 条合成消息，作为同一历史批（≤50 目标）走产品自动调度入口建轮。
- 真两读 T1–T5：T1 数字口径（房租/工资）、T2 数字口径（年终奖/手机价）、T3 对象省略（项目奖金/兼职收入，含「想多赚点」）、T4 数字口径（工资/房贷）、T5 指代身份（哥/朋友，含「先给他了」）。
- 细节没说 D1–D5：只缺动作对象/范围/原因，可合并相邻句补全（如「先了解下」「要去趟医院复查」「不会再去」「还没想好」「到时候再说」）。

## 2. 结果（候选计数按 `candidate_raw` 原始候选，逐窗口）

| 窗口 | 类型 | 原始候选 | alternatives 非空 | 解析 | 核验 verdict |
| --- | --- | --- | --- | --- | --- |
| T1 | 真两读 | 1 | 是 | accepted | unsupported_rejected（meaning） |
| T2 | 真两读 | 1 | 是 | accepted | unverified_rejected（subject） |
| T3 | 真两读 | 1 | 否 | accepted | continue |
| T4 | 真两读 | 1 | 是 | accepted | continue |
| T5 | 真两读 | 1 | 否 | accepted | continue |
| D1 | 细节没说 | 1 | 否 | accepted | unverified_rejected（subject） |
| D2 | 细节没说 | 1 | 否 | accepted | continue |
| D3 | 细节没说 | 1 | 否 | accepted | continue |
| D4 | 细节没说 | 1 | 否 | accepted | continue |
| D5 | 细节没说 | 1 | 否 | accepted | continue |

计数：真两读 `alternatives` 非空 **3/5**（T3、T5 为空），细节没说 `alternatives` 空 **5/5**。方向性通过标准为「真两读 ≥4/5 且细节没说 ≥4/5」，本轮真两读未达线。

补充口径：按「进入候选」（`memory_candidate` 行，7 条）统计，`alternatives` 非空为 **1/7**——T1、T2 的双读在原始候选里已填写，但分别被核验以 `meaning`、`subject` 拒；只有 T4 进入候选且保留非空。

## 3. 候选/核验/拒绝计数（与任务 A 三层口径对齐）

| 指标 | 本轮 |
| --- | --- |
| `candidate_raw` | 10 |
| 进入候选（`memory_candidate` 行） | 7（contact 7；self 0） |
| 解析结构拒绝 | 0 |
| 核验拒绝（`verification` 事件拒绝） | 3（`unverified_rejected` 2、`unsupported_rejected` 1） |
| 总拒绝（`stage_result.rejected` 求和） | 3 |
| 其中 issues `subject` / `meaning` | 2 / 1 |
| 合并候选（来源消息 ≥2）/ 单句 | 10 / 0 |
| `low_value_dropped` | 0 |

## 4. 外发与账本

| 项 | 计数 |
| --- | --- |
| 账本 used（round r1） | 15 |
| 物理发送（`model_call` 行，含失败 1） | 15（成功 14、失败 1） |
| 调用构成 | extraction 2、verification 2、adjudication 5 成功 +1 失败、relation_verification 5 |
| DS H host OS env 绑定 | 已核验（`NOTALONE_PROBLEM_BUDGET`/`NOTALONE_PROBLEM_ROUND` 均在 DSH host 进程环境） |
| 策略指纹 | 探针 run 的 `policy_config.source_stamp` 与当前提示源码指纹一致 |

- 探针原计划 12 次额度；产品真实路径在提取/核验之后自动进入采纳/关系核验阶段，第二批外发在停止过程中继续预留，最终 used=15（未超用户授权的 32 次总量，但超出探针 12 次分项 3 次）。已在发现后立即停止后端；剩余总量 17 次留作同窗口重测。
- 判定：探针轮 `outcome=unknown`（执行者不自行判定 improved；方向性标准一条未达线，交独立 Agent 判定）。
