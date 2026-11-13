# v3标签指导两窗官方实测结果

日期：2026-10-16。独立run `79f0fa4b-a6d0-49f9-9a5f-b89339f1047c` 已正常exit0、closed4／4次预约，4次HTTP200、零重试，A07／A10均completed。主Agent逐窗显式封存raw／full审核：编译E14共42／42字段pass，必需命题raw3／接受3／完整3，两窗均safe。三条候选仍全部pending、auto0，typed proof均未证明；本次局部结果不认证稳定率、因果改善、总体质量或≥15窗维度放行。

本记录只读汇总已关闭原件，不修改审核、票据进度、源码、Gold、评分、冻结、预算或旧结果，不发起模型请求。范围沿[本场预注册](v3-label-guidance-public2-plan-20261016.md)和[标签指导离线诊断](v3-label-guidance-plan-20261016.md)。原件位于本机忽略目录`desktop/artifacts/v3-guidance-public2-real-20261016-v1/`，该私有目录不提交。

## 固定范围、实验变化与冻结

固定`execution_plan=reference21-ambiguity2-v3`、原Gold位置`(6,9)`，A07→A10，分母2窗／3条必需命题。E显式为grounded-v3、实际工具`GroundedMemoryLabelsV3`，程序编译E14；V为nullable-proof-v1。`synthetic_only=true`表示输入为原公开合成窗口，不表示本场调用Mock：以下四份实际provider response均为官方HTTP200。

本场`label_policy=v3-guidance-v1`，唯一实验变化是两条显式字段指导：歧义类别非互斥，逐类核对并列全来源支持的类别；financial在否定借款中仍保留，同时不认定负债或交易。模型、原输入、Gold、schema、编译、V、评分和门槛等沿预注册保持。旧v3提示本来已有“类别必须列全”，旧漏标不能被写成已证明的缺指令；本场也不能单凭一次前后差异证明提示措辞是根因。

实际freeze字节SHA为`1b9c99e40bab50a74cc6453a9c3a1d19992bdebae48881166c81a24f737f6f9e`，配置canonical SHA为`05ace1238d729e06b30c7b613631ba9e07033523c5ae13d1f5558754a53c0dbd`。主Agent启用前封存`root-freeze-check.json`：精确79份来源均核验、旧输入逐字相同、E schema及V合同不变、仅显式指导prompt改变，启用前新预算不存在且旧场已关闭。主Agent关闭时再次核对79／79一致；本记录只读复核也得到79／79无漂移，并核对freeze SHA与配置SHA相符。该复核在2026-10-16 04:50:45台北时间前完成，处于本场关闭后、后继A03独立计划修改前；后续源码修改造成历史freeze与新工作树不同，不改写本次关闭时一致的证据。该新79文件闭包不称为旧78文件相同字节。

实际E prompt SHA为`28485626ccffc26f93fda92a00da76feef8e5edacb98a67b31bee52e9fd53cbc`，A07／A10动态schema SHA分别为`aee913dade95a3afb6c46f40aa60b082c3bf0ea93890839dea4d13d76f667b65`／`50b865b092bed469cf95f689214e3e635dedd988f6422bd0899916bc410c1f28`；V prompt／schema SHA为`74743f62b8e8891abe52d087055699b4a0aa8cc4cd47d9cc4a0e58e265e0e040`／`5533c8c33be4047ac20f573f642596d87700309e0ca0e36b93923714981efaed`。安装版本沿本freeze封存：openai3.3.1、httpx0.28.1、httpx2 2.12.0、langchain-core1.5.5、langchain-deepseek1.1.0、langchain-openai1.5.1、langsmith0.11.0、pydantic2.13.4。

以下时间均为台北时间（UTC+08:00）：prepare起点2026-10-16 04:08:15.285，worker开始04:10:59.253，工作截止05:37:55.285，外层绝对截止05:38:15.285。单E／V调用墙钟600秒、每个审核phase600秒，整批工作5380秒、外层5400秒；prepare到启动的等待计入绝对时限。HTTPX配置300秒不等同整次调用墙钟上限。本场没有触发调用或整批截止。

## 实际请求及四阶段收据

唯一端点为`https://api.deepseek.com/chat/completions`，四次请求／响应model均为`deepseek-flash`，官方档位`deepseek-flash-max`、thinking enabled、reasoning max；E／V请求均omitted工具选择。没有ECNU、模型回退、额外探测、修复请求或重试。

