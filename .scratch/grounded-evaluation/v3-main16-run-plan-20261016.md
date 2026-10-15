# v3固定指代主集16窗的独立运行准备

日期：2026-10-16。Triage: ready-for-agent。State: resolved。当前交付仅为实现与离线验证；没有创建真实预算、读取凭据或发出模型请求。主Agent独立核对实现、冻结与授权绑定后，才唯一launch；没有自动后继。resolved只表示准备切片完成，不代表16窗已运行、原07或三张记忆票已完成。

## 范围与证据

旧公开21部分场、remaining8场及两个v3两窗场均保持各自closed及原审核。最新guidance两窗的A07/A10成功只属于该场2窗／3必需命题，不能拼进本场或凑成至少15窗。A03的kind指导由独立切片处理，完成审查后本场冻结其实际提示；当前准备不预判模型效果，也不把历史freeze与新代码差异称为旧运行故障。

本场固定原reference21的positions `(0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15)`，即A01–A16，原顺序16窗、18必需命题＋A15的1可选。A12／A14各零必需但仍计窗口分母，不因空E跳过窗；空E不调用V。A17–A19三语义补充（positions16–18、5必需）及B01／B02核心（positions19–20、5必需）明确排除，不重发旧B02 unknown V，不据此签核心、reference19、完整21或完整140。原完整Gold、中文判据及其摘要保持，不为本场复制或删改Gold。

## 固定执行合同

新增唯一 `execution_plan=reference21-main16-v3`；case_set仍reference21，精确16位置、request_limit=32、grounded-v3、nullable-proof-v1、E/V tool_choice omitted、provider_profile=deepseek-flash-max、HTTPX300秒与max_retries=0。请求及响应model必须deepseek-flash，唯一端点为https://api.deepseek.com/chat/completions；不继承代理、重定向、fallback或额外探测。固定label_policy=`v3-kind-guidance-v1`，表示本场包括已审多选／金融敏感性及kind单叶；不增加任意policy入口。

每窗E和V各至多一次，所有失败及远端未知占预约，不退款、不重试、不补位、不借用任何closed余额。新的UUID、0700目录、0600记录及持久预算只由主Agent后续明确启用。本阶段prepare只操作公开材料与临时目录，不能访问home／registry／key；凭据仅在真实新台账成功领取且fresh claim复核之后读取一次既有官方三键。

外层绝对43200秒（12小时），工作43180秒，留20秒收尾；prepare到launch消耗同一带时区绝对时窗，不重新给时限。每E/V绝对600秒，raw/full各600秒，均受整批更早截止；12小时只为一次完整机会留余量，完成即退，不等满。16×四阶段×600=38400秒，余量覆盖本地流程，不承诺实际耗时。一般错误保留后按固定顺序继续；safety、语义unknown、技术、结构、冻结、供应商、记录或权限错误立即停批。

复用现有owned deadline／进程组、Budget、SDK、显式两阶段审核桥与原评分。先持久close并fsync关闭收据，再退出自有worker；关闭失败保留close_unknown。外层仅有界TERM/KILL自己spawn且记录的独占进程组，核gone；异run／PID／cap或缺失收据不能充当closed。hard stop时已开始未封窗unknown、未开始unrun，16窗／18必需分母保留，不自动重启。

## 实现与验证接缝

新增固定16 runner／测试、最薄专属deadline／测试；只在evaluation_ecnu及owned固定profile加入该精确模式。保留原original21／42、remaining8／16、ambiguity2／4、完整140与ECNU旧≤4守卫，不开放任意subset。PhasedEvaluationAudit复用原positions映射，不改审核或评分器；生产装配、v2、V、原三门与维度合取门、0.7、默认空放行表及typed proof保持。

TDD沿run_ecnu_evaluation、prepare／validate／worker／launch、专属deadline接口：正确scope和实际SDK装配；错误位置／mode／cap／model／policy／旧模式放宽／到期在预算和凭据前拒绝；零V、技术／unknown／safety停、一般错误续行；call／总时限先关闭、关闭故障、owned回收及异收据拒绝。仅临时home、合成预算、自有合成worker与MockTransport，禁真实socket／凭据；Mock不是模型质量。完成相关单元／集成、类型和Standards／Spec独立审查后由主Agent生成实际新freeze。

实际freeze须纳入runner、专属／共享控制、审核桥、实际源码closure、安装版本、原输入／Gold、逐窗实际E prompt／动态schema、V合同及本计划、已审guidance／kind计划。准入逐项核对精确集合和实际字节，不使用旧79份历史集合冒称新集合；源码／prompt／schema漂移在凭据或下一请求前拒绝。

## 结果口径与排除项

