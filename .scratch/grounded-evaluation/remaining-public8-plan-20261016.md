# 剩余公开8窗的独立有界方案

日期：2026-10-16。主Agent已从原始human消息核验持续授权：必要的官方DeepSeek公开合成评测可建立合理有界的新台账，无需逐批再问。本场仍未读取凭据、创建／领取真实预算或调用模型。本文是新版本执行准备，不恢复旧run、不改旧审核、不预判未运行窗口。

## 范围与分母

旧run `0e5203b8-cfe9-4de4-bea9-9caba5ca76d5` 已closed：25／42次预约、零重试、13／21窗完成，17次未用余额永久关闭。A13原 `safety_error/contract_mismatch` 停止与全部sealed reviews保留，不能用本场补改成safe。详见[原部分结果](deepseek-public21-result-20261015.md)。

仅运行原21中确实unrun的8窗，先核心B01/B02，再按剩余A窗原顺序。原Gold仍完整21窗／28必需命题，不能删A14或把A15可选命题加进必需分母。

| 本场序号 | 原Gold位置（0起） | 原窗口 | 必需命题 | 可选命题 | 来源判据要点 |
| --- | ---: | --- | --- | --- | --- |
| 0 | 19 | B01 报价判断与条件咨询 | P1、P2、P3，3项 | 0 | 用户报价判断、尚未决定报名、仅在周末有空才咨询，分别核主体、期间与条件。 |
| 1 | 20 | B02 第三人历史经历与当前未知 | P1、P2，2项 | 0 | 表弟2024暑假历史经历与联系人当前不知道其工作，分别report和本人知识状态。 |
| 2 | 13 | A14 发地址 | 0 | 0 | 用户已抽查为none，仍计1窗；忠实pending也不算正确纳入。 |
| 3 | 14 | A15 借书看完 | P1，1项 | P2，1项 | 已读完必需；借书方向／所有权只作可选歧义审计。 |
| 4 | 15 | A16 面试结果 | P1、P2，2项 | 0 | 面试通过与下周一入职日程分别核；不补公司、职位或持续任期。 |
| 5 | 16 | A17 门票省略数量 | P1，1项 | 0 | 展览门票完成＋两张共同覆盖；不补购买者，不改变A13同类组去向规则。 |
| 6 | 17 | A18 跨消息第三人 | P1、P2，2项 | 0 | 老陈住天津和联系人住重庆分别核人物、语用和source。 |
| 7 | 18 | A19 跨话题拼接 | P1、P2，2项 | 0 | 红茶偏好和下周厦门参展分别核，不跨话题造联系。 |

本场13必需＋1可选；旧已完成子集15必需，15＋13＝28。主集剩余3窗／3必需，补充3窗／5必需，核心2窗／5必需分别报告。新8与旧13是两个run的观察，不能称为同一次完整21窗run，也不能据拼接结果抹去旧安全停止。

## 最小实现边界

原[官方入口](../../backend/src/notalone/memory_extraction/evaluation_ecnu.py)拒绝reference21的任意subset／非42预算，另限制旧诊断subset最多4窗；本次新增精确模式后，原两项门禁分别保留在第200–203、252–255行。旧私有`grounded_public21.py`同样固定21／42，且prepare／validate会访问registry；本次准备没有调用它们。现有[PhasedEvaluationAudit](../../backend/src/notalone/memory_extraction/evaluation_phased_audit.py)第219–245行已支持按唯一原Gold位置映射，不需要改Gold或评分器。

采用显式新`execution_plan=reference21-remaining8-v1`，只接受固定positions `(19,20,13,14,15,16,17,18)`、预算16、`case_set=reference21`、官方profile及grounded-v2／nullable-proof-v1／省略E和V tool_choice。原默认21／42、完整140、ECNU旧诊断≤4的合同保持。错mode、错位置、错预算或协议在预算／凭据之前拒绝，不提供任意subset功能。新mode／stage明确标记remaining8。

最小文件：现有`evaluation_ecnu.py`和其integration回归；新增`evaluation_remaining8_deadline.py`及unit回归；专用`desktop/tests/fixtures/remaining-public8.py`和纯Mock控制测试；本文。复用既有batch、持久预算、SDK、来源contract、记录和两阶段审核，避免复制大runner。执行控制只拥有本轮worker与原Budget，不新增通用预算管理API。

## 新台账、冻结和真实请求合同

新UUID、新私有0700目录／0600记录、新持久预算，最多16次真实HTTP。每窗E和V各至多一次；零候选按原合同不调V，不能把16当已执行数。HTTP错误、超时、连接失败、结构失败和未知均占预约，不退款、不重试、不换题、不自动后继。唯一端点`https://api.deepseek.com/chat/completions`，唯一请求及响应model `deepseek-flash`，`provider_profile=deepseek-flash-max`、thinking enabled、reasoning_effort max；不使用ECNU或响应别名。同步与异步transport共用同一预算，SDK和底层重试均0，禁止代理继承、重定向和额外探测。

