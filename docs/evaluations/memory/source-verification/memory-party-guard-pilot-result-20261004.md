# 人物核验匿名对照结果（2026-10-04）

本轮有限试验结束：前8次通过，后16次人物标签门失败，整体未通过验收。新防护把错误自动采纳从同期原方案的6项降到0项，14项正确候选均完整保留；但“朋友邀请我”在两轮都被误判为仅联系人参与，人物分类仍不可靠。产品默认和业务记忆没有改变。

## 批准范围与执行

用户明确回复“同意24次匿名对照”，批准d460b16中的[具体提案](memory-party-guard-pilot-proposal-20261004.md)，原提案SHA为`95bfb4f01d5d047a4407e5f7975f3f5e216266e19578c5f8af7e91066f5a91d5`。使用仓库外新的独立目录，固定24次公开V调用，E／R0；原A／B首次E捕获各3候选的两轮8次，全部过门后再运行C1—C4各1手工匿名候选的两轮16次。没有调提示、重抽、补位、增臂或借用旧预算。

对照基线是完整原产品V。新臂保留原system前缀、原11键候选及全部消息，追加临时`described_party`和`party_evidence`，仅`supported＋third_party＋原E assertion/asserted`降为`uncertain/pragmatics`。仍接原verify／四键／ExtractionFlow／无写入的采纳判断；人物字段不进入Fact或业务库。相对原V检验的是提示、schema与guard联合方案，不是单变量因果试验。

每阶段先冻结独立raw审，再揭compiled／Flow结果；原话、参考和原14输入没有按输出改写。C输入保存包仅重新序列化时增加尾LF，14值、窗口、sender、target及未知日期保持。原V对`invalid_tool_calls`的既有解析行为保留，未在共同wrapper额外加门。

## 结果

各机会含两轮重复，不能当作独立人数或新的真实聊天。两臂各20项，共40个固定候选机会，失败／未运行不从分母删除。

| 核对项 | 前8次：每臂12项 | 后16次：每臂8项 | 全部：每臂20项 |
| --- | --- | --- | --- |
| 新臂人物标签正确 | 12/12 | 6/8 | 18/20 |
| 人物quote足以定位真实直接参与者 | 12/12 | 8/8 | 20/20 |
| quote与返回人物类别一致 | 12/12 | 6/8 | 18/20 |
| 新臂错误标签负例安全待确认 | 4/4 | 2/2 | 6/6 |
| 错误自动采纳：原V → 新臂 | 4 → 0 | 2 → 0 | 6 → 0 |
| 正确候选完整保护 | 8/8 | 6/6 | 14/14 |
| 其中正确auto／正确pending | 4／4 | 4／2 | 8／6 |
| 阶段完整门 | 通过 | 人物标签失败 | 未通过 |

两臂原始四键核验均漏判6项错误E标签，仍返回supported；原始正确四键语义各14/20。新臂的窄guard将这6项转为uncertain并追加Fact风险`semantic:pragmatics`，阻止auto。它没有修正这6项原E标签，也不能把仍待确认的错误标签候选算作已得到正确记忆。

正例逐项核对原14、完整Fact、timing、证据及实际去向，与同期原臂完整保留。正确report／reported的Flow Fact风险仍为空，PragmaticDecision的report／reported风险按冻结代码推导，decision对象未序列化观测；保持pending也必须没有新增semantic阻塞，不能只看去向相同。

24次公开调用均返回，运行失败、整包结构失败、未运行、额外项、重复、缺项、误拒、不必要降级及正例整包损失均为0。未知日期不补造。阶段1八个完整门全true后才开放阶段2；阶段2标签门为false，不能用其他收益抵消。

## 确定的语义错误

手工匿名C4原话是“朋友邀请我。”，候选是“联系人的朋友邀请联系人。”，原标签report／reported保持。朋友是邀请者，联系人是受邀者，两人直接参与同一事件，预冻类别为mixed。新臂两轮都返回contact，等于错误地判为仅联系人参与。

两轮`party_evidence`都引用完整原话，形式合法，信息足以识别两方；它不能支持返回的排他contact分类。故证据信息充分8/8与标签／类别一致6/8分别报告，不改Gold来挽回通过。C4最终Fact和正确pending保留，临时分类错误没有重写业务记忆，但暴露模型人物含义判断的问题。

本轮新臂20个人物机会仅覆盖contact8、third_party10、mixed2；owner、both、unclear没有实际模型机会。不能用离线六值结构控制声称六类语义都验证通过。A中的负例来自既有真实E捕获的错标签；C3是手工故意错标签，二者分开保存。

## 本机验证与运行证据