| 窗口／阶段 | 请求→响应事件号 | HTTP／响应model | 请求→响应落盘间隔 | 报告的reasoning tokens |
| --- | --- | --- | ---: | ---: |
| A07 E | 2→3 | 200／deepseek-flash | 12.425秒 | 1866 |
| A07 V | 6→7 | 200／deepseek-flash | 270.783秒 | 46365 |
| A10 E | 15→16 | 200／deepseek-flash | 76.114秒 | 12581 |
| A10 V | 19→20 | 200／deepseek-flash | 568.417秒 | 91243 |

状态取provider response的`payload.status_code`，model取请求／响应的`payload.body.model`，端点取请求的`payload.endpoint`。间隔由对应事件文件mtime相减，含传输及记录开销，不是纯模型或网络耗时，也不是跨复制档案保真的协议时间戳。A10 V的568秒间隔与实际HTTP200同时保留，不据HTTPX300数值改记超时。仅读取响应`usage.completion_tokens_details.reasoning_tokens`聚合计数，未读取或披露内部reasoning正文。

| 显式审核phase | 原receipt耗时 | received | 绑定及期限 |
| --- | ---: | --- | --- |
| A07 raw | 458.244819459秒 | true | run／nonce／phase／view SHA一致，低于600秒 |
| A07 full | 197.170030959秒 | true | 同上 |
| A10 raw | 198.427243084秒 | true | 同上 |
| A10 full | 355.313926125秒 | true | 同上 |

上述耗时直接来自各自原receipt，不用文件时间替代审核等待。raw先封存，full再展示V与最终层；本次两份sealed raw向full投影均一致。模型标签与`e14_origin=grounded_compiler`分别展示，程序编译结果没有冒充provider返回的E14工具响应。

## 分层审核及去向

| 层次 | 本场实际结果 | 解释边界 |
| --- | --- | --- |
| 模型v3标签／编译 | 两份标签合法、两次编译成功，3条实际候选 | 模型标签和编译E14分别保留，结构成功不单独授质量信用。 |
| 编译E14字段 | 42／42 pass，fail0、unresolved0 | A07 14／14；A10 28／28。 |
| 必需命题raw／程序接受／完整契约 | 3／3／3，分母3 | A07 1／1／1，A10 2／2／2；接受包含pending。 |
| V模型结果 | supported2、uncertain1；12／12字段及3条语义pass | 每条依原来源显式审核，未因supported或保守pending默认通过。 |
| typed source proof | 3条proof=null、程序UNKNOWN：untrusted_source1、scope_not_supported2 | 全部source_bound=false、semantic_basis=null；没有typed语义证明。 |
| 最终去向 | pending3、auto0、none0 | 这是评测候选去向，无业务写入；生产默认放行表仍为空。 |
| 显式整窗裁决 | safe2、general_error0、safety_error0、unknown0 | 仅本次两窗审核结论；`quality_certified=false`。 |

本场raw／最终false_fact、wrong_person、bad_auto、ambiguous_auto、unresolved_auto、unmapped_auto均为0；未映射V输入和最终候选为空，重复source引用0，未决审核项0。没有用最终pending代替正文、字段、来源或去向契约审核。

A07实际模型同时给出`entity_identity`与`place_ownership`；编译备选分别说明人物身份和地点／家里归属无法唯一确定，未补具体人或所有者。原未来来访与周末半开检索边界保留，plan／asserted合法；V为supported、issues=[]，最终pending，完整1／1。

A10两条均给出`borrowing_direction`及`sensitivity=financial`，否定项的财务敏感性没有丢失。P1为`assertion/asserted`，匹配预冻结P1-v2；P2为`report/reported`，匹配P2-v1。两方向说明都携带各自原引句与既有问句，保留老李／小王及肯定／否定，不指定贷借方向，不补金额、交付、债务或还款。raw 28／28先封存，full未回改原E分支。

A10-P1实际V为`uncertain/issues=[pragmatics]`，引用target“借了”与原问题“老李借你钱了吗”。主Agent按冻结`common.v_field_rules`显式审核其verdict／issues／semantic为pass：规则允许真实歧义对应uncertain，原问答仍不能唯一确定借入／借出；V不见alternatives，不能据E已保留两读强制V必须supported。pragmatics可指省略答复依赖问句的语境解释歧义，冻结规则未把它限成语用标签错误。这不推翻P1-v2合法分支，也不表示肯定事件未发生；实际程序追加`semantic:pragmatics`并保留原正文和pending。P2为supported／issues=[]，真实否定子串及原问题均在候选原source内，未互换人物或定案方向，显式通过。

旧matcher本场两窗均`passed=true`，原维度汇总false_facts0、wrong_subjects0、general_errors0、`meets_gate=false`。此字符串／去向口径与全量字段审核分别保留；本场完整信用来自原封存显式审核，不由matcher、V自身或UNKNOWN自动签发。

## 退出、预算闭账及复核命令

