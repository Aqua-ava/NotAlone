# 隔离逐字段V的四调用结果

本轮[方案](reference-field-diagnostic-plan-20261018.md)执行完成：原V与逐字段V均未将预设3个错误候选判为supported，均未误拒2个正确候选。新V能分别定位日期、类别及言语行为；本小样本没有证明准确率提升，不支持据此替换生产V或宣称原16窗问题解决。

## 冻结与实际执行

- 源码 `14b53c84`；实现提交 `9428709c`，前置诊断 `8982198c`。
- run `78f1064a-842f-4409-850c-42b70d3ba31b`；freeze `a3d9baf673dcc23e276f50b67a0d5ebfc836907936a55c950ea721e298658b17`。
- 私有runner摘要 `680d67f0a3ad817c883d28c0502ac8e90fefe8763b736703e16ab16a8a60dc7d`；371份源码／controls、7包版本冻结。
- W1原V→新V、W3原V→新V；同一窗口消息、候选及摘要完全相同，只改变输出合同及对应包装。原V完整retention语义提示保留为新V前缀，评分预期不发送模型。
- 同为官方Pro、thinking enabled／reasoning max、max_tokens 32768、request 300秒／call 600秒／全程2500秒上限；预算4次，零重试、无E调用。
- 实际closed 4/4，4次HTTP200，均finish_reason=tool_calls。stop、receipt_error及清理错误均为空；worker及进程组已消失，专用临时密钥已删除。没有追加调用。

## 可比较结果

| 输入及预设错误 | 原V实际判断 | 新V实际字段判断 |
|---|---|---|
| W1：保留未知“他”的正确明日计划 | supported／无issues | 8字段supported |
| W1：仅把计划开始日错写为观察日 | unsupported／time | time=mismatch，其余7字段supported |
| W3：已收到邀请的正确关系经历 | supported／无issues | 8字段supported |
| W3：仅把relationship_note改为common_fact | uncertain／pragmatics | category=mismatch，其余7字段supported |
| W3：仅把已完成动作的speech_act改为plan | uncertain／pragmatics | speech_act=mismatch，其余7字段supported |

旧V只能计5个可观察的候选总判断及issues，不能补记它未输出的八字段正确性。新V共40字段：37 supported、3 mismatch，与预冻结预期吻合；没有用全部uncertain换取拒绝率。程序汇总的unsupported表示字段诊断未通过，不等同旧V的unsupported政策，更不表示现实内容被证伪。

本轮输入token：旧V合计7672，新V合计12430；输出token分别26825、35002。全轮输入20102／输出61827，其中reasoning token元数据57026；不读取或保留推理正文。仅报告本轮用量，不从两个窗口估计稳定费用或性能收益。

## 结论与剩余范围

字段强制覆盖和证据绑定在这两窗可执行，也提供了更明确的错误位置；准确率收益假设尚未得到支持。可保留隔离诊断原型，不进入生产、自动采纳或原质量统计。该结果没有给出需要立即修复的新误拒／漏检，不凭成功对照继续添加提示或重抽样本。

原A07／A10／A16未重跑，原16窗仍safe13／一般3、FULL15/18，质量门未通过。W2条件、W4必要来源及W5无关上下文仅有离线预期；姓名落实项首轮排除，必须ambiguous样例仍未覆盖。A10的E分类选择与A16的E依赖选择仍是独立未解决项，不能把新V的字段定位当作E修复。任何后继应另有原失败支持的最小假设与定点验收，不自动扩预算或重跑16窗。

独立Agent最终审计零剩余问题：371源／7版本、冻结及预期摘要、4实际请求、20事件摘要、原始tool args至adapter／case_result／receipt的完整绑定一致；新40字段含44处逐字文本证据及5处时间元数据。plan_complete=true、capture gap=0，但quality_certified=false。私有运行目录保存0600的 `audit-summary.json`；结果文档另经Spec复核零阻断。