凭据仍只在新预算成功create并batch领取后，由专用loader读取根.env已知三个官方provider键；不打印、落盘、注入其他进程环境或带进冻结。当前未打开真实.env，也未访问真实registry。默认维度放行为空，不连接业务PG、真实聊天、App、CLI或外部消息发送。

本次只读核对旧freeze的71个文件，71／71摘要一致；旧参考文件字节SHA为`5ab68ad8fbb48348231b27ae600ca011e47bf7fc2c1aa2f4e5b417bfa392d5a6`，canonical SHA为`5fb8d53b90a1a96c5987ac7b825bb233cc3e9f196f976e4851c40b0243b77b32`，中文判据SHA为`7039a302f64d6a14761ae448e425597c5ef46e0fbb3d7bc41c95c6d9a9b91e91`。旧freeze／结果／Gold保持不动；新入口是新代码版本，必须冻结实际新的完整closure，不能继续声称实现后仍与旧71逐字一致。

激活前冻结：新run与绝对时窗、精确8窗顺序及原Gold映射、逐窗公开input／实际E prompt／schema、V prompt／schema、所有实际执行源码（含新deadline／runner／审核桥及本计划）、安装版本、模式、端点、model、预算和时限。逐窗prompt／schema与旧对应窗比较，任何差异都单列；本场不改prompt或阈值。新输入仍使用原公开窗口，不能为获得proof补可信source元数据。每次发送前沿原contract复核实际字节／身份／冻结，漂移立即停批。

## 时限、先关闭再收尾

旧SDK／HTTPX `request_timeout_seconds=300`继续保留，但不是整次请求墙钟证明：旧A13 V两事件原件落盘间隔555.623秒已有实际证据。新增独立进程控制：单E／V调用从`invocation_scope`进入前以单调时钟计时，绝对上限600秒；同批所有请求、审核和工作总限2380秒，外层2400秒覆盖最多20秒收尾。到整批截止时不因最后一调用重新给600秒，剩余时间取更早截止。两阶段每phase仍最多600秒且受整批更早截止约束。

新mode领取后才启动本地daemon watchdog，持同一owned Budget。transport预约的SQLite短事务在网络前已结束（`evaluation_http_budget.py`第359–370行）；`close()`第304–313行不取网络锁，先持久closed标记再更新SQLite，适合此独立线程退场。新控制不改变生产默认或旧21的线程／时限。

单调用或整批超时、安全错误／meaning或safety未决、技术／结构／身份／冻结／记录失败均停批。先调用原Budget.close并fsync仅含run／计数／固定停止码／关闭状态的receipt，再退出当前owned worker；外层只处理自己spawn并记录的独占进程组，有限TERM／KILL及gone核对。关闭存储故障必须保留`close_unknown`，有限回收不能冒充预算已关闭；远端可能已经接收的请求也保持unknown，不退款或另开run补做。必须Mock证明close早于强退、超时后无下一HTTP、原失败和未运行分母保留；仅有SIGALRM或HTTPX参数不足以宣布控制已完成。

## 审核和确定性边界

复用原raw→sealed→full协议。每phase绑定新run／case／nonce／view SHA，主Agent依据实际公开source逐字段审核，先封raw再开放full，不能按V结果反改raw。新增审核只属于新8；旧A01–A13的视图、sealed reviews和分数不更改。一般错误保留后可按固定顺序继续；安全或unknown仍沿既有裁决停止，不降低bad_auto或混合去向门槛。

旧13窗显示的稳定部分是：15条raw的text、category、subject、topic、source、confidence合法性、两日期、figurative_type和interpretation_reason均人工pass，candidate_index／V逐字evidence均pass；完整契约仅9／15。这里的稳定仅指已观察子集，不预判新8。confidence合法不等于校准或auto覆盖。

可离线确定性复核的是完整labels→`compile_labels`→E14、source定位／顺序、有限值、时间计算、原sealed投影及评分：A03 kind映射成assertion而非report；A07通用alternatives遗漏两处歧义；A10漏方向解释和一项风险；A08 prefix最小confidence导致pending；A13混合去向由现有评分升格bad_auto。v2工具只有`unresolved`布尔，编译alternatives只生成一条通用未消歧说明，没有分别表达身份、所有权或借贷方向的字段；A07／A10的具体解释缺口不能只靠改标签prompt补全，须留给后续新协议／新冻结。它们可用原记录重放定位，不需模型，但不能在本场凭Gold直接重写label、补风险／歧义或抬confidence。任何后续确定性编译修复须独立TDD、版本与新冻结，不能覆盖这次基线。

