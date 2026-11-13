# 持续目标：超时诊断后的新21窗基线预注册

这是[原基线技术终止](goal-memory-20261013-baseline-result.md)和[V180秒诊断成功](goal-memory-20261013-V-diagnostic-result.md)之后的新实验准备。前两阶段不构成有效语义基线；累计真实HTTP为11次，原基线余38及V诊断余2已永久关闭。新的实际基线尚未启动，不能把工具、Mock或单个supported结果签作质量。

## 有限配额与时间

Root将原5run索引中**从未注册、从未发送**的反序run `ae0add54-7f6e-4033-b1e6-37e3a400748f`、硬上限42，改用于`baseline_after_timeout`。这是未激活用途的显式不可变修订；原反序阶段撤销，不再另有42次反序配额。不挪用已关闭38/2，不换UUID补位，不重开任何旧run，原索引和全部旧计划/失败保留。

外部修订`goal-budget-amendment-v1.json`固定总上限480：技术6＋原基线42＋新基线42＋候选对照96＋全窗回归280＋已闭V诊断3＋尚未启用预留11。关闭余额仍占各自原上限，不退款。新run注册目录在冻结前必须不存在；入口也拒绝已经注册但未领取的同ID目录。后续对照、回归和预留不自动启动。

台北时间场次固定为2026-10-13 **02:40–04:40**（UTC前日18:40–20:40），不是从实际启动滚动延长。HTTP每次起发截止**04:36:15**（UTC20:36:15），留180秒读限＋45秒收尾余量；已有ECNU契约在每个发送前检查这一截止，达到时在持久预约与transport之前停止。审核与最终观察的绝对截止仍是04:40。请求读超时180秒，SDK和底层transport重试均0；HTTP读限不冒称单请求总墙钟上限。阶段审核等待仍最多300秒，读取前后复验阶段与场次期限。任何超时/未知/契约/源码漂移/审核缺失或迟到/持久计数或收尾故障停止并闭账，保留所有未知及未运行。一般语义错误按原审核程序记录并继续固定21窗；安全错误和未决停。

## 不变材料与实际配置

仍使用原固定A01–A19、B01–B02：16主reference、3公开reference补充、2公开核心观察，顺序、28个必需命题、A15可选命题、Gold及全部门槛不变。Gold规范摘要`5fb8d53b90a1a96c5987ac7b825bb233cc3e9f196f976e4851c40b0243b77b32`，文件摘要`5ab68ad8fbb48348231b27ae600ca011e47bf7fc2c1aa2f4e5b417bfa392d5a6`，标注文件摘要`7039a302f64d6a14761ae448e425597c5ef46e0fbb3d7bc41c95c6d9a9b91e91`。不删除难例、不改答案、提示、thinking、E/V schema、供应商、语用或默认空放行表；原缺日期槽fail-closed修复与[评测180/0配置修复](goal-memory-request-limits-20261013.md)已进入当前源码。

唯一请求仍为ECNU endpoint、`request_model=ecnu-max`、temperature0、thinking enabled、具名E/V工具、fallback=false。服务响应在V诊断报告的`deepseek-v4-flash`只是观察到的alias，与请求模型分别记录，不认证实际权重身份。180/0通过现有公开评测入口参数进冻结配置、两个HTTPX客户端和实际ChatDeepSeek；不通过monkeypatch伪记配置。实际依赖冻结为openai3.3.1、langchain-core1.5.5、langchain-deepseek1.1.0、langchain-openai1.5.1、httpx0.28.1、httpx2 2.12.0、langsmith0.11.0、pydantic2.13.4，发送前有源码守卫、每个审核阶段另核安装版本。

