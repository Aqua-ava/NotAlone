# 任务07独立核验推理场结果

本场未通过完整质量门。原16窗仅A01–A06完成独立RAW/FULL审核，safe6／一般0；A07核验输出达到上限而unknown，A08–A16未运行。已审安全0不能外推整场，不拼接旧场达到至少15窗。

## 冻结与闭账

- source `0e6706f5`，89份来源；plan `reference16-pro-retention-v-thinking-v1`，沿[独立计划](reference-v-thinking-plan-20261018.md)。
- run `bd7187de-3624-4131-815d-f56ba1571d48`；freeze SHA-256 `a5af4caaf99b6f5a40e9552247f1250d93aaa9cf7e8a2ee65f69d93daa3738a7`。
- 第六版分阶段合同：E精确Pro disabled／none／named forced，V独立Pro enabled／max／省略tool_choice；均8192，E类型教学＋V保真＋A05有限理由。原Gold、schema、提示及质量门未改。
- closed **14/32**：E7／V7，14个HTTP200，79事件，315.464秒；余18永久关闭。无重试、自动后继或外层超时，exit0，worker及进程组已退出，临时单键凭据已删除。
- `cleanup_error_codes=[]`，records／receipt错误均null，capture gap0。本场仅公开合成资料，没有业务库、真实联系人、App、微信或发送操作。此前241加本场14，累计255请求，全部HTTP200；HTTP成功不代表语义或结构化成功。

## 独立语义结果

| 窗口 | 结论 | 必需RAW／接受／FULL | 依据 |
|---|---|---|---|
| A01 | safe | 2／2／2 | 未知第三人否定职务和采购部均保留；本次V正确支持，contact资料归属未误作行动者；pending。 |
| A02 | safe | 1／1／1 | 采用收到老李邀约v1，未补接受或参加，auto符合原分支。 |
| A03 | safe | 1／1／1 | 昨天再次借款的第三人转述、方向、身份未知及敏感性保留，pending。 |
| A04 | safe | 1／1／1 | 临时请求、请求者归属、未知事项和观察点正确，pending。 |
| A05 | safe | 1／1／1 | 新理由说明姐姐出借、联系人接收和已发生阶段，同时保留“她”无唯一指称及车主未知；V引用准确，pending。 |
| A06 | safe | 2／2／2 | 到达机场与正在等行李分项，历史／瞬时观察时间正确，两项auto。 |
| A07 | unknown | 不计 | V未返回工具结果，未发布RAW/FULL审核视图，不对已保存E产物事后补信用。 |
| A08–A16 | unrun | 不计 | 原分母保留，包括原none窗口，不删窗补位。 |

必需RAW **8/18**、接受 **8/18**、FULL **8/18**，可选0/1。6个已审窗口假事实、错人、bad_auto、歧义auto均0，一般0；整体至少15窗与质量门未满足。原matcher另报false_facts3／general1／passed3，单列保留，不混同原Gold逐字段语义审核。

## 可确认的技术原因

末次A07 V原始响应长度34444字节；已保留脱敏JSON、原始长度及摘要，推理正文不持久化。原始响应SHA-256 `e9babb827f041b4422b2e21995299e35db2c5192756f21c25f44e7e271bb92ca`。响应身份为deepseek-v4-pro，`finish_reason=length`、`completion_tokens=8192`、其中`reasoning_tokens=8192`，保留的message正文为空且没有tool_calls。实际请求max_tokens为8192。系统按既有截断／缺工具门硬停为unknown；没有增加预算、修补输出或重发。

这是本场可观察的推理输出耗尽上限，不能回推旧场832／843／844字节摘要的具体原因，也不能声称只要增加token或降低推理量就必然完成。前六个V总输出为1094、1310、1029、2031、703、1505；本场14响应usage总计input53388／output16593／reasoning15082，cache hit46336／miss7052。全部usage来自实际响应，不外推价格或质量稳定性。

[官方Chat Completions合同](https://api-docs.deepseek.com/api/create-chat-completion/)当前列出none／low／high／max推理量，默认high；输出上限可配置，max推理的未指定默认值为128K。本次显式8192覆盖默认值。后续应独立冻结并比较降低V推理量或增加V输出上限的取舍；不改变本场闭账或把截断响应当可接受结果。

## 验证与后继

统一源码通过926项提取单测、52项相关检查、8源码类型检查及合并复审。 独立闭账审计确认89源、实际运行解释器的8包版本、12份审核绑定／received回执、6份RAW封存与12条磁盘语义记录一致；98个E字段、28个V字段、8条逐字来源引用及输入时间均复核。用冻结源码重新评分的6窗报告与持久结果一致，私有audit-summary保留完整证据。实际前六窗语义封存与最后技术停止分开计，不用离线测试替代真实质量门。任务State与未通过AC保持，旧D8失败及reason_rule缺口不删除，默认生产放行表仍为空。结果归档后先向主协调提交具体证据与独立干预建议，不从本场自动启动新API。
