# 受控歧义v3两窗官方验证准备

日期：2026-10-16。状态：最小实现、离线Mock、完整相关回归及独立双轴审查均完成，可进入主Agent新freeze绑定阶段；尚未创建真实run、读取凭据或联网。必要的官方DeepSeek公开合成验证已获当前持续目标授权；本场仍须由主Agent独立复核、生成新freeze并绑定独立台账，不能借本计划自动恢复任何旧场。

## 单一协议变化与范围

仅验证[受控歧义v3](typed-ambiguity-v3-spec-20261016.md)的新模型字段与固定说明是否在实际供应商路径可用。固定原公开21窗中的A07（位置6，身份＋地点归属，一条必需命题）及A10（位置9，借贷方向，两条必需命题），顺序A07→A10；总计2窗／3条必需。原input、完整Gold、纳入／主体／语用／时间／风险与去向要求保持，不能因两个已知回归案例通过就认证≥15用例或泛化。

E唯一变化为grounded-v2→显式grounded-v3：动态工具名`GroundedMemoryLabelsV3`、受控ambiguity_codes、对应提示和程序渲染；V仍nullable-proof-v1。模型仍官方`deepseek-flash`、thinking enabled、reasoning max，不同时改变模型档位、kind／sensitivity／confidence提示、风险门、评分或原始输入。两种工具选择均omitted，不加自由正文、模型修复调用或重试。A10风险标签等独立旧缺口可能继续失败，必须如实保留，不视为协议结构失败或临时改答案。

这不是重发remaining8里未知的B02 V，也不覆盖旧A07／A10成绩。旧run0e5203b8已closed25／42，remaining8 run7fa08dec已closed4／16；其17及12次未用额度永久关闭。本场新UUID、新目录、新4次上限，只有本场领取后才可读取既有官方三键；不继承旧预算、不触ECNU、私人聊天、业务PG、App、CLI、截图或发送。

## 必需的最小执行接缝

现有官方reference21只允许完整21／42或固定remaining8／16，不能通过绕过run_ecnu_evaluation来运行本场。新增显式`execution_plan=reference21-ambiguity2-v3`，仅接受positions `(6,9)`、预算4、reference21、官方max、grounded-v3、nullable-proof-v1、omitted工具和零重试；错配置在预算与凭据前拒绝。原original及remaining8全部守卫保持，不能提供任意子集。

复用现有batch、SDK、精确请求合同、可删除追踪、持久预算和raw→sealed→full审核。独立runner只准备该两窗的冻结、绑定授权与拥有的worker；不创建通用任务平台或自动后继。若共享原有墙钟控制，只抽取两种实际消费者共用的最小内部实现，remaining8公开接口与16次固定语义不变，新两窗固定4次；不得复制一套会漂移的close-before-exit机制。

## 预算、墙钟及停止

最多4次真实HTTP预约，E／V每窗各至多一次；空候选不调用V，错误及远端未知照计、不退款、不重试。端点唯一`https://api.deepseek.com/chat/completions`，请求／响应model必须`deepseek-flash`，SDK与transport重试均0，不继承代理、不重定向、不发额外探测。

单E／V调用墙钟600秒；每个显式审核phase最多600秒。整批工作绝对上限5380秒，外层5400秒，其中最多20秒有限收尾；实际freeze写入带时区的开始、工作截止和绝对结束，prepare到启动的时间也计入。原HTTPX300秒仍不是整次调用墙钟保证。按4请求及4审核phase的最坏4800秒预留边界，不拿上场短时窗强行续跑。

技术／结构／供应商身份／冻结／记录失败、安全错误或语义未知立即停止；一般错误封存后按固定顺序继续。到单调用或整批deadline，先在原owned Budget持久关闭并fsync固定收据，再退自有worker；外层仅有界收自有独占进程组。关闭故障保持close_unknown，未知请求不得另建run重发补分；无自动后继。

本场若缺完整result，原保守outer unknown策略继续，已封存单窗审核另层报告，不冒充整批完成。没有review的窗不补签，未开始保留unrun；两窗／三条必需分母始终保留。

## 冻结、验证与启用

prepare只处理公开材料，不读取真实registry／key；冻结实际完整源码closure、安装版本、input、v3 prompt／动态schema、V prompt／schema、原Gold摘要、本计划和私有审核桥。新代码版本不能声称与旧73字节相同，须明确协议变化，保留旧冻结。原始输入与旧对应窗逐字比较；不为proof补可信source元数据。

先以纯Mock证明：精确两窗／四次准入、wrong mode／positions／budget／profile提前拒绝、v3实际SDK请求形状与原两守卫不变、原Gold位置映射、raw封存不可逆、无默认审核；共享deadline关闭先于强退、超时后无下一HTTP，close未知不补签，owned group退场、异run／异PID收据拒绝。完成最小与完整相关回归、类型检查及Standards／Spec两轴后，主Agent才生成新真实freeze并绑定本场具体run／SHA／授权，唯一激活一次。真实结果分字段／分来源／分层计数，未运行和全部原失败保留；默认空放行与UNKNOWN proof不变。