raw只揭E和固定公开判据，逐候选14字段、命题语义/完整性/分支/来源/时间、重复/额外/排除及禁止项显式审核；没有默认全pass模板。原`PhasedEvaluationAudit`验证并持久封存raw后才揭V四字段、程序最终层、lineage与实际去向，full不能改封存raw。整理Agent已读历史输出/标注，不冒称盲审、真实核心6/12、生产质量或逐维度放行。原matcher/oracle、raw、accepted、full和安全/未知另报；V的supported不能补救错误E字段。所有输入是已有公开合成资料，没有真实聊天上传授权或业务资料读取。

这里的程序去向是`evaluate_case`按原三门计算的评测内理想`auto/pending/none`，不叠加生产维度放行门，不写业务记忆。生产默认放行表仍为空；模型质量证据和03票运行字段必须另外逐项核验，并经用户逐维度批准后才可放行。

## 冻结与最小验证

外部唯一目录`/private/tmp/notalone-memory-goal-20261013-ac04d687/`为0700。新增`baseline_after_timeout.py`、`baseline_after_timeout_selftest.py`、`goal-budget-amendment-v1.json`、`baseline-after-timeout-plan-v1.json`及准备/回归记录均0600；原桥、计划和收据原样保留。未来输出单独写`baseline-after-timeout/`及`baseline-after-timeout-reviews/`，不提交正文、headers、思考或凭据。

- runner SHA`7e932eeb0eac6fdbefdeb9ca4718beeeb45b0898a033b234facb5665516a5f0a`；bundle规范SHA`3f534f571c86028b922f183f50022b8209c2c57dc990304c3c5686269689e2da`；amendment规范SHA`3bffefa52f497aab1e924be23d1ca5c8a7364675b08671c9a9db530b4ae15bec`；自检SHA`169a20fa672d255cbf42e8b39e2380454197ba91e2fb6d3324c0baa67d03016f`。
- 冻结提交`15876c41452eb57fa101165b45b7840c95fb7451`；60源逐字节与该commit/blob相同，含当前`52d17fa1`评测参数和`d4881521`日期结构修复。`server/app.py`、桌面验收fixture和新的本预注册文档不在60源内；HEAD后续其他主题提交不代替发送前实际字节核验。21输入与固定参考逐项核同。
- 原索引规范SHA`982e603675063b8d7e4a7a65882e920a82cdbc91c8dafa3935224dedfdd689af`、技术closed6、原基线closed4/42、Vclosed1/3的原完成收据均冻结；不会凭索引旧`unrun`快照否认实际已闭账结果。新run注册目录尚不存在，准备未加载`.env`、创建客户端、领取预算或发送。
- 首13项交接/退出/起发入口守卫全绿；新增负控实际red（17方法、3失败、0.103秒）：一致重算摘要的“后续自动启动”和“删除关闭余额列表”未拒绝；records读取失败摘要误写响应0。补显式核验、不知写null后17项绿；失败原文留存，不构造假red。
- 再增225秒余量**每HTTP**负控：通过原contract＋EvaluationTransport＋精确Mock，在起发截止前构造后推进至04:36:15，预约0、Mock dispatch0且闭账。增加SDK版本漂移拒绝后19方法全绿、0.153秒，记录及mypy结果见外部`baseline-after-timeout-selftest-green-final-v2.txt`/`baseline-after-timeout-mypy-final.txt`。真实HTTP0；Mock临时预算只在隔离临时home，不注册或创建ae0。
- 自检显式禁止默认HTTPX/HTTPX2 transport、socket/DNS及真实credential。main对停止、不完整或收据不可用退出1；events无法核实时响应计数/alias为null，闭账计数未知为null。完成21窗也仍`quality_certified=false`，需另按原门槛审，不自动开候选实验。

现有两位Agent独立Standards和Spec最终均0项；他们未运行桥、测试、App、HTTP或读取密钥，另各自只读核了60源/15876blob、21Gold输入、闭账收据及ae0注册缺席。待Root最后hash/blob/配额/注册缺席核验后，才可激活唯一42次run。当前新增真实调用**0**，目标实际累计仍**11**。
