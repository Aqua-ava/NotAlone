# 来源复制计划有限试验结果（2026-10-03）

本轮匿名门失败：四项必需事实完整保留3/4，漏了“联系人不知道朋友当前报酬”。已生成的三条含义、标签和来源均准确；完整来源字符复制仍不能保证提取齐全。此配置按批准规则关闭，不发布、不重抽或继续调参；整体记忆准确性修复尚未完成。

## 范围与冻结

用户明确批准[提案](memory-source-copy-plan-proposal-20261003.md)的一次有限试验。批准版本为40bb3e3，原提案SHA为`0ee17ce043719289af4283b66066d9fdba39d68d85192a6528e4363bb84e72ab`，人类批准凭证SHA为`32a33e69a6f02a9ed7a25abf388c214eb68311a415826180d7b31cbd7ba758fe`。提案当前状态段记录的是批准后的准备检查点，联网后的结果以本文为准；冻结提案未因本次结果改写。

私有Adapter一次E返回原12元字段及copy_plan，程序从同窗逐字片段、有界角色前缀及来源时间附注构造原14字段，再接原Flow／V／采纳。只借鉴来源跨度复制原则，没有复刻SpanCopy训练或神经机制。单字重组、错误指代、期间及整项遗漏仍可能，来源字符合法与supported不能当成语义正确证明。

正式计划SHA为`0cc850ec8f1ab2446fcd39f7832498ab658b2bbb358ca22d0bc92da391e51f65`，绑定全来源／Gold／规则、160项基础依赖和46项额外静态依赖、Runner／root helper／版本及原模型配置。仅现有ECNU ecnu-max；没有使用DeepSeek官方key、直连或回退官方服务。

## 本机原型门与预审

人工编写的预期复制计划覆盖开发9必需语义、旧12保护机会和匿名4语义。25条结构重放全部通过，对应12个不同计划正文；此门证明批准协议能够表达这些正确事实，不代表模型会生成它们。保留字符合法但拼错关系／动作的反例。

Adapter 19、Runner 23、运行分析26项不同unittest方法通过，共68项；重复运行不加倍计数。12文件mypy／AST通过，原E、新E、原V共3项真实SDK工具绑定通过、当时0invoke。Standards与Spec预审均无剩余阻断。

冻结前发现并修正了fresh原臂完整正确raw主张的保护范围遗漏、原始清单键不兼容、接口元数据SHA陈旧、隐藏思考键检测不足；原版本与首次类型错误保留。最终规则v3 SHA为`01c510e6b970838f4924a2bf7e15445431e366f6f0dd2d4530c057eeebd5618a`。来源／Gold不改，actual及held仅核原字节指纹。

## 匿名完整结果

独审先冻结原始copy_plan、组装字段、完整来源及遗漏判断，再揭V／Flow／去向。这里均为合成匿名资料。

| 原话中的事实 | 原始及最终完整语义 | 最终去向 |
| --- | --- | --- |
| 朋友以前参加暑期项目，项目报酬每天180元 | 正确 | pending（第三人转述） |
| 朋友现在已是正式员工 | 正确 | pending（第三人转述） |
| 联系人不知道朋友当前报酬 | 未生成 | 无 |
| 联系人平时喜欢喝热茶 | 正确 | auto（仅评测去向） |

四项必需主张的raw覆盖、接受覆盖、核心完整覆盖、严格完整契约覆盖均为3/4；全部输出3条、额外0条，三条完整合法且正确。原V均supported，三份引用均逐字真实且意义充分。确定坏auto、纯歧义坏auto、完整合法误拒及不必要降级均0。要求的reported/pending两条保住，要求的两条auto只生成一条。

遗漏在E首结果已经出现，程序只能组装返回的计划，后续V没有候选可核验。原型可表达当前未知事实，不等于模型会生成它；本轮没有识别更深原因，也没有本次原臂或实际聊天对照，不能归因为复制机制必然降低覆盖，更不能宣布实际准确率改善。

## 运行、预算与关闭

匿名唯一session53629终态exit0：1完整位置，1 E＋1 V，2预约／invoke／无正文台账，失败及空实例0。阶段执行19.026秒。运行闭环仅重放实际捕获E与原V返回，逐字段核对Flow、来源、请求、去向、预算和完整位置；检查通过，新增模型调用0，不伪造supported。