新prompt必须重验包括旧passed在内的全部选定16窗，不能沿用旧通过。分别报告模型labels、编译E14、raw／程序接受／完整契约、V与UNKNOWN proof、auto／pending／none、计划／完成／unknown／unrun；既有matcher与来源语义审核分开。ADR-027至少15窗、假事0、记错人0、一般错误≤1不能通过命题数、重复样本、跨run拼接或pending安全替代。即使主集过门也不等于原07全部140旧例回归、真实泛化、typed依据可用或逐类放行；默认空表保持。

不改Gold、阈值、A08最低置信度、A13混合去向安全分类、旧审核／成绩／预算，不迁移／回填、不接业务PG或私人聊天，不操作App／微信／真实CLI或发送消息。本片不提交，由主Agent集成后创建任务专属本地提交。

## 离线结果

固定实现起点为`0b8c97d3d264b331b68a72f39ea38fbd67ab8729`。A03四行kind指导另由主Agent提交`d7edd308`，本片不改该三文件，临时prepare测试已读取其实际当前提示；真实freeze仍由主Agent最后生成。

先红后绿依次证明：新execution_plan未准入；真实入口未要求专属deadline／类缺失；worker未有32次领取profile；fixed元数据的bool／float以及plan／Gold位置bool不能靠Python宽松相等冒充精确原值。最后以canonical摘要比较fixed／plan／selection，预算与凭据前拒绝，不放宽旧入口。日志为`desktop/artifacts/v3-main16-red-admission-20261016.log`、`v3-main16-red-deadline-20261016.log`、`v3-main16-red-sdk-worker-20261016.log`、`v3-main16-red-exact-fixed-types-20261016.log`、`v3-main16-red-position-types-20261016.log`及对应green记录。

完整memory_extraction单元452／452（6.450秒）；ECNU／offline／SDK预算／wire相关集成108／108（21.308秒）；三个固定runner合计20／20（8.150秒），合计580项通过。最后仅加固新runner的位置类型比较后，该runner7／7（4.759秒）再过；4个修改源模块mypy通过，`git diff --check`通过。日志分别为`v3-main16-final-unit-20261016.log`、`v3-main16-final-integration-v2-20261016.log`、`v3-main16-final-runners-v2-20261016.log`、`v3-main16-green-position-types-20261016.log`及`v3-main16-final-types-v2-20261016.log`，均在本机忽略产物目录。

首轮整组的SDK／wire模块名使用了不存在的缩写，出现2个ImportError；核对真实模块名后以上108项已实际通过。新增deadline进入当前ecnu源码闭包，使原ambiguity2当前prepare为80项；旧测试硬写79曾失败，现只修正当前prepare测试并断言新模块入闭包，旧79项真实freeze和对应历史计划不改。另一个离线候选尝试给record config加policy，被原`invalid_record_freeze`拒绝；该候选撤销，保留原records键集，policy只在新fixed freeze中固定，并由实际来源／prompt／schema摘要绑定，没有扩大records协议。

实际SDK经MockTransport完整跑16E＋14V，A12／A14零候选无V，共30次占32上限，16窗raw/full按A01–A16映射，受控一般错误续行后关闭。独立控制另验证33次拒绝且失败不退款、技术／unknown／safety停批、600秒调用及raw/full、总限更早、close失败unknown、正确owner落盘后放行、worker leader先退仍收同组后代、外层到期有界回收及错误cap收据不当closed。所有预算与worker仅为临时home合成测试，不是真实模型或语义成绩。

Standards独立初审及类型硬化增量均明确违规0／判断性smell 0，Spec独立初审及增量均0。交付未提交，未创建真实预算／授权文件或运行目录，不读真实凭据、私人聊天或业务库，不操作桌面／真实CLI。默认产品、V、门、typed依据、Gold、评分和旧原件未改，模型收益及主集质量仍待唯一新场实际验证。

全部Python命令先激活Conda `NotAlone`并设置`NOTALONE_DISABLE_DOTENV=1`。在`backend/`执行：

```sh
python -B -m unittest discover -s tests/unit/memory_extraction -t . -v
python -B -m unittest tests.integration.memory_extraction.test_evaluation_ecnu tests.integration.memory_extraction.test_evaluation_offline tests.integration.memory_extraction.test_evaluation_sdk_budget tests.integration.memory_extraction.test_evaluation_wire_contract -v
python -B -m mypy src/notalone/memory_extraction/evaluation_ecnu.py src/notalone/memory_extraction/evaluation_owned_process.py src/notalone/memory_extraction/evaluation_main16_deadline.py ../desktop/tests/fixtures/main16-public.py
```

在仓库根目录执行：

```sh
PYTHONPATH=backend/src python -B -m unittest discover -s desktop/tests/fixtures -p 'test_*public*.py' -v
PYTHONPATH=backend/src python -B desktop/tests/fixtures/test_main16_public.py -v
git diff --check
```
