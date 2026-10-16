# 原公开21窗当前v4：离线实施记录

Triage: ready-for-agent
State: resolved

依据[固定计划](reference21-complete-v4-plan-20261016.md)，本次只增加原公开21窗的独立评测执行身份。真实批次须在实现、验证、独立审查、本地提交及扫描完成后，由Root最终核验并唯一启动；下文分别记录实际通过与失败，当前未创建真实预算。

## 固定范围与接缝

执行身份为`reference21-grounded-v4-source-v2-v-off-forced`，完整原positions 0–20、A01–A19及B01／B02，28必需＋1可选；不筛选、重排或改写输入。使用当前`grounded-v4`（包括`stable_fact`及`continuation`）、已审`source-fidelity-v2`参考和`nullable-proof-v1`。沿用`deepseek-phase-split-v1`，E为enabled／max／omitted，V为disabled／none／forced；只使用官方DeepSeek `deepseek-flash`，cap42、零重试。

既有公开接缝已经在计划中确定：准入与领取、实际SDK HTTP传输、离线E→V→Flow及分层审核、自有进程与截止、持久化记录。SDK Mock只替代外部HTTP；预算、编译、来源核验、审核和关闭使用实际实现。RAW／FULL控制验证审核合同，不将合成审核结果作为真实语义质量。

新mode为`deepseek_bounded_reference21_v4_source_v2_v_off_forced`，stage为`reference21-v4-source-v2-v-off-forced`，owned kind为`reference21-v4-v-off-forced`。使用新固定runner与薄deadline，工作14380秒、从prepare起绝对14400秒；每调用及RAW／FULL各600秒，HTTP读取300秒，较早总体截止优先，外层保留20秒关闭余量。完整运行结束或既定硬停即闭账，不自动后继。

源码闭包按实际依赖计算，包含新入口、控制、计划及本记录、public21-v2 JSON及中文判据、实际helper／桥、当前v4及两项补全规格和ADR；不照抄旧闭包数量，不将未读取的完整140参考算作原21的必需依赖。领取、凭据、请求与审核的冻结校验范围以实际实现为准，测试及审查后补记，不提前扩大声明。

## 数据与完成边界

准备只使用公开合成输入、临时home、Mock及自有合成进程。新执行身份的真实注册、凭据读取和网络调用由Root另行负责；九个旧场及其未知请求、参考、成绩和关闭记录保持封存。新21不借旧32／280身份或余额。

不改Gold、评分器、typed proof、生产默认`grounded-v2`、采纳门或空放行表，不读取真实聊天、不做GUI或外部聊天发送。结果须分报原主集、补充及核心；≥15窗不能用命题数或跨场拼接替代，公开合成不能代签原私人核心目标。本准备不完成三张记忆原票。

## 验证与审查

已完成固定入口、薄deadline及六模块装配，当前实际闭包86份、全部存在且不含full140参考。prepare／validate核输入、来源参考、动态合同、版本及源码；每次真实传输前沿现有provider再核源码和wire。RAW／FULL审核桥继续原显式收据合同，不宣称每个桥回调都会额外核源码。

实际红绿：prepare缺入口→绿；SDK缺worker→真实E／V Mock绿；`execution_plan=[]`的TypeError→显式str门拒绝转绿；当前旧fixture动态闭包81→82真红→新增deadline断言转绿。四对日志为`desktop/artifacts/reference21-v4-{prepare,sdk,admission,closure}-{red,green}-20261016.log`，均保留原失败。

新边界单元8项、新runner6项通过。完整SDK Mock到B02，21E＋19V＝40／42、21窗和42个审核阶段、closed；仅给定A12／A14空E，一般错误仍续行。实现者ECNU＋offline集成101项通过（44.631秒），所有公开runner57项通过（227.347秒，含新旧21／16／140等固定入口），8源码／runner的mypy通过。Root独立完整评测集成112项通过（75.727秒），session43668已exit0。各组分别记录，不相加成质量样本。

命令均先激活Conda `NotAlone`、禁dotenv；集成指定模块在`backend/`执行，discover在仓库根目录执行：

```sh
NOTALONE_DISABLE_DOTENV=1 PYTHONPATH=src python -B -m unittest tests.integration.memory_extraction.test_evaluation_ecnu tests.integration.memory_extraction.test_evaluation_offline -v
NOTALONE_DISABLE_DOTENV=1 PYTHONPATH=backend/src python -B -m unittest discover -s desktop/tests/fixtures -p 'test_*public*.py' -v
NOTALONE_DISABLE_DOTENV=1 PYTHONPATH=backend/src python -B -m unittest discover -s backend/tests/unit/memory_extraction -t backend -p 'test_evaluation*.py' -v
NOTALONE_DISABLE_DOTENV=1 PYTHONPATH=backend/src python -B -m unittest discover -s backend/tests/integration/memory_extraction -t backend -p 'test_evaluation*.py' -v
```

