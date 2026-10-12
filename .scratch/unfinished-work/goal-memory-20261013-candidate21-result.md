# 独立候选实际终态：审核晚到停止（2026-10-13）

[预注册](goal-memory-20261013-candidate21-plan.md)唯一run `02e6662f-ce11-4d28-be10-b66b1ef30e13`已实际运行并关闭，Conda `NotAlone`、当前公开21窗／原Gold、ECNU `ecnu-max`、SDK及双HTTPX `300/0`不变。driver单调时钟 **1148.226572292秒**（19分08.227秒），CLI **exit1**；持久SQLite真实预约 **10/42**，**10个真实HTTP200**，没有本run供应商超时或重试。服务实际报告`deepseek-v4-flash`另列，不能证明调高读限已因果修复供应商。正式 **4completed／1unknown（A05）／16unrun**，计划／质量均false，关闭余32永久不复用，另12永久退役不注册，全量280／预留9未启。

停止发生在A05的full审核等待：`full.view.json`mtime为04:28:44.417490，300秒观察后，`completion.json`在04:33:44.668627完成；我的`full.review.json`直到04:34:05.807743才写出。view→review的文件时间差 **321.390252708秒**，review比closed文件晚 **21.139116125秒**。这两个差值是文件mtime证据，不能冒作原monotonic phase timer；原持久停止码为`ecnu_hard_stop`，细分异常码没有保存。结合固定守卫、末尾仅A05 raw封存事件及来源无漂移，可定位为full审核300秒内未到，而不是供应商／SDK／序列化失败。是主审核处理晚到，不能让晚到helper改变终态、重开run或补发。

53个持久事件中有4份完整正式审核，末尾A05只到raw封存，无其full／final／decision事件。正式前4窗必需命题5，raw **5/5**、程序accepted **5/5**、完整 **0/5**；16未运行和A05未知保留完整21窗／28必需命题的原分母，不把5/5写成整套通过。正式E共56字段，46pass／10fail，V共16字段，12pass／4fail，V语义2pass／2fail；false_fact、wrong_person、bad_auto、ambiguous_auto、unmapped_auto与review_unresolved均0，但只有4份正式audit，不能据此签全套安全。原matcher5个model结果3pass／2general，与正式4份均general_error及未知状态分开。

| 窗口 | 正式raw／accepted／完整 | 实际观察 |
| --- | --- | --- |
| A01 | 2／2／0（分母2） | 未知备选已只说明身份未定；正文添加无据“纠正说”、分类common_fact、correction/asserted和“此前更正”理由错误，5个E字段fail；V supported／空issues漏检。独立mac事后E-only核与正式raw一致，非盲审。 |
| A02 | 1／1／0（分母1） | 老李的上下文0＋target1引用已补齐，relationship_note/report/reported符合转述分支；仍混用未来周末两日期，另加无敏感依据的“见面”风险，3个E字段fail；V漏检时间分支。 |
| A03 | 1／1／0（分母1） | E14、V4／语义、variant、来源、时间、lineage和理想pending全部pass，未知人物与借款风险忠实保留；raw封存safety=ambiguous触发冻结评分器safe-only完整门。独立ocr核实同一边界：枚举未说明输入未知与输出安全含义，尚不能称实现遗漏或代码bug。当前0保持。 |
| A04 | 1／1／0（分母1） | 恢复“先”、relationship_note/request/asserted和来源观察时间，不再长期taboo；正文缺原判据要求的来源日期且未知事项alternatives为空，2个E字段fail；V可见临时请求与时间字段有据，但不认证其不可见备选或救E完整评分。 |
| A05 | unknown，不计正式覆盖 | 模型E/V都成功，raw14字段pass并已封存；late full helper事后E/V／lineage／理想auto对应Gold，但该文件在closed后才生成，局部helper计1不得算正式第五窗或有效21窗控制。生产默认维度空表未放行，无业务写库。 |

仅原前5窗能作历史对照，A05正式对照结果未知，后16仍无旧控制或候选结果。不声称完整21控制、全配对改善率或提示语义过关。A03先保留“忠实保留未知但安全标签未给full”，下一步应前瞻澄清审核标签定义，并以未知／正确pending正例及错误人物／auto负例校准；当前原sealed raw/full、Gold、源码和safe-only门均不改，离线副本单改标签的计数不得救本轮分。

新桥严格`_json_value`在本次真实关闭后成功保存`run-result.json`与`run-summary.json`，原UUID／datetime TypeError未再发生；这只验证验收工具修复。源码60项仍与`c370959b`冻结一致，SDK client/budget记录没有cleanup、records或receipt错误，`capture_gaps=[]`；本机评测入口已exit1，已核自己的in-flight flock释放和SQLiteclosed marker，0700目录／0600文件保持，证据未删除，不认证远端模型进程状态。App／UI／业务数据库操作0，根`.env`未回显或提交，只有公开合成资料。

证据根 `/private/tmp/notalone-memory-goal-20261013-ac04d687/`：`candidate21/{run-result,run-summary,completion}.json`、`candidate21-terminal-derived.json`、`candidate21-reviews/`十个view及十个review（末份late明确排除）、`root-candidate21-{preflight,activation}.json`。收据SHA `bac7d380bdb6934319442e008429b2b0b635ef2d878aad066427aa8be776581b`，summary文件SHA `0e51b6431b823b937efcf5bd91fe418b424e1c1a0cacd55156855ccdd71ea932`，result文件SHA `afdf79a8d40aa5d9ba7258c881b93203c2ddc95f3d53fd974f88346c329094d1`。派生终态明确不是替代原摘要。A03纯函数诊断另存`candidate21-A03-full-count-diagnosis.json`；首次诊断的immutability字段自比较不能证明未改，保留该记录并由`candidate21-A03-full-count-diagnosis-integrity.json`补前后真实字节及已封存规范摘要核，全部新增HTTP0。

本目标七个新run全部closed，累计真实HTTP预约／尝试 **34**，收到 **30个200**，原4次read_timeout远端是否完成未知。六个有原driver单调计时的stage合计1748.571773959秒；第三基线另有文件mtime跨度642.991830958秒、缺原driver时长，不能混合冒称全为单调时钟。原07、核心事实与逐维放行仍未完成：没有有效全21当前基线、完整候选或140窗回归，B01/B02本run未运行，四typed维度字段仍缺且默认表为空。代码回归与本次局部模型证据不能替代这些验收。
