# v3标签指导两窗官方实测预注册

日期：2026-10-16。Triage: ready-for-agent。State: resolved。离线准备、相关回归、类型及独立双轴均完成；没有本场真实freeze、预算、凭据读取或出站请求。主Agent完成独立复核后才生成新freeze并绑定具体UUID／SHA／授权、唯一启用一次。

## 问题与唯一实验变化

[原v3两窗场](typed-ambiguity-v3-pilot-result-20261016.md)已closed4／4，A07漏place_ownership，A10第二条否定借款漏financial，两窗均general_error。沿[已完成离线诊断](v3-label-guidance-plan-20261016.md)，旧提示本来已有“类别必须列全”，提示措辞造成漏标只是待检验假设，不能预先写成原因或已修复。本场是不同提示的一次独立检验，不是自动后继或多次重试。

唯一实验变化是已提交`ef64053b`的两条显式v3字段指导：ambiguity_codes非互斥、逐类核对来源并列全适用类别，不凭词命中补猜；financial表示涉及金融敏感事项，即使来源否定发生也保留，但不认定负债或交易。普通物品借用、商品报价本身仍不扩大风险。模型档位、输入、Gold、schema、kind／confidence等其他标签、编译输出、V、评分、门槛、proof和生产默认全部保持。

## 固定范围与执行合同

复用现有`desktop/tests/fixtures/ambiguity-public2.py`，仅静态切换本计划并在FIXED中写明`label_policy=v3-guidance-v1`，不提供任意variant或复制driver。固定原reference21位置`(6,9)`，A07→A10；分母2窗／3条必需命题。E为显式grounded-v3、V为nullable-proof-v1，E／V工具选择均omitted。官方`deepseek-flash-max`、thinking enabled、reasoning max，请求／响应model均须为`deepseek-flash`，唯一端点`https://api.deepseek.com/chat/completions`；SDK／transport零重试，不继承代理、不重定向、不发额外探测。

本场新UUID、新私有目录、新独立上限4次；每窗E／V各至多一次，空E不调用V。错误或远端未知照计，不退款、不重试。HTTPX300秒，单次调用墙钟600秒、每个raw／full审核phase600秒，整批工作5380秒、外层5400秒；prepare到启动也计入带时区的绝对时限。继续使用共享owned控制，先关闭原owned Budget并fsync再退场，close失败保持unknown；仅有界回收自有独占进程组。

一般错误封存后按固定顺序继续；安全、语义未知、结构、供应商、记录、冻结或其他技术错误立即停止。未开始记unrun、已开始未封记unknown，无审核不补签，分母始终保留。没有自动后继、自动模型修复或未知请求重发。

## 冻结与旧场边界

prepare只处理公开材料，禁止真实home／registry／key；沿既有纯helper、当前extraction_contract生成的实际prompt／动态schema以及原input／Gold摘要冻结。只在本场新领取验证后读取既有官方三键；旧helper的prepare／validate／launch／registry_snapshot不调用。旧版本runner仅供历史离线重现，不能用它重开已关闭预算。

新closure实测79份：原78份当前集合以本计划替换旧pilot计划，再加入已提交离线guidance-plan，净增1份；原pilot计划仍在Git和旧freeze中完整保留，不属于本新入口的当前计划依赖。不把新集合称为旧78或相同字节。集合包含两个实际runner、共享deadline／进程组／领取核验、固定4／16控制、所有实际评测源码、SDK版本、公开reference及显式审核桥。prepare及validate都核精确集合，wrong／缺label_policy、缺新runplan／guidance-plan、源码漂移或旧prompt合同在预算与凭据前拒绝。

原21／42、remaining8／16固定位置及旧pilot离线语义守卫不削弱。原run0e5203b8已closed25／42、remaining8 run7fa08dec已closed4／16、原v3 run580343d0已closed4／4；不复用余额，不重发B02未知V，不覆盖旧A07／A10失败，不修改任何旧freeze／审核／结果／Gold或闭账原件。

## Testing Decisions与成功口径