## 准备阶段捕获的自有进程回收错误

实现者相关unit广组97项有2个error：误列不存在的`unit.test_evaluation_offline`加载项，以及旧full140外层超时控制的`killpg(pid,0)` EPERM；该组不能记通过。此前新增21超时单项也出现过一次相同EPERM。两次均未留下失败PID，不能补签其退场；后续只读测试脚本签名扫描0只说明未发现匹配脚本。

新／旧outer有限复跑2项通过，随后Root独立有PID诊断新旧各2次也通过：76427／76428／76468／76471各自退出，PG均ESRCH、源码SHA不变，日志`reference21-v4-owned-permission-probe-20261016.{py,json,log}`；这些证据只证明各自那次回收，不补签旧失败。

Root完整评测单元实际203项、56.906秒、1个error，再次在新21 outer的同一`reap_owned_group`循环遇到EPERM，session95562已exit1；该组仍未通过。因此真实批次保持未创建，并继续收紧真实自有进程接缝的诊断，不将三次错误写成系统偶发已解决，不把EPERM当ESRCH，不终止未知归属组。最终修复、红绿、复验及独立增审须在下方另记。

以`3a3631ae085920ce20670a3f213b8c034657f0c8`为固定基点，17个任务范围文件的Standards／Spec独立初审各0项；Spec独立10项最小控制通过。首次清单漏列的旧fixture闭包断言已单独双轴补核0项。该初审不覆盖当时尚未实现的进程回收修复，也不表示上述失败回归已通过；当时本记录仍claimed，最终修复及完成证据见后文Answer。

## 重复实证与最小修复决定

在未改源码的真实owned launch接缝，新旧各10次的记录型探针捕获6／20次PermissionError：新2／10、旧4／10。20次命令exit0只说明完整记录，不能说20次launch已全绿。六个已留自有PID77791／77810／77818／77839／77847／77849均在TERM／KILL已成功后的signal0阶段出错，此前returncode为None；随后的getpgid均ESRCH，0–1毫秒内poll得到-15／-9并实际killpg0得到ESRCH，最终20个已留组均不存在。日志／JSON／脚本为`desktop/artifacts/reference21-v4-owned-race-diagnosis-20261016.*`。三次更早失败仍未知PID，不能由这六例补签。

