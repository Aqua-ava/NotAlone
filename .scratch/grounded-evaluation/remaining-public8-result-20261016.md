# 剩余公开8窗的有界运行结果

日期：2026-10-16。独立run `7fa08dec-9718-40e9-8365-c131bd285163` 已持久关闭4／16次预约，3个HTTP200、1个核验请求远端状态未知，零重试；未用12次永久关闭。B01有完整封存审核，B02未进入审核，其余6窗unrun。本场没有完整batch result，不能称8窗或原21窗完成。

## 实际协议与时窗

按[本场方案](remaining-public8-plan-20261016.md)仅使用原公开合成输入、官方`https://api.deepseek.com/chat/completions`及请求／响应`deepseek-flash`，`deepseek-flash-max`、thinking enabled、reasoning max；E为grounded-v2，V为nullable-proof-v1，两次工具选择均omitted。没有ECNU、真实聊天、业务PG、App、CLI或外部发送。

prepare起点为2026-10-15T17:31:21.435674Z，工作绝对截止18:11:01.435674Z，外层截止18:11:21.435674Z。实际worker从17:34:56.480275Z开始；外层单调耗时2165.360秒。worker在工作截止以`batch_wall_deadline`先关闭原Budget并fsync收据，再exit124，外层自身正常返回且未触outer timeout。关闭文件落盘18:11:01.455978Z为文件时间戳，不冒充watchdog精确调度时刻。

实际freeze字节SHA为`274abee881ee37fd8355da6f9dac0d6aa74dd46a1fa76d1ee83b8db046494841`，冻结73个源码／判据／计划文件；启用前及退场后、任何后继源码修改前均独立核73／73相符。与旧原21的8个对应位置逐窗input、E prompt／schema、V prompt／schema、Gold及安装版本一致；新模式、deadline和runner是明确的新执行版本，不称旧71文件原样运行。配置SHA为`9b7ced6b1dd59cc841d3d4107675e261e84ee05331a419afbc2fa8903b0769da`。

## 请求与审核分开统计

| 窗口 | 实际HTTP | 封存语义审核 | 退场口径 |
| --- | --- | --- | --- |
| B01 报价判断与条件咨询 | E200、V200 | raw及full均received，safe／supported | 有可独立复核的完整单窗审核；batch终态仍unknown |
| B02 第三人历史经历与当前未知 | E200、V已预约但无响应记录 | 无raw/full view或review | unknown；不把E输出补签完整保留 |
| A14、A15、A16、A17、A18、A19 | 0 | 0 | 六窗unrun |

原件的`finish.json`在缺少完整result时保守把所有已开始窗标unknown，故其B01／B02均为unknown，其他六窗unrun；本报告没有覆盖该收据。B01的单窗审核是另一层确已落盘的证据：event11／12保存raw/full，event13明确safe／supported，且两阶段received=true。两层分别报告，不能把事后重算分数变成batch完整结果。

B01三个必需命题分别为价格判断、尚未决定报名和仅在周末有空时询问工具。原始3条／42个字段逐项通过；V的3条／12字段、逐字证据和同候选lineage通过。独立重算必需raw3／接受3／完整3，最终auto、auto、pending；false_fact、wrong_person、bad_auto、歧义auto及未决审核均0。条件计划没有升级成已报名或已借工具。raw/full显式审核分别443.553秒、436.581秒，均在各自600秒内；审核等待也计入整批时限。

原event10的旧字符串matcher另报`passed=false`、`false_fact_count=2`，原件及packet.original_result完整保留。该matcher未按逐字引句形式匹配三条候选；这些计数不等于独立来源语义审核认定的内容假事，不能把两套口径混用，也没有将旧matcher改判通过。

V模型proof均null，程序证明仍UNKNOWN／scope_not_supported，source_bound=false、semantic_basis=null。单窗语义支持不是来源证明或生产放行；本场8窗分母仍为13条必需命题，核心两窗分母仍为5条，不能只报B01的3／3后删掉B02。

本场已确认响应中，B01 E／V及B02 E分别报告20453、75104、91715个reasoning tokens。provider事件文件落盘间隔分别约110.238秒、445.444秒、519.951秒；这些间隔包含传输及记录开销，不是服务端纯推理时间。慢响应和两阶段审核共同消耗总时窗；不延长本场截止、不重发未知V、不把关闭余额转给后继场。

## 关闭、完整性与后继边界

主Agent另以只读SQLite核对：run身份相同、closed标记存在、state.closed=1、请求序号1–4连续且全部端点为官方DeepSeek；精确自有worker／进程组18103已gone。新`finish.json`SHA为`b69bb03cea62ffa5a44e3ddfc87b833757a574b5714ac2c498ab57fe18a82b6a`，closed=true、close_unknown=false、worker_gone=true、automatic_successor=false。没有补建关闭状态、恢复原句柄或向已关闭台账发送。

原件留在忽略的`desktop/artifacts/remaining-public8-real-20261016-v1/`，包含freeze、绑定授权、19条事件、B01两阶段审核／收据、deadline-receipt与finish；不提交私有目录。实际命令为激活NotAlone Conda后，以`NOTALONE_DISABLE_DOTENV=1 PYTHONPATH=backend/src python -B desktop/tests/fixtures/remaining-public8.py launch`传入本场freeze、上述SHA和绑定授权文件。准备验证的122项后端、6项runner Mock、类型及两轴结果沿[方案末段](remaining-public8-plan-20261016.md)，不把离线检查算成本场模型成绩。

本结果片Standards硬违规0／可能smell0，Spec发现0；已采纳一项P3呈现建议，并列旧matcher与独立语义计数。最小复核包含冻结／四次预约／关闭SQLite、B01封存投影及机械重算、链接及分母；没有为结果文档重复模型或另跑产品测试。

旧run仍closed25／42、13窗完成、8窗unrun、必需完整9／15及A13安全类停止保持。本场B01不能抹去旧失败、拼成同一次14窗运行，或认证≥15用例的指代／逐维度门。三张记忆票继续claimed，Triage更新为ready-for-agent以继续已授权的离线修复；历史预算等待不再当作当前缺用户授权。下一候选先处理受控歧义的表达能力，见[显式v3规格](typed-ambiguity-v3-spec-20261016.md)，不改变最低置信度、评分政策、来源可信性或默认空放行。
