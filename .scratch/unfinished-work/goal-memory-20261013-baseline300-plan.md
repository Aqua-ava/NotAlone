# 持续目标：第三次及最后一次固定当前基线预注册

[同d54 V技术探针](goal-memory-20261013-V-payload300-result.md)取得一次合法响应，因果仍未知；前两次21窗基线分别因60秒重试与180秒无重试的V读超时终止，没有有效当前语义基线。Root只授权准备这一次新的完整21窗控制组，**不注册、不发送至最后冻结通过**。若本次不完整，闭账并停止新基线，不自动第四次重跑。

## 不复用余额的480修订

原未创建comparison run `c02248b0-ad08-4d09-9fb7-edf21539081a` 的96用途撤销，分为本次`baseline300` **42**与未来候选 **54**。未来唯一run预先冻结为`02e6662f-ce11-4d28-be10-b66b1ef30e13`，保持未激活/未注册；不是在当前baseline里开启第二模型阶段。本桥入口核本次和候选注册缺席，运行期每次审核还核候选未注册。

不可变`goal-budget-amendment-v3.json`引用原索引、v2（v2引用v1），旧文件全部保留。总480＝技术6＋旧基线42＋旧V3＋第二基线42＋新V2＋本次42＋未来54＋全窗280＋未启用预留9。所有五个已闭run真实累计14；关闭余额38、2、40、1永久关闭，不退款、补位或挪用。原comparison96不能再作为单独活配额存在，全窗280、预留9和未来54不自动启动。

只有本控制组全部完成、取得实际固定21窗失败信号之后，才能准备最小修复和另一个具体冻结的54次候选对照，再经Root批准。该设计明确复用本次已冻结控制组A，不声称84次交错paired实验；未激活54的提示/源码/失败子集/停止条件尚未确定，不能把它当已预注册语义改动或成绩。原质量门槛及逐维度用户批准要求保持。

## 固定资料、参数、时段与审核

仍是原A01–A19、B01–B02顺序与公开合成窗口，28必需命题＋A15可选命题，全部Gold、来源、时间、标签分支和门槛不变；不删难例、不改答案、thinking、E/V提示/schema、供应商或生产默认放行表。Gold规范SHA`5fb8d53b90a1a96c5987ac7b825bb233cc3e9f196f976e4851c40b0243b77b32`，文件SHA`5ab68ad8fbb48348231b27ae600ca011e47bf7fc2c1aa2f4e5b417bfa392d5a6`，标注SHA`7039a302f64d6a14761ae448e425597c5ef46e0fbb3d7bc41c95c6d9a9b91e91`。原日期required槽修复和评测参数工具修复沿当前代码，不增加产品功能。

唯一ECNU、ecnu-max、temperature0、stream=false、thinking enabled、具名E/V工具、fallback=false。调用现有公开`run_ecnu_evaluation(request_timeout_seconds=300.0,max_retries=0)`，相同300/0进入冻结配置、双HTTPX及实际ChatDeepSeek；API内部stage仍P1，外部持续目标用途才是baseline300。已观察service alias deepseek-v4-flash与请求模型分列，不认证权重身份。

场次固定台北2026-10-13 **03:25–05:25**（UTC前日19:25–21:25），每HTTP起发须早于**05:19:15**（300＋45秒余量），原contract在持久预约前拒绝逾时。read300不是单请求总墙钟限；外部桥另设覆盖实际batch、审核与API收尾的绝对05:25 SIGALRM，作为generic timeout停止/未知，不算read_timeout可续发；已有alarm拒绝覆盖，退出或异常还原alarm/handler。场次不滚动延长。

raw/full每相审核最多300秒并在读取前后复核期限，仍先E逐事实14字段、28命题/分支/来源/时间和全部额外/重复/排除/禁止项显式审核，持久封存raw后才能揭V四字段、lineage、程序最终层和去向。没有自动全pass，full不能回写raw。一般语义错误如实继续固定窗，安全/unknown、运行/HTTP契约失败、审核缺失或迟到、源码/版本/配额/记录或收尾漂移立即停止并闭账，保留分母和未运行。

原matcher/oracle与显式raw/accepted/full分别记录。`evaluate_case`去向是原三门的评测内理想auto/pending/none，不写业务，生产维度默认放行仍为空；V=supported不能救E错误，完整21窗也不能自动签质量或放行。整理者已读历史输出，不冒称首次盲审或真实核心6/12；所有本轮输入仅既有公开合成，无私人聊天范围扩大。

## 当前冻结与最小验证

- 外部0700根`/private/tmp/notalone-memory-goal-20261013-ac04d687/`；`baseline300.py`、`baseline300_selftest.py`、`baseline300-plan-v1.json`、`goal-budget-amendment-v3.json`及准备/测试记录均0600。未来输出`baseline300/`和`baseline300-reviews/`另建0700，不覆盖任何历史记录。
- runner SHA`fd3f7b338c95eb63f7b6520ecfd0939394d9f4ada20548c7e113718a5a305e10`；bundle规范SHA`79b4c2ffca83a1636b02b6ec5f6f9f12f11cb3c3d6b6e90a95389653c560814c`；amendment-v3规范SHA`dcc1e694b3672a0fa15fe1fa52268838b16fa140913f35ad500daeb6e318bb26`；自检SHA`0a6ac779d5459a7d69f3a1f78f29bfab450b4a3dbdf9b58333f5953261f4c50e`。
- source commit`4c06c0e9042cb1ee2d69a4e0e3e98eab3702637e`，60必要源＋公开Gold与该blob/当前工作字节核同，含52d评测300接缝和d488日期修复；新server/desktop主题不在60内。8已冻结依赖版本沿前阶段不变。五closed收据/hash实核6/6、4/42、1/3、2/42、1/2，当前目标真实14、driver600.345202秒，关闭余额不复用。
- 继承既有桥负控，新增最后control角色/原96撤销、候选54提前注册拒绝、绝对wall timer异常还原和已有alarm拒盖，共**23方法首绿0.298秒**、mypy通过，无伪造本轮red。每HTTP345秒负控经原contract＋EvaluationTransport精确Mock，预约0/dispatch0/闭账；300/0真实入口参数交接、阶段迟到/跨读取拒绝、closed/records未知null与main失败1仍覆盖。
- 自检禁默认HTTPX/HTTPX2 transport、socket/DNS及真实credential，所有Mock预算在隔离临时home清理；没有注册本次/候选UUID、加载.env或增加真实HTTP。SIGALRM测试只核恢复和拒盖，不实际等两小时，也不冒称真实deadline现场已验。

现有Agent独立Standards和Spec最终均0项，各自只读核了4个SHA、60源/4c06 blob、21Gold、五closed14、480表及两个UUID注册缺席；未运行桥/测试/App/HTTP/密钥，不能代签实际deadline。待Root最后hash/60源/21Gold/五闭账/480配额/两个注册缺席/实时时间核验后才可唯一激活。本片准备新增真实HTTP**0**；当前累计**14**，完整有效基线**0**。