## 实现与离线记录

`run_ecnu_evaluation`新增精确的`reference21-ambiguity2-v3`选择及独占`Ambiguity2Deadline`参数；原original／remaining8守卫保留，错class／mode／配置在预算与凭据前拒绝。新mode／stage分别为`deepseek_bounded_ambiguity2_v3`／`ambiguity2-v3`，不直接调用private batch绕过官方集合限制。

两个已有实际消费者共享私有`evaluation_owned_deadline.py`的关闭／fsync／退场实现，公开`Remaining8Deadline`仍固定16次／2380秒，新`Ambiguity2Deadline`固定4次／5380秒。两runner共享`evaluation_owned_process.py`的只读领取核验、有限自有进程组、关闭收据及unknown分母控制，内部只识别既有两种固定规模，并分别绑定cap／mode／stage／positions，不提供模型／端点／预算平台或新的CLI。

专用入口为`desktop/tests/fixtures/ambiguity-public2.py prepare <新私有目录> <带时区开始>`及`launch <freeze.json> <freeze SHA> <绑定授权文件>`。`worker`只供外层独占进程使用，须等owned记录fsync后经stdin放行；不能直接作为续跑命令。prepare复用旧helper的纯摘要／私有文件／SDK版本函数及显式审核桥，当前v3合同直接由实际`extraction_contract`生成，不使用旧v2 rows，不调用旧prepare／validate／launch／registry_snapshot。

新完整集合为78份源码／规格文件，包含旧73份的当前版本及新增的本计划、v3两窗runner、共享deadline、4次deadline和共享outer五份。prepare与validate均核精确集合，缺少实际依赖在预算前拒绝；新input逐项与旧A07／A10相同，新E动态schema摘要与v2不同。这个集合是新版本闭包，不表示旧73摘要仍相同；旧freeze完全保留。

SDK Mock实际完成两次E＋两次V、4／4预约且closed，A07→A10的四个显式审核phase及原Gold位置一致，合成审核故意不赋必需命题信用、裁决一般错误，不认证质量。prepare的home／registry阻断、缺授权／源码闭包／漂移拒绝、单次领取后loader、旧16次领取证据不能授权新4次计划、异PID关闭收据拒绝、已开始unknown／未开始unrun分母，以及共享旧runner六项收尾回归均通过。deadline Mock还验证4与16不能互用、close失败exit125且closed=false、单call超时先持久关闭再exit124。

首次红灯为缺少`Ambiguity2Deadline`；后续新固定mode缺失、新runner缺失、删除实际runner闭包未拒绝均先红后绿。共享outer首次抽取漏传freeze_path亦由原runner三项收尾回归捕获，补参数后原六项全绿，没有跳过旧回归。红／绿记录位于本机忽略目录`desktop/artifacts/ambiguity2-*-20261016.log`。

最终完整memory_extraction单元442／442（5.176秒），ECNU／offline／SDK／wire评测集成103／103（20.168秒），原8窗runner6／6（3.816秒）、新两窗runner6／6（1.383秒），7个修改／新增源模块和runner的mypy通过，合计557项通过检查。具体日志为`ambiguity2-final-unit-20261016.log`、`ambiguity2-final-integration-20261016.log`、`ambiguity2-final-remaining8-runner-20261016.log`、`ambiguity2-final-runner-20261016.log`、`ambiguity2-final-types-v2-20261016.log`。

全部命令先激活Conda `NotAlone`并设置`NOTALONE_DISABLE_DOTENV=1`。从`backend/`运行：

```sh
python -B -m unittest discover -s tests/unit/memory_extraction -t . -v
python -B -m unittest tests.integration.memory_extraction.test_evaluation_ecnu tests.integration.memory_extraction.test_evaluation_offline tests.integration.memory_extraction.test_evaluation_sdk_budget tests.integration.memory_extraction.test_evaluation_wire_contract -v
```

从根目录以`PYTHONPATH=backend/src`分别运行`python -B desktop/tests/fixtures/test_remaining_public8.py -v`和`python -B desktop/tests/fixtures/test_ambiguity_public2.py -v`；类型检查覆盖`evaluation_ecnu`、两个固定deadline、共享deadline／owned-process及两个runner，参数为`--follow-imports=silent --ignore-missing-imports`。独立Spec审查及共享领取核验的增量复核均为0；Standards首次审查硬违规0、非阻塞重复代码smell 1，已共享领取核验并补错4／16反例，最终增量复核硬违规0、剩余smell 0。本片没有真实出站请求、真实台账、业务PG或GUI操作。