本机macOS15.7.5／Darwin24.6.0；[Apple同基线XNU的killpg实现](https://github.com/apple-oss-distributions/xnu/blob/xnu-11417.140.69/bsd/kern/kern_sig.c#L1608)过滤SZOMB后，可在可处理成员数为0时返回POSIX EPERM。该公开基线是机制佐证，本机额外补丁tag未公开，不能冒称完整匹配；实际短暂错误与后续退出以六个PID的记录为证。[Apple手册](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/killpg.2.html)区分EPERM与ESRCH，也不能单凭权限错误认定已退出。

第一版修复只改`owned_group_exists`的无信号存在查询：最多100毫秒、每10毫秒poll及查询，PermissionError期间保持未知，后续真实ESRCH才返回不存在，真实查询成功仍返回存在；持续错误到界抛回原错误，实际发送TERM／KILL失败仍立即抛回且不补发。不新增信号、其他组或HTTP重试，不放宽worker／budget关闭、不延长原外层截止。该版后续控制及Root捕获的新失败如下，不能据此版单独认定收尾完成。

上述第一版修复的瞬态launch测试clean-red为1test／2subcase errors，green为1test／0.842秒；更早第一次红的测试自身finally又遇getpgid ESRCH，原日志保留，清理仅针对已知child且处理明确ESRCH后重新捕获clean-red。持续查询错误、TERM／KILL失败负控及owned组12项通过（20.139秒）。同原20次实际回放的launch错误0／20，全部最终ESRCH；系统实际EPERM仍有launcher内4次、诊断追加4次，不宣称系统错误消失。红场pre源码SHA是后来按唯一函数逆变换重建，并非当时实录；汇总明确该来源限制。mypy本模块及Root八文件均通过。

Root随后完整评测单元206项（47.951秒）仍有1个error：旧`test_full140_reaps_owned_descendants_after_leader_exit`在leader已退场、同组后代收尾时超过100毫秒仍EPERM，session87860已exit1。该次未通过，构成第四次未留下失败PID的历史错误；此前20次不含此fork场景，不能代签。当时保持claimed及零真实预算，继续对真实fork／leader先退场接缝保留leader与后代PID、实际信号和存在查询时间；第一版修复及其增审0项不能覆盖此失败。

真实fork的新旧各5次诊断现已完成，源码未改：十个leader均rc7，后代最初PPID1、同PGID、stat S，忽略TERM后KILL成功；launch错误0／10、最终全部实际ESRCH。其中4次原始EPERM的首错误到ESRCH观察为19.486–29.631毫秒，其他KILL到ESRCH为10.377–12.617毫秒。只读ps仅查本轮两个PID，但其耗时包含在观测值中，EPERM后ps已无行，没有捕获Z；不能把数字当纯内核zombie寿命，也未复现Root超过100毫秒那次。文件为`reference21-v4-owned-fork-diagnosis-20261016.{py,json,log}`，不补签第四次历史PID。

随后选择最小修订B：普通`owned_group_exists`仍默认100毫秒；reap发出信号后的查询使用原已存在的`end=monotonic()+1`绝对截止，消除嵌套100毫秒先中断的结构缺口，而非每次增加等待或延长外层。未知到同一截止仍抛首错误，不发送下个信号；只有真实ESRCH才gone。真实fork接缝的200毫秒EPERM后恢复实际OS控制，只能证明较长瞬态在既有观察期内可处理，不能证明历史第四次的具体原因。before-signal100毫秒、持续到1秒、TERM／KILL失败负控继续保留；测试异常仅追加已知自有PID／kind的note以免未来再丢归属，生产记录不改。实际红绿及完成证据如下。

## Answer：最终离线收尾

B修订在真实fork／leader exit7接缝将KILL后查询边界维持200毫秒EPERM，再恢复实际OS：原实现clean-red为1test／2errors，修订后1test通过（3.157秒），新旧两个subcase均由真实ESRCH认证退出。受控红已留leader88331／88333，后续实际零信号查询均ESRCH；它们只证明这些受控资源当前退出，不补四次历史未知PID。

最终owned组14／14通过（22.093秒），含普通查询100毫秒、同一发送后1秒截止、首错误保留、不因未知推进信号及TERM／KILL不补发负控。原fork新旧各5次复验10／10 launch成功，全部最终PG实际ESRCH，仍有4次原始EPERM；文件`reference21-v4-owned-fork-diagnosis-green-20261016.{py,json,log}`独立保留，不覆盖此前失败。该修复不宣称消除OS错误或解释历史第四次原因。

Root最终完整评测单元208／208通过（45.440秒，session6617已exit0），8个控制源码／runner的mypy通过（session90643已exit0）；日志分别为`reference21-v4-root-evaluation-unit-final-20261016.log`及`reference21-v4-root-types-final-20261016.log`。此前完整集成112、公开runner57、完整SDK Mock40／42均按上文各自范围保留，不重复累计；B只改owned收尾及测试，不改变E／V、参考或评分。新增失败诊断使两次Root完整单元未通过，均保留原日志，最后208通过不重写它们。

上述单元discover命令保持；类型命令在根目录、Conda NotAlone、禁dotenv与`PYTHONPATH=backend/src MYPYPATH=backend/src`下为`python -B -m mypy --follow-imports=silent`，检查六个修改evaluation模块、新`evaluation_reference21_v4_deadline.py`及新固定runner。owned最小命令在`backend/`为`PYTHONPATH=src python -B -m unittest tests.unit.memory_extraction.test_evaluation_owned_process -v`。

独立Standards／Spec初审均0，已补第17文件；两次owned增审分别覆盖100毫秒初版及复用原1秒绝对截止的最终B，两轴剩余均0。Spec独立最小控制及各增审证据范围分别记录，不算真实质量。最后验证／状态文档仍须窄核与纯prepare，其结果另补；真实预算／请求当前为0，Root在文档、本地提交、扫描和最终新冻结核验后唯一启动。

本离线实施已完成，原21模型质量仍待本场实际审核。四个早期未知PID、未公开的本机XNU额外补丁及后重建的preSHA限制仍保留；本机已审helper仍为实际依赖，不声明干净checkout可独立复现。没有真实聊天、业务库迁移、产品采纳或远端Git，生产默认、空放行表和三张记忆原票保持。

上述最终文档及源码稳定后，纯prepare与首窗实际SDK Mock两个最小用例通过（1.316秒，session18925已exit0），临时home、禁止真实凭据／网络；仅SDK合成E／V及审核unknown即闭账。当前86份闭包、10个本地文档链接、owned最终源码SHA及Root只读preflight语法另核通过。这里不生成真实预算、模型质量或新场启动事实。
