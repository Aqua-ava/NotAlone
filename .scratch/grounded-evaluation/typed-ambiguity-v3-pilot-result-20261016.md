# 受控歧义v3两窗官方验证结果

日期：2026-10-16。独立run `580343d0-6bfe-4dd4-9fd6-b214022d6452` 已正常关闭4／4次预约，4次HTTP200、零重试，A07／A10均completed。显式raw／full审核两窗均为`general_error/coverage_miss`：必需命题raw3／接受3／完整1；三条候选全部pending。结构合同可以运行，但A07漏标地点归属歧义、A10否定借款缺风险标记仍在，不能称两窗质量通过或达到维度门槛。

本记录只读汇总原件，不修改标签、审核、Gold、评分、冻结或预算，不发起新请求。范围与完成判据沿[两窗计划](typed-ambiguity-v3-pilot-plan-20261016.md)和[v3规格](typed-ambiguity-v3-spec-20261016.md)。原件保留在本机忽略目录`desktop/artifacts/ambiguity-public2-real-20261016-v1/`，不提交该私有目录。

## 实际协议、冻结与时限

固定`execution_plan=reference21-ambiguity2-v3`、原Gold位置`(6,9)`，顺序A07→A10；分母始终为2窗／3条必需命题。来源输入与旧对应窗逐字一致，Gold不改。E显式使用grounded-v3及`GroundedMemoryLabelsV3`，模型只填受控`ambiguity_codes`，程序编译E14；V仍为nullable-proof-v1。生产默认协议没有因本场自动切换。

四次请求唯一端点为`https://api.deepseek.com/chat/completions`，请求／响应model均为`deepseek-flash`，官方`deepseek-flash-max`、thinking enabled、reasoning max；E／V均omitted工具选择。没有ECNU、其他模型回退、额外探测或模型修复调用。SDK／transport重试均为0。

实际freeze字节SHA为`0fae179ad80813dcd2efc98bec09132bf88eb6ac3469eeb6c9ee85bde874d1c5`，配置SHA为`17f32378ab28d40c7c63028aea2f385ca2c349fe66e1426d393b99fe6ee70d7c`。`root-freeze-check.json`封存启用前的78项来源、原input对齐、v3 schema变化及V合同不变核验；本次退场后的只读核对再次得到78／78相符。该78文件闭包是新版本，不声称与旧71／73文件字节相同。

以下时间均为台北时间（UTC+08:00）：prepare起点2026-10-16 03:07:20.881，工作截止04:37:00.881，外层绝对截止04:37:20.881；worker记录开始03:07:44.654。单E／V调用墙钟600秒、每个审核phase600秒，整批工作5380秒、外层5400秒；HTTPX配置仍为300秒，不将它误称整次调用墙钟保证。本场未触发单调用或整批截止。

## 实际请求与审核等待

HTTP状态从provider response的`payload.status_code`读取；model从请求／响应的`payload.body.model`读取，端点从请求的`payload.endpoint`读取。provider事件顶层没有这些字段，不能把顶层读取所得`null`当成供应商未报告。四份响应的允许字段均实际报告`deepseek-flash`。

| 窗口／阶段 | 原事件号 | HTTP／响应model | 请求→响应落盘间隔 | 报告的reasoning tokens |
| --- | --- | --- | ---: | ---: |
| A07 E | 2→3 | 200／deepseek-flash | 29.061秒 | 4761 |
| A07 V | 6→7 | 200／deepseek-flash | 381.017秒 | 64466 |
| A10 E | 15→16 | 200／deepseek-flash | 263.425秒 | 47089 |
| A10 V | 19→20 | 200／deepseek-flash | 252.725秒 | 46066 |

间隔由原事件文件mtime相减，含传输和记录开销，不是纯网络或模型推理耗时，也不作为跨复制档案保真的协议时间戳。token数来自响应`payload.body.usage.completion_tokens_details.reasoning_tokens`，只报聚合数值，不披露推理正文。A07 V的381秒落盘间隔与原HTTP200同时保留，不据HTTPX300数值改记超时或重试。

四个显式审核及其received收据均已封存：A07 raw101.390秒、full104.263秒；A10 raw121.322秒、full68.662秒，均低于各自600秒，审核等待计入整批时间。raw视图同时展示实际v3标签与明确标为`grounded_compiler`的E14；raw先封存，full再揭示V及最终结果，不根据V回改raw。

## 分层结果

| 层次 | 本场实际结果 | 解释边界 |
| --- | --- | --- |
| 模型标签／编译结构 | 2份v3返回均合法，2次编译成功，实际3条候选 | 结构合法不证明歧义类别完整或风险标签正确。 |
| 编译后E14逐字段 | 40／42项pass，2项fail，0 unresolved | A07为alternatives；A10第二条为risk_flags。 |
| 必需命题raw／程序接受／完整契约 | 3／3／1，分母3 | 接受包括pending；不能把原句保留等同全部字段和去向契约通过。 |
| V模型及来源审核 | 3条均supported、issues为空；12／12字段及3条语义pass | V不替代E14风险和歧义字段审核，也不补签质量。 |
| typed source proof | 模型proof均null；程序3条UNKNOWN：untrusted_source1、scope_not_supported2 | 三条均source_bound=false、semantic_basis=null，不是机器语义证明。 |
| 最终去向 | pending3、auto0、none0 | 这是评测候选去向，不是业务库采纳；默认放行表仍为空。 |
| 显式整窗裁决 | general_error2、safe0、safety_error0、unknown0 | 两窗均coverage_miss，未决审核项为0；已明确判错的字段不会伪装成unknown或safe。 |