服务报告输入6,399、输出3,418，共9,817 token，两次均报告用量。SDK内部HTTP尝试次数和账单未知，不能把2次公开invoke当HTTP次数或费用。

两个返回都报告模型名deepseek-v4-flash，实际请求仍使用ECNU的ecnu-max及既有ECNU凭据；返回名不证明服务背后的权重或上游。它不表示使用了DeepSeek官方key或官方直连。

匿名要求4/4完整准确，缺项足够判败。完整独审、运行闭环、失败门与有限试验关闭收据另存私有目录；后续开发dry在凭据／factory／API前被拒。总预算实际使用2/114，余112关闭。开发、同批实际、最终留出均未启动；actual及held未解码，无最终候选冻结。此前58/199和34/114的关闭余额未复用。历史实际严格6/12、可选2/6保持为旧结果。

全审保存脚本首次字典语法错误在执行前退出；root关闭收据首次误把model_name放在model_config里而KeyError，失败门当时已经保存。文档核验helper首次把路径字符串当Path而AttributeError。这些本机核验与凭证错误均如实保留，仅修正记录逻辑，0新增API，不覆盖首输出或评分。开发dry返回预期BudgetRejected，预约仍2。

## 数据影响、验证与剩余工作

源码原型、匿名输入、公开I/O及逐条审计均在仓库外0700目录／0600文件，内部思考值不读取或保存。本轮runner无数据库writer，不写业务记忆、水位或旧五条认可资料，不发送聊天；产品源码、配置和默认路径未改。此结论依据冻结runner及调用路径，不冒充业务数据库全量检查。

实际命令均在Conda NotAlone环境执行：Adapter／Runner／Analysis的`python -m unittest discover`，12私有文件的`python -m mypy --check-untyped-defs --follow-imports=silent`及AST检查，P0与SDK只绑定helper，root冻结／匿名dry／唯一匿名`--run`，独审后`runtime_analysis_v1.py --stage anonymous`捕获重放，以及关闭后的开发dry。命令参数、返回与文件SHA保留在私有验证凭证；本轮收尾核对这些SHA、文档链接、任务状态、预算和差异。不重跑旧产品全量，也不以匿名结构测试代替实际效果。

当前只完成这一失败方法的有限检验和收尾，任务仍ready-for-agent／claimed。真实聊天严格覆盖提升、旧正确语义保护、零坏auto及最终留出等完整验收要求仍待满足。后续新方案须明确机制及相应范围，不能从本配置余量继续补跑。

私有证据根目录：`~/.notalone/audits/memory-source-copy-plan-experiment-20261003/`。关键凭证：

| 凭证 | SHA256 |
| --- | --- |
| `root-integrated-unit-verification-v1.json` | `f038af1490b88d567046193fbf2e9d16028e280c1043e4582e3763a838c25065` |
| `root-final-code-verification-v2.json` | `bef7dc905bcf6d6192a66d0a8ae0f463dbcd18b9c27292dfe12e7cbf5979bf8b` |
| `p0-runtime-assembly-v3.json` | `890feaf39ea58dc675210900f08c4aef5cd6d3d93a4b484d96f8b8c3ad342fd2` |
| `sdk-bind-only-root-v2.json` | `27c73b20879020127581ea28047b73fdfff7289e157379ca81e21f19948560b7` |
| `anonymous-raw-first-manifest-v1.json` | `4ad2e2ce4dc75def3dd55f5cd88c5342e8a0586d22f49659bbff52ef52196ab5` |
| `anonymous-independent-audit-v1/raw-first-audit-v1.json` | `4ae2ba1d26c02ce0912f894781e07c935eff1c0e2502f8aac1ab6dad04265c51` |
| `runtime-analysis-v1/anonymous-runtime-closure-v1.json` | `20135c2204841385f56513fee55c273efb74861d7e338d8e455fd15e8b5d9230` |
| `anonymous-independent-audit-v1/full-audit-v1.json` | `b5465e91e4ea94fe2983b04c21b1b6b86a468d5a6e5f962dfc6a2afb135d6326` |
| `anonymous-independent-gate-v1.json` | `bc94c121b946867a809b11dcbe16b8c9fc70f894258eacf80f0c2acb3838d849` |
| `finite-trial-closed-v1.json` | `aa89abcec42847f4b43a8090ee4f983c841cf92579cab3ca7637efb82ab43b1f` |