`finish.json`记录正常exit0、单调耗时2138.363318875秒、`outer_timed_out=false`、`closed=true`、`close_unknown=false`、`worker_gone=true`、`automatic_successor=false`。自有worker PID／进程组81216已退场；主Agent先核对gone，本记录随后只读`ps -p 81216 -o pid=,pgid=,comm=`及`pgrep -g 81216`均无匹配、退出码1，没有向进程发送信号或启动App／CLI。

本记录只读打开该run的预算SQLite，URI为`file:<用户级注册目录>/<run_id>/budget.sqlite3?mode=ro`并设置`PRAGMA query_only=ON`。`SELECT manifest, closed FROM state`得到1行、closed=1、配置摘要一致；`SELECT sequence, endpoint FROM requests ORDER BY sequence`得到连续1–4、均为唯一官方端点；同run的`closed`marker存在。未调用`EvaluationBudget.open/create`、恢复句柄或读取其他run预算，没有触碰业务PG。

正式result为planned2、completed2、empty0、failed0、unknown0、unrun0、plan_complete=true；stopped_code、receipt_error_code、records_error_code均null，cleanup_error_codes为空。completion为4／4预约、closed=true、26事件、capture_gaps为空。26份事件与result内副本逐项相等，全部`canonical_sha256(payload)`匹配；两窗原full-view packet及full-review重算`score_case_review`均与原封存report相等。这里只重算已保存审核，不产生新的模型成绩或审核签字。

实际固定入口按原freeze脱敏列示；凭据不在参数中，授权原件不在本文展开，也不重新执行：

```sh
conda activate NotAlone
NOTALONE_DISABLE_DOTENV=1 PYTHONPATH=backend/src python -B desktop/tests/fixtures/ambiguity-public2.py launch \
  desktop/artifacts/v3-guidance-public2-real-20261016-v1/freeze.json \
  1b9c99e40bab50a74cc6453a9c3a1d19992bdebae48881166c81a24f737f6f9e \
  desktop/artifacts/v3-guidance-public2-real-20261016-v1/authorization.json
```

本记录实际汇总在Conda NotAlone中使用`NOTALONE_DISABLE_DOTENV=1 PYTHONPATH=backend/src python -B -`，只读核对freeze字节SHA、79项source_hashes、配置canonical SHA、26份事件与允许provider字段、四phase收据及视图绑定，调用`_check_sealed_raw(raw, full)`和`score_case_review(packet, full)`复核投影与计数，并执行上述只读SQLite查询及精确PID／进程组查询。验证输出保留于本次工具执行记录，没有另写私有验证脚本或日志。未为纯结果文档重跑产品测试或真实模型；实现及Mock的94项、类型和双轴记录沿本场预注册，不计入真实模型成绩。

## 与旧小试分别记录及后续边界

| 独立场次 | run | 请求闭账 | E14完整字段 | 必需raw／接受／完整 | 整窗显式裁决 |
| --- | --- | --- | --- | --- | --- |
| [原受控歧义v3小试](typed-ambiguity-v3-pilot-result-20261016.md) | 580343d0-6bfe-4dd4-9fd6-b214022d6452 | closed4／4 | 40／42 | 3／3／1 | general_error2；A07漏place_ownership、A10否定项漏financial |
| 本场v3标签指导 | 79f0fa4b-a6d0-49f9-9a5f-b89339f1047c | closed4／4 | 42／42 | 3／3／3 | safe2，仍无typed proof或auto |

两行是不同提示、不同冻结的各一次观察，旧失败及原报告完整保留，不拼成新总集、不计算稳定通过率、不认证提示指导的因果效果。它们均不补足原21窗、完整140、独立泛化／留出或≥15用例质量门槛；生产默认协议和空放行表不变。

原21 run `0e5203b8-cfe9-4de4-bea9-9caba5ca76d5`仍closed25／42；remaining8 run `7fa08dec-9718-40e9-8365-c131bd285163`仍closed4／16，原B02未知V、其余unrun及旧停因不补签。旧17／12次余额、原v3小试4次及本场4次均关闭，不复用、不退款、不恢复、不自动后继。

本场只上传已冻结的公开合成窗口，未上传私聊，未使用ECNU、发送外部聊天、访问业务库或执行迁移。结果文档阶段未读取.env、密钥或内部reasoning正文，未改HOME／CODEX_HOME。下一步仅可对已封存原件做离线诊断及审查；本报告不领取新预算、不授权新请求或自动扩场，不将两窗局部完整结果宣布为三张记忆原票整体完成。

独立结果复审：Standards／Spec各0项；只读原件，不重跑模型、不改审核、Gold或去向。主Agent随后按此记录更新原票局部进度，三票整体状态及未达门保持。