任务已指定prepare／validate／worker的公开接缝及现有MockTransport，不增加Harness。TDD先固定新计划／policy／精确集合，再补wrong policy、缺新依赖、旧提示合同的预算前拒绝反例；保留原两窗SDK四次、原Gold位置、未知关闭和自有进程组收尾用例。执行两套runner完整相关回归、必要ECNU准入／deadline测试、类型检查和独立Standards／Spec双轴。

真实成绩须按模型原标签、编译E14、raw／V／full、必需命题与最终去向分别报告，封存一般失败和未运行项。即使本场两窗完整契约通过，也只说明本次不同提示的单次观察；不能认证通用改善、独立泛化或ADR-027的≥15窗维度放行。假事、错人、过标或漏标均如实保留，默认空放行表不变。

## Out of Scope

不改模型、输入、Gold、其他字段提示、schema、compiler、评分、风险门、proof或默认协议。不新建通用variant／预算平台，不重跑旧场，不生成自动后继，不处理真实聊天／业务PG／App／CLI／GUI。此准备阶段不建真实freeze或预算、不读凭据、不联网、不提交；真实冻结和唯一启用由主Agent独立完成。

## 验证记录

固定审查基线为`ef64053b09f1f2816f9bd4d2ea90084386c4afc4`。准确3文件为当前runner、其既有测试及本计划；未改后端、旧pilot计划／结果／freeze、离线guidance-plan或任何闭账原件，未提交。

首红为prepare返回缺少`label_policy`（None不等于v3-guidance-v1）；仅静态切换PLAN、加入policy与guidance依赖后该接缝转绿，并实际确认精确79项。新增5个反例分别为缺policy（旧pilot形态）、未知policy、缺新runplan、缺已提交guidance-plan及旧v3提示canonical摘要；在正确绑定各自freeze SHA／授权的worker入口全部按对应fixed／closure／contract错误拒绝，未领取预算、读取凭据或发出请求。这些反例保护原已有严格守卫，不冒称新增运行时算法。首次新增反例误用不可覆盖publish，被临时夹具拒绝；改为每个反例各发一份新私有候选文件，未覆盖原临时freeze，最终通过。

实际SDK Mock维持2E＋2V、4／4预约并closed，A07→A10和四个显式审核phase不变；E请求system消息逐项对齐本场冻结prompt摘要并携带新指导，模型及工具选择不变。合成审核仍不授质量信用，未声称真实模型改善。prepare测试阻断Path.home／registry；所有测试使用临时合成资源且禁止真实socket和凭据。

最小及完整新runner7／7（1.622秒），原remaining8 runner6／6（3.974秒），两个固定deadline及ECNU准入相关81／81（19.004秒），合计94项通过；当前runner的mypy及`git diff --check`通过。日志位于本机忽略目录`desktop/artifacts/`：`v3-guidance-public2-red-binding-20261016.log`、`v3-guidance-public2-green-binding-20261016.log`、`v3-guidance-public2-minimal-20261016.log`（首次反例夹具错误）、`v3-guidance-public2-minimal-v2-20261016.log`、`v3-guidance-public2-final-remaining8-20261016.log`、`v3-guidance-public2-final-controls-20261016.log`、`v3-guidance-public2-final-types-20261016.log`。

全部Python命令先激活Conda `NotAlone`并设置`NOTALONE_DISABLE_DOTENV=1`。根目录运行：

```sh
PYTHONPATH=backend/src python -B desktop/tests/fixtures/test_ambiguity_public2.py -v
PYTHONPATH=backend/src python -B desktop/tests/fixtures/test_remaining_public8.py -v
python -B -m mypy desktop/tests/fixtures/ambiguity-public2.py --follow-imports=silent --ignore-missing-imports
git diff --check
```

从`backend/`运行：

```sh
python -B -m unittest tests.unit.memory_extraction.test_evaluation_remaining8_deadline tests.unit.memory_extraction.test_evaluation_ambiguity2_deadline tests.integration.memory_extraction.test_evaluation_ecnu -v
```

独立Standards硬违规0／可能smell 0；独立Spec 0项。两轴只读核当前3文件，未运行或接触真实资源。数据处理仅公开源码／规格及临时Mock；本场仍待主Agent独立核验、提交当前精确变更、生成新freeze并绑定真实UUID／SHA／授权，当前没有真实激活收据或后继场。
