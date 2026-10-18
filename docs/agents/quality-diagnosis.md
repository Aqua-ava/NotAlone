# 小批诊断与累计预算

适用于记忆提取、L2/L3 整理和回复质量实验；不改变生产门禁或正式质量资格。

## 先确定真实问题

- 在用户指定的单一联系人范围内，先只读 5～10 段已有原文与对应结果，由 Agent 标出具体错误。不得默认跨联系人搜索；联系人名称必须解析到唯一的 owner/contact 身份。
- 真实资料只保存在仓库外私有目录，不进入单元测试、Git 或公共报告。外部模型调用须有明确的数据范围和供应商授权；本机诊断本身不需要外发。
- 原文不插入说明。时间、说话人、来源 ID 单独记录；保存原文和实际模型输入的摘要及差异。合成异常测试单列，不能代替真实使用质量结论。
- 首轮没有观察到错误时报告“本批未发现”，不为获得失败而增加说明或改变原文。

## 每轮只验证一个假设

开始前记录问题 ID、具体失败、唯一改动、预期信号、原失败与正确对照、来源和版本。先定点复现，修复后检查原失败及正确对照，再用未参与调整的样例验收。只有原目标改善且对照不退化才记为 improved；仅运行成功、结构合规或错误定位更细不算质量改善。

复用现有单轮物理预算，额外绑定问题级总账。同一问题的不同 prompt、模型、目录和 run 必须共用一个账本，不得重建重置。账本放仓库外 0700 私有目录，文件为 0600，不存聊天、凭据或联系人姓名。旧实验次数另列，未知不填零；新账本必须注明统计起点，不能冒充历史总数。

以下命令在 backend 下使用工程工作流指定的 Python；`$DIAG_LEDGER` 是本问题固定绝对路径：

```sh
python -m notalone.experiments.problem_budget --ledger "$DIAG_LEDGER" create --problem memory-quality-followup --calls 8 --minutes 30
python -m notalone.experiments.problem_budget --ledger "$DIAG_LEDGER" start --round r1 --hypothesis '原失败由指定字段转换导致；只修该转换应恢复原失败且不伤正确对照'
export NOTALONE_PROBLEM_BUDGET="$DIAG_LEDGER"
export NOTALONE_PROBLEM_ROUND=r1
# 运行已有的有限评测入口；仍须使用其单轮预算、授权和来源约束。
python -m notalone.experiments.problem_budget --ledger "$DIAG_LEDGER" finish --round r1 --outcome unchanged --evidence /private/diagnosis/r1-review.md
python -m notalone.experiments.problem_budget --ledger "$DIAG_LEDGER" status
```

默认小批外部实验上限 8 次请求预留、30 分钟；用户明确另定则在开始前记录。时间从 create 起计，准备数据应在之前完成。截止时间阻止后续发送，不中断在途请求，仍需底层请求超时。请求发送前持久计数，失败、未知响应及预留后异常不退款；它是保守的预留数，不能冒充实际 HTTP 数或账单金额。

`EvaluationBudget.attempt` 与 `PersistentSuiteBudget.reserve` 已接入总账。外部整理诊断必须配置 `PersistentSuiteBudget`；无 suite 的旧 transport 分支不会经过此总账，仅 export 不足以覆盖它。两个变量同时缺省时，历史工具保留原合同，因此它不是全局网络防火墙：本工作流禁止未绑定总账的外部实验；其他发送路径必须先接入，不能用临时 SDK 调用绕过。一次物理发送只选择一个总账入口，避免叠加计数。离线单元测试不消耗真实问题账本。

## 停止与结案

- 累计请求额度用完、时间到期、连续两轮无改善时，工具拒绝继续预留。unknown 和 regressed 都计入无改善；未结案轮次阻止开启下一轮。
- 达到停止条件后保存证据、解释原因和提出替代路径，不再自动加预算或新建问题编号。需要改变已约定预算或修复方向时，提出具体取舍；不能仅申请“再跑一轮”。
- 每轮由独立 Agent 判断结果，不要求用户逐例验收；需要产品取舍时才询问用户。Agent 审阅不得登记成人工审阅，也不替代原 spec 尚未修改的正式资格条件。
- 汇报分别列出工程完成、目标质量是否改善、是否可启用，以及已用/剩余预算、未解决的真实失败。验收通过的单点及时提交，剩余失败如实保留；不以测试数量或审计完整代替质量。