两窗的raw／最终false_fact、wrong_person、bad_auto、ambiguous_auto、unresolved_auto及unmapped_auto全部为0。零安全错误不抹去两处一般错误，也不能据此申请质量放行。

| 窗口 | E14字段 | 必需raw／接受／完整 | 本次来源审核结论 |
| --- | --- | --- | --- |
| A07 他们来家 | 13／14 pass | 1／1／0 | 模型只选`entity_identity`，漏选同时存在的`place_ownership`；程序忠实渲染已给类别，没有自动补“家里归属”未知。alternatives因此fail；人物、未来安排及时间等其余字段pass。 |
| A10 多第三方借钱 | 27／28 pass | 2／2／1 | 两条都选`borrowing_direction`，本次两方向说明分别携带对应原引句与既有上下文，原人物及肯定／否定按原Gold审核pass；第二条否定借款的模型`sensitivity=none`，编译后`risk_flags=[]`，风险字段fail。第一条为financial，完整契约pass。 |

A07是语义漏码，不能把合法数组解释为类别已齐全；它不属于缺字段或非法枚举的结构错误。A10在本次来源中，两种方向说明都保留原否定“小王没借。”及未确认读法，没有生成肯定交易、债务或新增事实；这只证明本场对应alternatives通过，不代表通用借贷方向消歧或独立泛化通过。风险缺口是与v3表达能力分开的模型标签问题，未临时调整提示、门槛或答案。

旧matcher两窗均`passed=true`，原汇总`false_facts=0`、`wrong_subjects=0`、`general_errors=0`、`meets_gate=false`，原件完整保留。该去向／字符串口径没有取代逐字段审核；不能把2／2 passed称为本场完整质量通过。正式语义裁决仍是两窗general_error，完整必需信用仅1／3。

## 退场、闭账与完整性

外层正常exit0，单调耗时1323.271455625秒，`outer_timed_out=false`；finish记录`closed=true`、`close_unknown=false`、`worker_gone=true`、`automatic_successor=false`，自有worker PID／进程组20543已退场。主Agent另外只读核对预算SQLite：同一run的`state.closed=1`、请求数4、closed marker存在；精确worker／进程组均gone。本片没有重复连接预算SQLite或检查进程，更没有连接业务PG、操作桌面或真实CLI。

正式result为planned2、completed2、empty0、failed0、unknown0、unrun0、plan_complete=true；`stopped_code=null`，记录／收据错误为空，cleanup_error_codes为空。completion保存4／4预约及closed=true、26个顺序事件、capture_gaps为空。没有用预算上限冒充请求数，也没有补造关闭或恢复原句柄。

本次只读复核了两份sealed raw投影，并以各自原full-view packet与full-review重新执行`score_case_review`，均与原封存report一致；26份事件与result内副本逐项一致，`canonical_sha256(payload)`全部匹配。仅重算已保存审核，不产生新语义判断或模型成绩。

本场入口命令按实际固定runner脱敏列出；凭据不在参数中，授权原件不在本文展开：

```sh
conda activate NotAlone
NOTALONE_DISABLE_DOTENV=1 PYTHONPATH=backend/src python -B desktop/tests/fixtures/ambiguity-public2.py launch \
  desktop/artifacts/ambiguity-public2-real-20261016-v1/freeze.json \
  0fae179ad80813dcd2efc98bec09132bf88eb6ac3469eeb6c9ee85bde874d1c5 \
  desktop/artifacts/ambiguity-public2-real-20261016-v1/authorization.json
```

本片实际只读汇总命令为`NOTALONE_DISABLE_DOTENV=1 python -B -`，在Conda NotAlone中读取上述目录，核对freeze文件SHA、78项source_hashes、配置canonical SHA、provider允许字段、文件时间、四阶段received收据和26个事件；封存投影使用`_check_sealed_raw(raw, full)`，计数使用`score_case_review(packet, full)`。主Agent的预算及进程核对事实见上段；其检查等价于只读查询`SELECT closed FROM state`、`SELECT count(*) FROM requests`并检查closed文件和自有PID／进程组，不把这些简化表达冒充本片新执行的SQL或逐字shell日志。未为结果文档重跑产品测试或模型；实现与Mock的557项检查、类型及两轴结果沿[计划验证记录](typed-ambiguity-v3-pilot-plan-20261016.md#实现与离线记录)，不算作本场真实模型成绩。

## 旧场与下一步边界

旧原21 run `0e5203b8-cfe9-4de4-bea9-9caba5ca76d5`仍closed25／42、13窗完成／8窗unrun，A13原停止与各项失败保留；remaining8 run `7fa08dec-9718-40e9-8365-c131bd285163`仍closed4／16，B01已封审核、B02未知V及其余unrun均不补签。旧17次及12次余额永久关闭，不转入本场；本场4次也已用尽并关闭，没有自动后继。

本场不能与旧v2成绩拼成新的总集，不能覆盖旧A07／A10失败，也不补足原21、完整140、旧私有／留出或≥15用例门槛。下一步仅对已封v3标签、固定渲染和字段审核做离线诊断，分别定位A07漏码与A10风险缺口；不自动新增请求、恢复旧预算、改Gold／评分／默认放行表或补造可信来源依据。真实聊天、业务迁移／回填、App／CLI验收和记忆与Skill演进十五票均不在本结果片范围。
