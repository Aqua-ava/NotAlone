# 原公开21窗的四槽来源语义质量合同

Triage: ready-for-agent
State: claimed

## 目标与固定范围

在原持续授权的必要有界官方DeepSeek公开合成验证范围内，核验当前显式v4的E14／V四槽及完整去向。原21全窗／原顺序A01–A19、B01／B02、28必需＋1可选、已审source-fidelity-v2参考与Gold不变；旧场／旧失败／预算不重开或拼成绩。该评测没有受控来源链，typed明确未评估且无信用。

## 唯一合同

| 字段 | 固定值 |
| --- | --- |
| execution_plan | `reference21-grounded-v4-source-v2-semantic4-v-off-forced` |
| mode／stage／owned kind | `deepseek_bounded_reference21_v4_source_v2_semantic4`／`reference21-v4-source-v2-semantic4`／`reference21-v4-semantic4` |
| case_set／positions | `reference21`／`None`，原positions0–20 |
| extraction／reference／verification | 当前`grounded-v4`（含matter_reference）／`source-fidelity-v2`／既有`legacy-v4`严格四槽 |
| prompt_profile | `public-author-quote-v1`，只追加作者包装澄清，旧默认字节保持 |
| provider／phase policy | 复用`deepseek-phase-split-v1`，E thinking enabled／reasoning max／省略tool_choice，V disabled／none／强制原具名工具 |
| endpoint／model | 仅`https://api.deepseek.com/chat/completions`／`deepseek-flash`，实际请求及响应身份均核 |
| 请求／重试 | 独立cap42、max_retries=0、一次持久领取及一次凭据、同transport与预算 |
| 时间 | 从prepare绝对14400秒，工作14380秒；每调用及RAW／FULL各600秒，HTTP读取300秒，较早截止优先 |

领取／凭据前严格核原21每条消息都无source_snapshots、无message_snapshot且message_type／text_representation均unknown；不伪造可信来源。真实窗口或混合可信来源不属于此合同，拒绝且不回退。新profile仍使用正式adapter／校验器／Flow及原来源引句门，返回额外proof（包括null）严格失败，不丢字段、不补调用，不新增SourceVerificationMode、供应商或API特性。

## 实施与验证决定

在既有reference21-v4-public.py内部增封闭profile，默认旧FIXED保持。复用现有helpers／ExplicitReviewBridge／Reference21V4Deadline／owned回收，不新增runner、harness或依赖。adapter使用封闭提示profile且只允许配对legacy-v4；冻结helper、factory、每次发送前的合同与实际SDK请求同源。

新身份穿透provider固定集合、ecnu准入／源码闭包、offline／records／phased／owned层，精确原21、cap42、legacy、prompt profile、阶段策略和参考版本配对；旧nullable／proof2及全部旧profile不放宽。新源码、spec、计划／实施及实际helper进入新闭包，原freeze不改。模型调用前Root独立双轴审查、本地提交、历史扫描、实际freeze／旧场闭账／新registry不存在／绑定授权最终核后，才唯一启动；worker不自动后继。

按已授权接缝TDD：实际SDK Mock验证新提示＋原四槽／旧默认字节，额外proof无论null或对象先保存原件再拒绝；完整21 Mock只给定A12／A14空E时为21E＋19V＝40／42、到B02并关闭；RAW先封存、FULL不可改RAW、general续行／safety与unknown停、技术失败零重试／分母保持；profile／模式／源快照／范围／类型／cap／冻结错配均先于预算、key、审核或传输拒绝。最小后相关完整回归和类型通过，结果分组报告不累计为模型样本。

## 结果解释与停止

本场只测显式当前v4在公开原21上的语义质量，不测proof／typed／业务采纳，也不等于生产默认v2。不存在verification_program事件时不能补造UNKNOWN；结果明确typed_evaluated=false、typed_credit=false。先独立RAW再FULL，分主集A01–A16、补充A17–A19、核心B01／B02；至少15门只用本场实际主集窗口，不借命题数或旧场补足。私人严格6／12和留出独立保留。

一般错误继续；安全／语义unknown、结构／技术／来源／冻结漂移、记录／审核错误按既有硬停关闭，未知请求不补发、不退款。关闭失败如实close_unknown，Root核源码、事件／摘要／SQL／审核收据及自有组退出。四槽schema不保证模型遵守，仍可能提前停止；不通过丢proof、删难例、修改Gold／阈值或重抽取得完整率。无业务库、真实聊天、GUI、外部消息、ECNU或远端Git。