冻结前完成worker11项不同unittest方法和root6项启动I/O控制；worker最终57次脚本绑定／56次脚本invoke全部是本机替身，不能计作模型样本。worker4文件及root4文件mypy通过，AST分别4与6文件通过。Context7工具不可用时使用[官方bind_tools参考](https://reference.langchain.com/python/langchain-openai/chat_models/base/BaseChatOpenAI/bind_tools)，其在线版本与本机版本分开；本机langchain-openai1.5.1的原V／新Party两种工具经SDK仅绑定、虚拟key、0网络／invoke通过；原工厂逐字私有快照避免导入并行修改的reply包，快照与origin同SHA，工厂行为和参数不变。

预审发现并修正普通SDK运行失败继续调用及调用后落盘失败误标unrun的记录问题，按red→green保留首失败。初始语法、类型及格式失败也保留，未覆盖。冻结前材料清单包含已加载项目／私有源码及明确资料214个SHA；最终计划加上本机验证／预审与root批准收据共228个SHA，并锁定7项第三方版本，第三方SDK没有逐文件字节冻结。唯一标准库入口先检查冻结字节／版本再导入，guard在绑定和调用前复查；不使用全仓HEAD或别人的脏文件作为门禁。

最小命令使用Conda `NotAlone`、`PYTHONDONTWRITEBYTECODE=1`：

- worker：`python -m unittest -v test_party_pilot_v1`；mypy使用`--no-incremental --cache-dir /dev/null --follow-imports=skip --ignore-missing-imports`检查4个明确目标文件，导入依赖跳过；AST4。
- root：`python root_launch_controls_v1.py`、`python real_sdk_wrapper_bind_v1.py`；mypy使用`--no-incremental --cache-dir /dev/null --follow-imports=silent`检查4个明确目标文件，AST6；`python collect_runtime_materials_v1.py`核实际源码闭包及权限。
- 唯一运行：`python frozen_entry_v1.py --plan-sha256 2d0ed306092108e3d56fbbc28f1d58bd309c8b51286ea9b7e3d4a8364e8cecf2 --phase stage1 --run`，再以stage1 gate SHA `591f8056a0cbb2d1253a0e523a7318b2d73401090b87ed99e1bf23d44cb31fb1`运行`--phase stage2 --gate-sha256 … --run`。完整参数及首次执行记录在私有root控制收据，预算已闭账，不可重跑这些命令。

本轮不修改产品Python代码，因此未重复旧全量测试。阶段2完整独审与root机械配对复核已完成；关闭后标准库入口实测因预算关闭拒绝，0新调用。关闭报告的链接／SHA／统计／状态最小核验及Standards／Spec两轴终审已通过。首审发现并纠正worker实际mypy选项与C4误判方向两处文案；最终硬问题／阻塞0，保留非阻塞重复helper气味1。文档终审通过不等于试验或整体spec通过。

## 数据与边界

仅使用已批准的匿名原话与冻结候选，公开I/O、首失败和逐项审计保存于`~/.notalone/audits/memory-party-guard-pilot-20261004/`，目录0700、文件0600；凭据及内部思考不保存、不打印、不提交。未读取actual／private held；不写业务记忆、水位或旧五条资料，不改产品默认、不发布、不做远端Git。

唯一模型服务为现有ECNU，显式配置`ecnu-max`、`https://chat.ecnu.edu.cn/open/api/v1`、timeout60、temperature0、SDK max_retries2及原thinking配置。返回metadata报告的模型名为`deepseek-v4-flash`，它与配置名分层保存，不证明官方端点或官方key调用。本轮没有选择DeepSeek官方目的地、key或fallback。

24个公开V预约／调用／台账全部对应，余额0，预算永久关闭。服务报告input49,260、output11,391、total60,651 tokens；SDK HTTP尝试数、缓存计费及外部账单未观测，24次公开invoke不等于24次HTTP尝试。

未知知识状态J仍未由E生成；C2只是给定正确候选的核验，不是补漏。实际必需6/12及可选2/6的历史结果未复测、未改善。本轮收益限于这些已知匿名输入的错误自动采纳防护，人物分类失败与漏提目标继续保留。

## 冻结收据

私有目录内的主要收据如下，不提交原始资料：

| 收据 | SHA256 |
| --- | --- |
| 冻结计划`frozen-plan-v1.json` | `2d0ed306092108e3d56fbbc28f1d58bd309c8b51286ea9b7e3d4a8364e8cecf2` |
| worker最终11控制与类型总收据 | `49c94d8b80ca64822b7ee8d74f3d89e4f0944e817db3426da8cfaa00adb894aa` |
| Standards预审 | `23cc50ee850becb8f12c21910cf1d1bcdcac2375d06a2e18d351957cfb1b3ffe` |
| Spec预审 | `9f756955af143ecd2448bc38d97c2ee064b7cb866788f5b92bafeb6aadf2fc9c` |
| 阶段1 raw独审 | `73f1f2524a381ca1b590afb89d2c3ad8d1ed597a626fbe739de0dad23a24cfe4` |
| 阶段1 full独审 | `8a5a48ecbdd42c4ff4ed282e49c3ceaefa1220ede7a177ae855b4679c71ed684` |
| 阶段2 raw独审 | `c0298be06120fc396ccafde15ff02e8625b0710a8914140b4c35a70a02e28aaa` |
| 阶段2 full与全部汇总 | `e5b9832b8ea52847f012906ceba61aa42e695b2056e6b0170b46fc3bac529ee1` |
| root最终关闭与门复核 | `005325107d6f99a552f149db1d972a577df397b300e2d658a1d2ba299e4b3050` |
| 关闭Standards终审 | `b3c88e0afa1fc1e8c78c2416cb2eeb3bdf4996457e9b5e49b0e201e4e24ea1e1` |
| 关闭Spec终审 | `7cb708b756082335dc343de02f5f17a786c7c8727798262683f7bd5f4964a23d` |

当前ticket仍claimed、整体未完成。ready-for-agent仅表示可继续本机归因和具体方案准备，不授权新wire联网、更多预算或产品切换；24次批准范围已经执行并关闭。
