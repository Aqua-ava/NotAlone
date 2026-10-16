# 原公开21窗当前v4基线：A05证明跨度越界停止

日期：2026-10-16。run `c28d0792-2740-454d-ae2c-250918687bde` 已独立 closed **10／42**、十次官方DeepSeek HTTP200、零重试。原21窗中4 completed、1 failed、16 unrun；A05来源证明位置非法，按 `case_contract_or_runtime_failed` 停止，剩余32次永久关闭。**本场未达质量门，无自动后继或补发。**

依据[固定计划](reference21-complete-v4-plan-20261016.md)与[离线实施](reference21-complete-v4-implementation-20261016.md)，实际代码基线 `d553e3340dcfd3620810024834d58829ca4397ba`，执行身份 `reference21-grounded-v4-source-v2-v-off-forced`。原输入positions0–20、A01–A19／B01／B02、28必需＋1可选均保持，采用grounded-v4／source-fidelity-v2／nullable-proof-v1；稳定事实叶和附属数量角色的离线通过不代替本场未到达窗口的模型质量。

## 本场协议与逐窗结果

启动前Root核旧九场均closed、新registry不存在及绑定授权；唯一启动后只使用 `https://api.deepseek.com/chat/completions`。关闭核验逐次确认5E＋5V请求及响应model均为 `deepseek-flash`：E thinking enabled／reasoning max／省略tool_choice，V thinking disabled／reasoning none／强制具名 `SourceVerificationOutput`，stream=false／temperature=0。HTTP200和工具返回不代表证明契约有效。

独立RAW Agent只看前层并先封存，Root FULL保留RAW全部判定后核V、对应与最终去向。四份RAW及四份FULL均正式received=true；A05没有审核视图、收据或事后补审，其后16窗未读未跑。

| 窗 | 正式独审 | 必需raw／接受／完整 | 实际差异 |
| --- | --- | --- | --- |
| A01 | general_error | 2／0／0 | E忠实合并未知第三人的否定仓管及采购部事实；V无据以meaning/subject/pragmatics拒绝，最终为空 |
| A02 | safe | 1／1／1 | 保留已收到老李周末钓鱼邀约，未推已接受或双方约定；relationship_note/assertion/asserted符合参考v1分支，评测auto |
| A03 | safe | 1／1／1 | 未知第三人昨天又跟联系人借钱，financial敏感标记与身份歧义保留，未补交付或结清；pending |
| A04 | general_error | 1／1／0 | 暂不向别人透露的请求保留，pending；alternatives仅泛称“其他未决解释”，没有说明所指事项无法识别，严格记该字段fail |
| A05 | failed，未审核 | 不计审核信用 | V非null proof的来源跨度越界，来源核验整批失败，未写记忆 |

仅四窗正式材料汇总：5必需raw5／接受3／完整2；E字段55／56、V字段14／16、V整条语义3／4；审核未决及未映射均0。新增假事、错人、bad_auto、歧义auto均0，仅针对已审四窗，不给未审核A05签安全0。A02旧matcher的 `false_fact=1` 来自旧严格期望不匹配，保留原结果但不冒称现实假事；本场独审按已冻结A02-v1分支通过。A04的V不可见alternatives，不将隐藏字段缺陷转算成V漏检。

主集A01–A16仅4已审／1失败／11未跑，已有2一般错误，不能满足至少15窗且一般错误≤1；补充A17–A19与核心B01／B02全部未跑。原28＋1分母、私人核心严格6／12、可选2／6的历史及最终留出验收均独立保留，不跨场拼样本或用公开合成代签私人目标。

四条已审V的proof均null，程序UNKNOWN为untrusted_source3／scope_not_supported1；最终pending2／评测auto1，source_bound=false、semantic_basis=null，无typed或业务采纳信用。A05的非法proof是技术契约失败，不能混记成普通UNKNOWN。生产默认空放行表、grounded-v2、原语用／0.7／风险门及逐维度依据与批准的AND门均保持。

## A05只读事后诊断

封存V原文为 `我姐把她的车借给我了。`，实际11个Unicode码点；模型proof却给source `[0,12)`。provider事件59与adapter事件60参数全等，工具名、UUID和quote合法；`_validate_positions` 在可信来源/UNKNOWN判断前拒绝越界，flow随后返回“来源核验失败，本批未写入记忆。”。这不是HTTP、响应保存或预算故障。

独立Agent禁网络纯内存重放原始参数两次，均得到proof_semantics失败；单变量将source.end改11则正常返回UNKNOWN/untrusted_source，proof=null或省略同样正常。候选全文长19、原candidate `[0,18)`未覆盖末引号，但未越界，改变end19也不改变该合法控制结论；它不是本次硬失败触发点。来源无明确“她”的身份且原候选包装不在旧有限正例语法，不能由此控制签产权或合法proof。

这些控制只用于定位，不覆盖原响应、不补审或重算本场。原请求已明确Unicode半开区间和超范围/未解指称时proof留null，不能把失误归因为没有提示，也无法证明模型为何计数12。后继只离线固化越界拒绝与合法UNKNOWN的边界，不放宽位置合同；用户已批准的B只支持完整作者到家包装，不借此扩大到本例借车或产权。

## 关闭核验与数据边界

freeze字节SHA `7807185476e404fb6007ee02ae504196ef2a7506f33867658f85fc63aa6d1461`。Root于关闭后、任何后继源码改动前，实际核86份源文件全部匹配、61份事件与result副本一致且payload摘要正确、8份RAW/FULL收据nonce/摘要/时限绑定、RAW未被FULL改写，重算四份正式评分与原事件完全一致。只读SQLite及query_only确认state唯一且closed=1、请求序号1–10和唯一官方端点，closed标记及收据10／42一致。

外层实际928.096秒，finish exit0／outer_timed_out=false／closed=true／close_unknown=false／worker_gone=true／automatic_successor=false；PID与PG94146再次独立检查均实际ESRCH。cleanup_error_codes为空，records及receipt无错误；原RAW值守已停止。Root关闭审计命令退出0，不使用后来修改后的源码反签冻结匹配。

仅忽略产物 `desktop/artifacts/reference21-v4-real-20261016-v1/` 保存原freeze、授权绑定、preflight、事件、审核、result、finish与root-close-audit。关闭脚本只读原件并独占发布独立审计，不改运行证据；没有真实聊天、业务库、外部聊天发送、ECNU、远端Git或业务自动采纳。桌面验收另有模型上限0的独立占用与原件，不能用本场分项证据替代App验收。

本报告只封存当前基线。原三张记忆票仍claimed、验收不勾；指代质量及核心完整命题继续未达。用户明确采纳有限包装B后，在独立工作树实施及隔离验证；不重开本场、不自动登记后继真实请求，也不凭B实现放行任何维度。排除的记忆与Skill演进15张不处理。
