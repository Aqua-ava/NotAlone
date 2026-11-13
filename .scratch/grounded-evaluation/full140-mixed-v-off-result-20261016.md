# 完整140混合合同实跑：第三窗安全停止

日期：2026-10-16。run `5a6c08fa-c123-4fb7-8acd-cd2dccdd7acc` 已独立closed **6／280**、六次HTTP200、零重试。140窗中完成3窗、137窗未运行；A01 safe、R001 general_error、R002 safety_error，按 `case_semantic_audit_safety_error` 停止，剩余274次永久关闭。**本场未达质量门，没有自动后继。**

## 合同与范围

依据[固定计划](full140-mixed-v-off-plan-20261016.md)和[离线实施](full140-mixed-v-off-implementation-20261016.md)，代码基线 `4fca308e`，独立执行身份 `full140-grounded-v4-source-v2-v-off-forced`。只用原公开合成140窗及冻结顺序／映射，参考为source-fidelity-v2，完整计划分母138必需＋1可选；grounded-v4提取和nullable-proof-v1核验均显式选择。

仅官方 `https://api.deepseek.com/chat/completions`，请求及响应model均为 `deepseek-flash`。E为thinking enabled／reasoning max／省略tool_choice；V为thinking disabled／reasoning none／强制具名 `SourceVerificationOutput`。Root关闭核验逐次确认3E＋3V实际wire和六次HTTP200，未出现协议、timeout或安全响应观测降级。此小样本协议成功不证明稳定性或参数变动的因果。

freeze字节SHA `28be25143809cd43b30a34b732920d6bd4255b93116fec32dc76e47ef9e8ad8f`，89份实际来源／合同／helper在启动前及关闭后全匹配。启动前旧八场closed、新registry不存在；绑定授权后唯一启动。单调用及RAW／FULL各600秒、工作86380秒、外层86400秒的上界不变，本场提前停止；外层实际1022.230秒。没有复用旧台账、补发未知请求或改变Gold。

## 独立审核与真实质量

独立Agent只读RAW并先封存，Root在FULL中保留全部RAW判定，再审核V语义、各层对应和完整组去向。实际三份RAW、三份FULL均取得桥接收据 `received=true`；关闭后未补审。

| 窗／执行位置 | 实际结果 | 必需raw／接受／完整 | 核心差异 |
| --- | --- | --- | --- |
| A01／0 | safe | 2／2／2 | 未知第三人的否定仓管及采购部门合并保留，非空歧义解释、最终pending；没有指认具体人 |
| R001／1 | general_error | 0／0／0 | 冻结none的机构入口闲聊仍产生两条；机构事件误用relationship_note。V额外误判语用，并错误拒绝忠实的未来试用计划；最终为空不能使整条链路正确 |
| R002／2 | safety_error | 2／2／0 | 用户大三身份与土木专业正文保留，但两条state编译为recent_state，valid_at取来源观察日；冻结分支要求common_fact／双null。V supported／空issues漏检这两类可见字段偏差，final为两条auto |

只对这三份实际封存材料汇总：必需raw4／接受4／完整2，E字段65／70、V字段13／20、V整条语义1／5，审核未决0、各层未映射0。未运行的137窗无任何通过信用，不与旧场拼成完整140或至少15窗。

R002的两条是 **bad_auto=2**：E字段fail且实际进入评测auto。人工审核的新增假事、错人和歧义auto均为0；原结果维度汇总中的 `false_facts=2` 是停止聚合口径，不能转述为两条现实假事。两个单候选组的destination分别符合参考auto，仍不抵消category／valid_at错误；这与旧A13的整组混合去向问题不同。

实际五条V程序结果均为proof null、`UNKNOWN/untrusted_source`；最终一条pending、两条评测auto，`source_bound=false`、semantic_basis为空。没有typed依据或逐维度放行信用，评测auto不构成产品采纳；产品默认空放行表、业务数据及原票AC保持。

## 关闭、验证与剩余工作

Root已在任何后继源码改动前逐项核验：89源及freeze字节，39份事件与result副本逐项一致、payload摘要正确，manifest／配置／计划摘要与completion一致；SQLite以只读连接及query_only核唯一state closed=1、请求序号1–6和唯一官方端点，closed标记存在、收据6／280。六份审核收据与view摘要／nonce绑定正确，封存评分重新计算一致。

finish为exit0、outer_timed_out=false、closed=true、close_unknown=false、worker_gone=true、automatic_successor=false；PID／PG18352存在性检查均已不存在，cleanup_error_codes为空，records及receipt无错误。RAW值守已停止，后续未补签。初次Root关闭脚本误将冻结schema与SDK转换后的wire直接比字节、并误将SQL静态manifest与含reserved_requests的快照全等比较，均在只读核验中修正；未改运行记录或收据。最终关闭核验命令退出0。

仅本机忽略产物 `desktop/artifacts/full140-mixed-v-off-real-20261016-v1/` 保存freeze／授权绑定／preflight／activation／事件／审核／result／finish及 `root-closing-check.json`。没有真实聊天、业务PG、GUI、外部聊天发送、ECNU或远端Git；凭据与本机身份不进入公开证据。

本报告只封存本场，后继先离线重现稳定本人身份缺少合适类型叶及时间编译问题，并区分V语义漏检与采纳策略。不能把全部state改成长期事实、修改Gold或降低bad_auto停止门。原9张仍3 resolved／6 claimed，三张记忆票均未完成，15张排除任务保持。独立结果审查：Standards初审1项P2（进度中的核验时序过述），据关闭后实证纠正，增审剩余0、判断性问题0；Spec缺失／范围外／错误表述均0。两轴分别核验，未授予总体质量信用。
