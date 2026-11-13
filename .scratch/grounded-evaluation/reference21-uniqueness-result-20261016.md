# 原公开21窗：唯一性提示对照的实际停止结果

2026-10-16。唯一 run `0c190899-6891-4199-a9b1-f6a028b476ea` 已关闭，未完成21窗，不能签过至少15窗、核心整体或完整记忆质量验收。A15 的 E 调用未取得可审查响应，原有600秒调用墙钟守卫关闭预算并使自有 worker 退出124；没有重试或自动后继。原始产物仅留在本机私有目录。

## 实际运行与关闭

- 原计划为21窗、28个必需事实组与1个可选事实组，cap42，零SDK重试；仍用官方 DeepSeek、原输入、`source-fidelity-v2` 和冻结答案。E 使用 `grounded-v4/reference-uniqueness-v1`、thinking enabled/max、省略tool_choice；V使用 legacy-v4、thinking disabled/none、强制工具。不在运行中改提示、答案、用例或门槛。
- 冻结文件字节SHA为 `82e610a5a9211ad5fb625e1b25b291073c5753aeb2e81ec9b613b1cfa58c754d`；独立机械审核确认93/93份源及8/8版本匹配，审核前后源与证据未变。
- 实际预约28/42，剩余14永久关闭。`deadline-receipt` 为 `call_wall_deadline/closed=true`；`finish` 为 `exit_code=124/worker_gone=true/close_unknown=false/outer_timed_out=false/automatic_successor=false`，launcher正常返回。Root只读SQLite已核唯一state、closed=1、requests=28、query_only=1与closed标记；worker PID和进程组均独立返回ESRCH。
- 没有完整batch result，外层保守状态仍为 A01–A15 共15个unknown、A16–A19/B01/B02 共6个unrun；不以逐窗审核改写这些状态或补造completion收据。

## 已封存的逐窗证据

A01–A14各有独立RAW先封存、Root再核V及最终去向的审核与received收据；它们是部分证据，不等于完整批次成功。以下只列这些已实际核对的窗口。

| 窗口 | 必需完整/分母 | 本次逐窗结论 |
| --- | --- | --- |
| A01 | 2/2 | 采购/非仓管及未名第三人均保留，pending |
| A02 | 1/1 | 历史邀约原话保留，不推断接受邀约 |
| A03 | 1/1 | 未知借款人物与金融风险保留，pending |
| A04 | 1/1 | 未知事项和不外传请求保留，pending |
| A05 | 1/1 | 姐姐借车经历保留，人物/所有权未决，pending |
| A06 | 2/2 | 到达与等行李分层保留，瞬时状态按冻结时间口径 |
| A07 | 1/1 | 未知他们/家及未来计划保留，pending |
| A08 | 1/1 | 《活着》及读完保留 |
| A09 | 1/1 | 那人、昨天、又来保留，pending |
| A10 | 2/2 | 老李肯定、小王否定均保留，借款方向未决，pending |
| A11 | 1/1 | 感冒明显好转、健康风险与来源观察点保留，pending |
| A12 | 0/0 | 纯问句合法空结果，不制造共同经历 |
| A13 | 1/1 | 门票/买好/两张为同一事件，不补实际购票执行人 |
| A14 | 0/0 | **一般错误**：一次性稍后发地址被纳入pending；冻结要求none |

部分必需事实组完整15/15；A12的none正确，A14的none失败，不能把0/0写成通过。A14另有alternatives与interpretation_reason失败：地址内容未给，不等于发地址这个行动或双方角色存在另一个未知事项读法。其正文仍忠于原话，属于纳入/字段错误，没有改成已发送或补出地址。

独立重算14份已封存FULL：E/V各15行，E字段208/210通过，V可见字段60/60及可见语义15/15通过；最终理想三门auto5、pending10，其中A14为excluded候选。13窗完整符合冻结语义、1窗一般错误；这些数值只属于已签审部分。没有未决审核项，不将未知A15计作零错误。

V的supported只认证其可见候选与原话的对应，不能覆盖A14的纳入错误，也不能认证V未见的confidence、risk_flags、alternatives或interpretation_reason。旧matcher在A02/A06/A08/A13的false_fact以及A05的一般错误原样另报，不用旧字符串匹配代替本次冻结语义审核。

旧matcher为9窗pass/5窗fail，其中false_fact候选计数5（A02×1、A06×2、A08×1、A13×1），A05一般错误1；这与逐条来源语义审核是两种口径，均保留。

## 验收边界

- 指代主集只签审14/16窗，A15未知、A16未运行，至少15个窗口的门槛未达；15个必需事实组不能改算15个窗口。部分审核中的假事、错人、歧义auto等安全计数均为0，不外推到未知/未运行窗口。
- B01/B02未运行；公开核心5个必需命题、私有严格核心6/12、可选2/6及held-out均未获本场整体质量结论。没有全140例真实回归，也不以确定性测试代签模型准确率。
- 实际dimension evidence仍为source_bound=false、semantic_basis=null、version=1；typed_evaluated=false、typed_credit=false，没有verification_program，不认证运行时typed分类或逐类放行。默认放行表仍空。
- 只调用公开合成输入；未读取真实聊天、启动App/微信/OCR、写业务库、执行生产迁移或发送外部消息。旧已关闭run不重开，未用额度不借给后继。

## 独立闭场核验

独立只读核对167个连续事件及全部payload摘要：28个请求（15E/13V）、27个HTTP200响应（14E/13V），响应型号均匹配；各次E/V合同、prompt/schema及输入投影与冻结值相同。第28次A15 E只有请求，没有response/failure/adapter终结，远端结果unknown；不能以没有provider_failure事件解释为全部调用成功。

14组RAW/FULL的五项绑定、视图/审核摘要、600秒审核时限、正式事件顺序和RAW封存不变全部核对通过。registry仅以mode=ro/query_only读取，唯一state closed=1、请求序号1–28、静态manifest及closed标记匹配。worker PID/进程组ESRCH与launcher执行会话正常返回分别有证据；执行会话编号不作为OS PID。

没有result/completion，最终records/receipt/cleanup错误字段不可取得，保持unknown，不能填为空列表或签整场无清理错误。未见已持久事件的body_not_saved项，不替代第28次缺失终态。独立机械一致性不增加质量、typed或生产信用。

分层计数另经独立Spec审核重算；结果、闭场补记及三票本次更新已完成独立Standards/Spec窄审，最终未解决项均为0。仅指本次证据交付审查，不签原票整体完成。
