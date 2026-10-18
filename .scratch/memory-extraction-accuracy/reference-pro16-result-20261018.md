# 任务07首次Pro16实际验收：未达标

原16窗未完成：A01–A14独立审核得到safe8、一般错误6；A15未知、A16未运行。已审部分假事实0、错人0、bad_auto0，不能外推未审窗口。原18必需＋1可选分母保持，必需raw15/18、接受13/18、完整7/18；任务继续claimed，不进行生产放行。

## 冻结与关闭

- 实现提交`542398af`，独立分支`codex/memory-reference-pro16`；[计划](reference-pro16-plan-20261018.md)。86份源文件、原Gold、版本和时间窗冻结。
- 正式执行run `1790f7dc-e4c1-4341-8047-9faf48daad4a`，冻结SHA `247df03f8810567b8c2be2d94b3f033632535bd0950a06e03b43ef89129aaf45`。
- 封闭profile `deepseek-pro-reference16-v1`：E2＋legacy-v4，E/V均Pro、disabled/none、显式8192、named forced tool；零重试、上限32。原Gold canonical SHA `823d680bfa9e4c62024e570de0dddd2eb06e27d6fe05ba757e88e6dfb08f2635`，不登记D8。
- 预算closed28/32：E15次、V13次，28个HTTP200；14窗的28份RAW/FULL审核回执与HTTP次数是不同指标。169事件，worker_gone=true，close_unknown=false，无cleanup/records/receipt错误。
- A15第28次V响应为844字节，因`redaction_unavailable`仅存摘要，触发`deepseek_hard_stop`。capture_gaps=1，摘要`94c905e6f90efff8ae8534dca2b02b3b41ee849f673fc45ac573f66a811ce453`；不能推断未保存响应的具体内容、格式错误或语义。该窗没有RAW视图和审核回执，不补签、不重开。
- 运行耗时508.453秒。仅27份完整响应可统计usage：输入82645、输出3272，命中64896／未命中17749；不将这些数字冒充28次总用量。
- 凭据仅在既有授权范围提取指定键，使用本场0600单键JSON，闭账并确认worker退出后已删除。未读业务库、真实联系人、微信或截图，未发送消息。

准备过程另记：首run `2d90b613-bef7-4d6f-b3c8-d37b86394c26`误将.env路径传给严格JSON读取器，正式closed0/32、16unrun；v2 run `6022d8a3-e75d-4fa9-a9e7-993736609f49`只prepared，引用已删除旧文件，未激活、未创建预算。两者均不计模型质量，不覆盖旧记录。

## 原Gold独立审核

Agent逐窗先封存RAW十四字段，再读取FULL核验V四字段和最终去向。一般错误继续，安全错误／未知停止；没有用V supported或旧matcher代替判断。独审者已见历史Gold和旧结果，不声称首次盲标。

| 窗口 | 结论 | 必需raw／接受／完整 | 证据与缺口 |
|---|---|---|---|
| A01 | 一般错误 | 2／0／0 | 否定第三人误标correction/asserted；V另误拒正确采购部项 |
| A02 | safe | 1／1／1 | 收到邀请、来源与去向正确 |
| A03 | 一般错误 | 1／1／0 | 应report/reported，实际assertion/asserted；V漏检 |
| A04 | safe | 1／1／1 | 未知事项与暂时请求保留，pending |
| A05 | 一般错误 | 1／1／0 | 关系经历、物品归属未知与pending正确；固定程序理由未解释具体依据 |
| A06 | safe | 2／2／2 | 已到机场与正在等行李分别保留历史／瞬时边界 |
| A07 | 一般错误 | 1／1／0 | E与周末政策边界正确；V误判uncertain/time |
| A08 | safe | 1／1／1 | 书名和读完按同一必需主张计，未增分母 |
| A09 | 一般错误 | 1／1／0 | 第三人误作common_fact/assertion/asserted，V漏检 |
| A10 | 一般错误 | 2／2／0 | 两项应relationship_note，实际common_fact；否定、双方向、风险保留，V漏检 |
| A11 | safe | 1／1／1 | 健康近况与未知结束正确，pending |
| A12 | safe none | 0／0／0 | 问句未制造经历，窗口保留 |
| A13 | safe | 1／1／1 | 门票结果与数量保留，不补购买者 |
| A14 | safe none | 0／0／0 | 按已确认纳入规则排除一次性发地址，窗口保留 |
| A15 | unknown | 未审 | V响应无法完整留存，必需1＋可选1保留 |
| A16 | unrun | 未审 | 必需2保留 |

原matcher另报false_facts7、general_errors3、passed7；这些是旧规则结果，与独立语义审计分开，不称7条现实造假，也不能用独审已审安全0消除未知窗口。

## 下一步依据

独立只读诊断确认：E2已有类型原则，但局部教学没有完整编译标签映射；否定不等于更正，明确本人接收也不能一概转述化。V已包含日期与转述规则，实际仍误拒／漏检，不能仅归因为缺少规则。A05固定理由在具体未知说明生成前写入，未解释其后新增的物品归属未决。缺失的A15响应不作为修复样例。

先选择单项可证伪的封闭reference教学或V干预，保持原Gold、原分母和全部失败记录；程序理由如另改，必须基于原句与现有解释，不从Gold硬编码角色或现实事实。D8历史bad_auto和reason_rule缺口继续保留，不能用本场已审安全0注销。

工程验证：入口实现阶段860项提取单测通过；随后末条unknown误complete修复后21项专用检查通过，最终计划纳入冻结后6项集成／fixture检查通过；Standards与Spec独立复核0剩余。这些证明接线与停机行为，不替代本场失败的质量门。
