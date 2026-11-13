# 单V省略一键的真实响应与别名停止

按[固定cap1计划](goal-memory-nullable-V-tool-choice-probe-plan-20261013.md)只运行一次V，未运行E。实际HTTP200，但响应报告`deepseek-flash`，与该场预登记的`deepseek-v4-flash`不同，身份护栏在HTTP观察层停止。工具输出及proof没有进入正式审核。之后用户[明确接受deepseek-flash并重申只用给定ECNU配置](goal-ecnu-model-authorization-20261014.md)，后续据此继续；原闭账结果保留。

| 项目 | 实际结果 |
| --- | --- |
| 唯一run | `5e292cb1-6a33-434f-a245-9bd1b553b6ef` |
| 固定窗口 | 台北10-13 23:45至10-14 00:45；最后起发严格早于00:28:35；未顺延 |
| 实际执行 | 10-13 23:56:51.761508至23:57:32.489415，40.72790824999902秒 |
| HTTP与闭账 | 请求`ecnu-max`，HTTP200；CLOSED1/1，无剩余额度，300秒／重试0 |
| 停止 | `EvaluationBudgetAbort`；事后禁网络重构准确复现`probe_reported_model_alias_changed` |
| 正式结果 | `technical_complete=false`、`quality_certified=false`、formal raw/full审核0；audit目录为空 |
| 记录与清理 | 五event、capture gaps空、内部思考原文移除；入口exit0仅表终态保存，cleanup错误空，记录PID gone、预算锁无持有 |

完成体的`http_status=null`是响应观察护栏在`client.post`返回前抛出所致；第三event已经封存实际provider_response200，不能记为网络状态未知或新500。

机器核对实际规范请求的唯一变化为省略顶层`tool_choice`，由原SHA`49097d09f024d4b18bcb5166552eb5aede37f4c517b7c81cf080fd0145df172c`变为`938eb1f823734c166ef820224cfd925f2222385d48f240bca78c64ec15a1d235`。SYSTEM、user、候选、来源、schema、模型请求名及其他参数保持。200表明这次省略键的请求得到成功响应；响应别名不同，没有受控稳定身份对照，不能把结果推为省略键导致服务修复、两标签权重相同或模型质量达标。

安全封存的工具为`SourceVerificationOutput`，单个结果为candidate_index0、supported、issues空、原公开句子的逐字证据、proof=null。Root事后禁DNS/HTTP重构通过完成体和严格V4／nullable DTO／来源边界检查，proof仍UNKNOWN，auto=false。该非盲性诊断不补正式审核、不代签新证明有效关系或原三张质量票，旧A05产权UNKNOWN和Gold要求之间的差别仍保留。

本目标现有**13个关闭阶段、64次实际HTTP预约**，确认200为58、确认500为2、旧ReadTimeout远端未知4。关闭未用183、未登记退役56、全140未启280分别保留，工程分配`583=64+183+56+280`；目标开始前P1另账不并入。根`.env`在本场领取预算、预约0之后读取既有ECNU三键一次；恢复窗口累计两次实际读取，无秘密回显或持久，无真实聊天上传。

执行前源码与控制两轴阻断0（少量护栏复制建议1），Root禁网络18项测试全部通过、0.9815330410019669秒；真实Mock传输与实际供应商计数分开。最后299来源、278提交blob、8实际版本及12旧目标账＋1目标前另账全部核对；全部299字节及HEAD在运行前后不变。预登记仅一文档提交`758c6688`，完整公开历史6133 blobs／1113 commits／1759 current／issues0；结果与连续记录此前分别提交`b4d05da7`、`c6b1aea8`。

Root最后准备清单曾误纳入非执行`.log`，严格源码后缀门在预算创建前拒绝，登记／密钥／HTTP0。该空准备目录及原失败回执保留；日志作为测试证据单独核摘要，执行来源限制没有放宽，固定窗口未改变。原18项工具红绿及其他预检格式错误也留在私有证据，不写成产品故障或真实模型尝试。

端侧证据为被忽略的`desktop/artifacts/goal-nullable-V-tool-choice-probe-real-20261013-5e292cb1/`及prepare目录，0700/0600。activation plan SHA`f707a41eac58249acdae7c66ff08e01625c21d26baff2fff2b6442add982c6cc`；Root独立终态保存精确账、清理和禁网络来源诊断。未提交密钥、真实联系人、聊天、原帧或内部思考原文。

07的完整指代质量／既有全量、核心01原六窗及留出、03有效维度依据与达标后逐类批准均未代签；原AC／State、原输入和Gold、业务迁移0／旧回填0／默认空表保持。下一先实现必要的评估侧省略V键接线及已确认ECNU路由策略，通过相关最小验证与两轴后再单独固定有限新计划；不续跑本1/1，也不激活原全140。现场仍暂缓，App612、发送8/12、来信0保持。