程序proof旧15条均UNKNOWN（untrusted_source6、scope_not_supported9），模型proof均null。[source_proof](../../backend/src/notalone/memory_extraction/source_proof.py)第418–446行先要求单消息／单target／完整可信text来源，旧公开窗口为保留原摘要而缺此可信元数据，多消息另被范围门拒绝；第748–773行还要求受支持语法及实际proof。UNKNOWN是当前能力边界，不能改为false、verified或拿V supported代签E14。新增8保持同输入，不为了得分放宽可信、语法或proof门。raw-confidence与理想auto覆盖及A13组去向分类的取舍仍未决，未改阈值、prompt、Gold或评分器。

## 具体命令与真实启用前置

实现和Mock前先激活Conda：`source <CONDA_BASE>/etc/profile.d/conda.sh && conda activate NotAlone`，其中`<CONDA_BASE>`只由本机配置解析、不提交个人路径。现有可执行相关回归（在`backend/`）：

```sh
NOTALONE_DISABLE_DOTENV=1 python -B -m unittest tests.integration.memory_extraction.test_evaluation_ecnu tests.unit.memory_extraction.test_evaluation_provider_contract tests.unit.memory_extraction.test_evaluation_phased_audit tests.unit.memory_extraction.test_evaluation_batch tests.unit.memory_extraction.test_evaluation_remaining8_deadline -v
```

新增后执行专用deadline unit和`desktop/tests/fixtures/test_remaining_public8.py`的离线Mock；全部隔离临时home、禁真实socket／凭据／registry，验证官方固定8的实际SDK E/V形状、原guard不变、错pos／预算／模式提前拒绝、16后硬停、两阶段审计位置、每次／整批deadline、关闭故障及只收owned worker。完成类型检查和Standards／Spec双轴后才生成新真实freeze；不是仅写计划即可激活。

新增CLI现在具有`desktop/tests/fixtures/remaining-public8.py prepare <新私有目录> <带时区开始>`及`launch <freeze.json> <freeze SHA> <主Agent绑定授权文件>`两个明确入口；`worker`只供外层固定子进程使用，必须等外层先fsync owned-worker记录再经stdin放行，不能直接作为续跑命令。prepare只生成公开冻结，不调用旧prepare或读registry／key；launch才创建本场新台账。外层最多等待2390秒并预留至少10秒处理，TERM／KILL各最多1秒；以冻结绝对结束时间更早者为准。外层只接收精确run／PID／16上限的真实closed收据，空、异run或缺失收据均unknown。硬退没有完整result时，已开始窗保守unknown、未开始窗保留unrun，8窗／13命题分母不丢。

执行依赖现有本机忽略工具`desktop/artifacts/grounded-public21-prepare-20261015/grounded_public21.py`和`explicit_review_bridge.py`的已审纯函数／显式审核桥；两者纳入新实际源码freeze，不调用旧prepare、validate、launch、registry_snapshot或旧run。缺少它们时拒绝准备，不能悄悄补一个默认审计者。外层与worker必须在同一冻结版本，硬停止与清理receipt可被独立核对后，主Agent填入实际新run／绝对时间／命令摘要并唯一激活。实现、离线检查和双轴已收口，但新实际freeze尚未生成、没有创建真实run；真实入口仍未启用。

最终离线结果：相关后端122／122，19.862秒，其中官方／ECNU入口integration 67条、专用deadline 4条；runner Mock 6／6，4.171秒；3个源模块mypy无问题。日志分别为`desktop/artifacts/remaining-public8-final-related-v2-20261016.log`、`remaining-public8-final-outer-v2-20261016.log`、`remaining-public8-final-types-v2-20261016.log`。包括实际自有合成worker持久关闭后exit124、watch尚未调度时调用退场重新核600秒、公开8窗原Gold两阶段映射、无home准备、授权／漂移拒绝、owned放行、超时收尾、leader先退而同组后代仍活时的有限回收，以及异run关闭收据拒绝。原缺入口、准入、放行及两个审查回归的红灯日志保留。Standards／Spec独立审查各发现1项P2，均red→green后增量复核剩余0；可能smell 0。这些Mock不是真实8窗成绩。

本次读取公开合成source、旧closed结果／freeze及代码，并实现上述7文件准备片；仅临时home合成预算和自有合成worker。未读取真实凭据或registry，未建真实预算、调用模型、操作GUI或提交。后续结果按本场8窗／13必需和旧13窗／15必需分别报告；未完成继续unrun，不宣称生产质量、完整21同run、完整140、旧留出通过或自动放行。
