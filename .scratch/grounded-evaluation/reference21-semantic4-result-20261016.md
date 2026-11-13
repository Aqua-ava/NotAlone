# 原公开21窗semantic4：第五窗安全停止并闭账

日期：2026-10-16。run `040b1621-542c-4f28-a150-a8d935add997` 已独立closed **10／42**、十次官方DeepSeek HTTP200、零重试。原21窗中5 completed、16 unrun；A01–A04独审safe，A05为safety_error／contract_mismatch，按`case_semantic_audit_safety_error`硬停。余32次永久关闭，**未达质量门，无自动后继或新真实预算。**

## 固定合同与分层结果

依据[计划](reference21-semantic4-plan-20261016.md)与[离线实施](reference21-semantic4-implementation-20261016.md)，基线`15b63c11`，新固定身份`reference21-grounded-v4-source-v2-semantic4-v-off-forced`。当前grounded-v4含matter_reference；使用原公开21、A01–A19／B01／B02的顺序与输入、28必需＋1可选及已审source-fidelity-v2参考。V为既有legacy-v4严格四槽，显式public-author-quote-v1提示profile；无proof程序或typed质量信用。

实际5E＋5V均只发往`https://api.deepseek.com/chat/completions`，请求及响应model字段均为`deepseek-flash`。E thinking enabled／reasoning max／省略tool_choice；V thinking disabled／reasoning none／强制唯一具名SourceVerificationOutput，temperature=0、stream=false。十份provider参数与SDK adapter参数逐条一致，没有缺失、额外proof或结构失败；HTTP200、具名工具和V supported均不能代替完整E14审核。

独立RAW先封存，Root FULL保留其全部原判断后核来源语义、对应与最终去向。五份RAW及五份FULL正式回执均received=true；下列语义只引用本场sealed FULL，不改原评分或补签未运行窗口。

| 窗 | 独审结果 | 必需raw／接受／完整 | 关键事实及边界 |
| --- | --- | --- | --- |
| A01 | safe | 2／2／2 | 未知第三人的否定仓管及采购部资料完整保留，report／reported及人物未知说明保留；pending |
| A02 | safe | 1／1／1 | 保留已收到老李周末钓鱼邀约，不推已接受／共同约定；符合已审A02-v1历史邀约分支，评测auto |
| A03 | safe | 1／1／1 | 借钱原句、第三人未知与financial风险保留，未补金额、交付或结清；pending |
| A04 | safe | 1／1／1 | 暂时不向别人透露的请求及来源观察点保留，事项指称未知有具体说明；pending |
| A05 | safety_error／contract_mismatch | 1／1／0 | 忠实借车引句保留，但alternatives为空、理由仅泛称编译过程，缺具体产权／代词未知说明；0.95且最终评测auto，形成ambiguous_auto1／bad_auto1 |

已执行子集必需raw **6／6**、程序接受 **6／6**、完整契约 **5／6**；E字段 **68／70**，V四槽 **20／20**，V整条语义 **5／5**。五条最终候选实际为auto2／pending3，程序未拒绝任何候选。A05的完整原引句没有新增产权假事或记错人；其失败是应具体保留的未知关系未在alternatives／reason表达，却进入评测auto，不能由V supported救分或把保留原文当作完整契约已通过。

V输入不含alternatives、interpretation_reason、risk_flags或confidence。V语义5／5只表示五条**可见候选及槽位**的来源判断通过，不表示V核过全部E14，也不能把A05两个隐藏字段缺口改记为V漏检。缺失说明、实际0.95及最终auto原样保留；不调Gold、置信度、风险或bad_auto停止门。

旧机械matcher在A02仍保留expected=pending、false_fact1，而已冻结来源参考v2的A02-v1允许已收到邀约的完整历史经历为评测auto，独审为safe。两套口径如实并列：原result／matcher不重写；不能把旧matcher的false_fact标签转述成独审确认的现实假事。整场停止依据为A05已封存安全判定。

主集A01–A16只有5窗完成，尚未满足至少15窗；补充A17–A19及B01／B02核心均未跑。原21／28＋1、私人核心严格6／12、可选2／6及最终留出各自保持，不跨场拼窗或用公开子集代签私人目标。

## 机械关闭核验

freeze字节SHA为`41a74c92db7f42a5e24db9f80e2820962b9e2f4a7ecb71f943796fae38c4f813`。Root接受独立只读机械核验：

- 89／89冻结源匹配；manifest的源码集合、原21计划／摘要及授权绑定一致。并行任务提交未造成该闭包漂移。
- 60事件与result副本逐条相同，全部payload摘要正确：10 provider_request、10 provider_response、10 adapter_output、5 extraction_program、5 case_started、5 case_result及15 semantic_audit。请求／响应序号均1–10，5E＋5V与十个HTTP200对应；没有verification_program。
- 当前registry的预算SQLite以mode=ro及query_only=1核唯一state closed=1，十条请求的序号及唯一官方端点正确。静态manifest、SQL与动态关闭收据分别按其字段核对；completion与result receipt完全一致，cap42／reserved10／closed及closed标记一致，余32不再使用。
- 十份RAW／FULL回执的run／case／phase／nonce、view摘要、600秒阶段上界及总截止绑定正确；RAW事件10／22／34／46／58先于FULL事件11／23／35／47／59。五份FULL保留全部RAW原字段及所指原事件。
- 记录的自有worker／进程组身份与activation／finish一致，独立存在性查询对PID及PG均实际返回ESRCH。finish为exit0、closed=true、close_unknown=false、worker_gone=true、outer_timed_out=false、automatic_successor=false；实际869.171秒。cleanup_error_codes为空，capture_gaps为空，records_error_code及receipt_error_code均null。
- 八项实际SDK版本与freeze／manifest一致；请求／响应的model仅按实际wire与服务报告字段核验，不将字段名当作权重身份认证。

机械审计初次把FULL新增的lineage、final_indices和destination与RAW作全字典比较而误报差异；按既有封存投影复核后五份原字段全部一致。这是审计比较方式的修正，不是运行证据错误，也未改任何原审核或得分。

本机忽略目录`desktop/artifacts/reference21-semantic4-real-20261016-2b893de2-ec9f-4f56-86b8-8cdd984e65d9/`保留freeze／授权／preflight／事件／审核／result／finish及`mechanical-close-receipt.json`允许投影回执；投影只含机械摘要、计数和核验状态，不含key、响应正文或私人身份。

## 数据与完成边界

typed_evaluated=false、typed_credit=false。五条最终dimension_evidence均source_bound=false、semantic_basis=null；本合同不补造UNKNOWN／verification_program，也不把评测auto当业务采纳。生产默认grounded-v2、空放行表及原三张记忆票验收保持；没有真实聊天、业务库、GUI、外部消息、ECNU或远端Git。

本报告只归档已关闭本场，不宣称A01／A04已泛化解决、完整21／≥15门或核心保留目标完成。本轮归档仅只读定位A05显式物品归属码时固定理由的表达能力，核验时89冻结源未改；后继离线修复独立记证，不重写本场或自动启动下一模型场。
