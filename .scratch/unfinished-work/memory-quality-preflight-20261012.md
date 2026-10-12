# 记忆质量离线预检（2026-10-12）

本文件补齐[既有方案](memory-quality-plan-20261012.md)可自主完成的公开输入核对及代码配置快照，不开放模型执行门。当前真实供应商配置与人工语义核定仍未完成；42／84 是方案提出的真实 HTTP 上限，本轮模型、SDK、HTTP、业务库调用均为 0。新增功能继续冻结，OCR 继续暂停，[默认放行台账](../../docs/memory-adoption-dimension-release-ledger.md)不改。

## 输入与核定方法

只读取已提交公开合成输入、领域契约和代码，不读取 `.env`、凭据、任何模型 raw 输出、私人样本或历史匿名窗口。标准库 AST 从用例源码抽取消息、说话人和 target；没有执行评测 main、旧 runner 或模型构造器。

本 Agent 最初定位兼容入口时先看到了部分 `_STRICT_CLAIMS`，不能把自身后续解读算独立盲审。随后另启 `fork none` 的 Agent，只给 21 窗公开输入、固定来源时间和领域判据；没有传 expected 字段、受控 good／bad 变体、模型输出或仓库文件，并禁止它调用工具。先收到独立输入解读，再核对现有 oracle。这形成独立 Agent 候选核定，**不是人工 Gold 认证**；分歧不会通过照抄现有答案消除。

输入代码固定在 `bf675ba60ca24dc116e2c3f61a0f268c8ebbe719`。依[当前 build_window](../../backend/src/notalone/memory_extraction/evaluation.py)，来源时间为 `2026-09-15T00:00:00+00:00`，第 i 条消息加 i 分钟；不能用本次日期替代。消息索引零起始；至少一个 target 直接支持候选，context 只辅助理解。

| 输入组 | 原始分母 | 输入快照 SHA-256 |
| --- | ---: | --- |
| reference 主集 | 16 | `84272c32bfb5e43760f149ab1ff9fce81e64e6253bb035dbcfa65d3f4fbb592c` |
| reference 语义补充 | 3 | `b24dd6fff2a94b8c27dba83a3a93ddf24793352af1356dc5b2fbc63bf0e7e02a` |
| 核心公开观察窗 | 2 | `e8f8dc03545fd9439a7607983eff9f40882b4391897bb36a3b5f6359ca4606ee` |

哈希口径：按源码 AST 顺序组成列表，每项仅含 `name`、`dimension`、`messages`、`target_indices`、`occurred_at_base`、`occurred_at_step_minutes`；采用 UTF-8 JSON，`ensure_ascii=False`、`sort_keys=True`、`separators=(',', ':')`。不含 expected 或任何输出。输入来源为[主集 reference](../../backend/src/notalone/memory_extraction/cases/reference.py)和[语义集](../../backend/src/notalone/memory_extraction/semantic_evaluation_cases.py)。

## 独立输入解读与现有 oracle 核对

下表保留全部 19 条 reference，不丢弃含糊例。A01–A16 是主集原顺序，A17–A19 是语义补充；source 索引只声明独立输入解读所需的证据，不冒充现有 oracle 已覆盖来源完整性。`contact`／`self` 是资料归属，第三人的行为主体仍须写在正文；`auto`／`pending`／`none` 栏来自当前有限 oracle，不代表生产写入。

| ID／公开用例 | 独立候选语义骨架、必要 source | 现有有限 oracle／需核定点 |
| --- | --- | --- |
| A01 复核：未知第三人部门 | contact：未识别第三人不是仓库管理员，在采购部；reported；`[0]` | pending；有主体与否定排除词，无严格 claims。正、负两项及第三人未知身份都要审，不只看去向。 |
| A02 指代：跨消息老李 | contact：老李邀请联系人周末钓鱼；reported；`[0,1]` | 严格 pending 1 条，要求 reported，但未固定 speech_act 或相对时间；不能补接受邀请、已钓鱼或老李很忙。 |
| A03 指代：他借钱 | contact：未知第三人昨天再次向联系人借钱；reported；`[0]` | pending，无严格 claims；借钱请求不必然证明款项实际已出借，不能补金额、次数或还款状态。 |
| A04 指代：那个事 | 联系人要求用户暂不透露未识别的事；request；`[0]` | pending，无严格 claims。是否值得提取、subject 应如何归属及“先”的期限未独立核定；不能变成长久偏好。 |
| A05 指代：姐借车 | contact：其姐姐把姐姐的车借给联系人；第三人事件，report/reported；`[0]` | **旧 expect=auto，和当前第三人语用分流存在冲突**；无严格 claims。不能为达到旧 expect 去掉转述标签；也不能写成联系人拥有车辆或仍在借用。 |
| A06 指代：机场等行李 | contact：已到机场，当时正在等行李；`[0,1]` | 严格 auto 1 条，把两项合并并固定空日期；应核定忠实拆分是否等价、当前瞬时状态的日期和失效字段。不能把这项有限 oracle 作为完整时间 Gold。 |
| A07 指代：他们来家 | contact：未知“他们”周末计划到所指家里；plan，保留第三人；`[0]` | pending，无严格 claims；来访人、地址、用户参与均未明，不补已到访。 |
| A08 指代：那本书 | contact：刚读完《活着》；已完成；`[1]` | 严格 auto 1 条；书名在 target 自足，准确完成时间未知。不补喜欢或推荐该书。 |
| A09 指代：那人 | contact：未知第三人昨天又来了；reported；`[0]` | pending，无严格 claims；身份、地点与具体次数未知。 |
| A10 指代：多第三方借钱 | contact：老李“借你钱”成立，小王没借；两项分开核定；`[0,1]` | pending，无严格 claims；**借入／借出的中文方向需核定**，不得静默填贷方／借方。 |
| A11 指代：感冒好点 | contact：来源时点感冒明显好转；临时健康状态；`[0,1]` | pending，无严格 claims；不能写完全康复、发病时间或查询当天仍感冒，来源时点和可推算失效边界需按分类核定。 |
| A12 指代：咱们那家店 | 纯询问是否还去未识别店，不构成已确定安排；`[0]` | none，无严格 claims；与当前纯问题不提取约束一致。提问预设不能自动增补成双方历史事实。 |
| A13 指代：门票 | contact 范围：所问门票已买好，共两张；`[0,1]` | 严格 auto 1 条；不能补票种、同行者或已参观。正文显式改成“联系人亲自购买”时，行为主体需核定。 |
| A14 指代：发地址 | 联系人计划稍后把地址发给用户；`[0]` | pending，无严格 claims；一次性细节的可提取性与期限未核定，不能写成已经发送或补地址内容。 |
| A15 指代：借书看完 | contact：所指书已读完；如果保存借书关系，另核其主体与方向；`[0]` | auto，无严格 claims；**“你上次借我的书”的借书方向需核定**，不能补书名、归还或双方共同阅读。 |
| A16 指代：面试结果 | contact：面试通过；另有下周一入职计划；`[0,1]` | 严格 2 条：auto 结果＋pending 计划；计划 valid_at 固定 `2026-09-21T00:00:00+00:00`。未固定完整来源、其他标签和 invalid_at；不能写已入职、公司或职位。 |
| A17 严格：门票省略数量 | contact 范围：展览门票已买好，共两张；`[0,1]` | 严格 auto 1 条；展览类型有 context 支持，实际购买人及日期仍不能擅补。 |
| A18 严格：跨消息第三人 | contact：老陈住天津，report/reported，`[0,1]`；联系人住重庆，assertion，`[1]` | 严格 2 条：第三人 pending＋本人 auto；不交换人、改成籍贯或补居住起点。来源时点不表示居住开始日。 |
| A19 严格：跨话题拼接 | contact：平时喜欢红茶，`[0]`；下周计划去厦门参展，`[1]` | 严格 2 条：偏好 auto＋计划 pending；不得把两个话题拼成同一主张。计划的相对日期与当前空日期 oracle 需核定。 |

当前 reference 严格 claims 为 **8／19 窗**（主集 5、补充 3），共 11 个有限严格命题；其他 11 窗主要核对去向，不能凭通过推断正文、主体、语用、时间和来源都对。独立候选表保留其全部语义骨架，但没有将 19 窗宣布为已完成人工 Gold。

### 核心公开两窗

| ID／公开观察窗 | 独立候选语义骨架、必要 source | 原有 5 个严格期望的限度 |
| --- | --- | --- |
| B01 严格：报价判断与条件咨询 | self：①认为泥塑体验课两次 90 元的报价合适；②尚未决定报名；两项需 `[0,1]`。③仅在周末有空时去询问场地能否借工具，plan/conditional，核心 `[2]`；明确把场地归到该课程时需连贯上下文并核定关联。 | 现有 3 条：前两项 auto，第三项 pending，全部空日期。原 note 已声明不覆盖分类、保守 pending、自然引用完整性。评价价格不是长期价格偏好；咨询不是已报名、已借工具或场地确实能借。 |
| B02 严格：第三人历史经历与当前未知 | contact：①表弟在 2024 年暑假曾负责社区读书会活动主持，report/reported，`[0]`；②联系人在来源时点不知道表弟当前工作，assertion/asserted，`[1,2]`。 | 现有 2 条：历史转述 pending＋知识状态 auto，全部空日期；原 note 不覆盖忠实混合表达、分类、保守 pending 和自然引用完整性。未知不等于失业，也不是 V 的“证据不足”；不能把历史主持改成当前职业。 |

两窗能提供独立可读的 **5 个候选主张骨架**，但主张拆分、必要证据、category、语义上忠实的合并／拆分、未知状态可提取性与时间字段仍需人工核定。它们只是公开合成观察集；不替换核心票历史真实 6／12，不能当独立真实基线或新留出。

### 具体核定条件

1. **更新答案之前先解决契约冲突**：A05 的旧 auto 与当前 E 提示要求第三人 report/reported、[PragmaticInterpreter](../../backend/src/notalone/memory_extraction/pragmatics.py)将其留 pending 不一致。先核定期望，不将冲突当作模型一般错误或安全错误；本轮不改原用例。
2. **完整时间 Gold 尚缺**：严格评分中省略 `valid_at_iso`／`invalid_at_iso` 意味着必须为空，见[严格 validity 比较](../../backend/src/notalone/memory_extraction/evaluation.py)。A06“正在等行李”属于需核对的瞬时状态；当前 E 提示要求来源观察时间和不晚于当天结束的失效边界，旧严格空日期存在冲突。A19／B01 的未来条件安排与 B01／B02 当前状态也须分类后核定，不能给未知期限套固定 TTL，或把历史经历改为当前状态。
3. **独立语义与有限匹配器分开**：现有严格评分使用 `re.fullmatch` 和固定去向／标签／日期；忠实的拆分、合并、补充完整来源或保守 pending 可能不命中原 oracle。其 `false_fact_count` 会把未匹配的 auto 计入，不能未经人工语义核定就称实际假事；也不能反过来忽略真实坏 auto。
4. **未知与一次性内容有纳入边界**：A04／A14 及 B02 的知识状态需要核定是否值得跨对话复核及资料归属；A12 可按现行纯问题约束不生成。不得用“未知”代替逐条审计、删除难例，或为了凑分母补出确定事实。
5. **旧材料是回归**：公开语义集中的 `holdout` 标签不形成新留出；本轮不按模型结果重写 Gold、不读历史 raw、不补私人窗口。

## 可冻结的非秘密配置

这些是代码约定和本机安装元数据快照，不代表供应商接受的最终请求，也不代替新运行的配置 manifest。

| 项目 | 已核对的静态值／行为 | 来源或限制 |
| --- | --- | --- |
| 构造器默认请求模型 | `deepseek-chat` | [模型构造器](../../backend/src/notalone/reply/adapters/deepseek_provider.py)；环境或显式参数可覆盖，本轮不读取其值，不能当实际请求模型 |
| temperature／timeout／SDK retry | `0.0`／60 秒／`max_retries=2` | 同上；retry 内部真实请求须由单独 transport 硬门计数 |
| 产品 thinking | `extra_body={'thinking': {'type': 'enabled'}}` | [产品装配](../../backend/src/notalone/memory_extraction/cli_support.py)；通用评测只在显式 `--thinking` 时传同值 |
| E 绑定 | `MemoryExtractionOutput`，具名 `tool_choice`，无产品工具 fallback | [E adapter](../../backend/src/notalone/memory_extraction/adapters.py) |
| V 绑定 | `SourceVerificationOutput`，具名 `tool_choice`，至多 60 候选；空候选不调用 V | [V adapter](../../backend/src/notalone/memory_extraction/verification_adapters.py)及[核验契约](../../backend/src/notalone/memory_extraction/verification.py)；一次有界 V 不等于一次真实 HTTP |
| 非秘密运行配置 | 实际端点、请求模型、响应报告模型、reasoning_effort、最终序列化 thinking／工具参数未核实 | 不读取配置环境值、不构造可出站 SDK；未来不能靠默认值或供应商 fallback 补齐 |
| 评测去向 | `auto` 是原三道门下“若维度放行”的理想去向 | [evaluator](../../backend/src/notalone/memory_extraction/evaluation.py)；不写库，不叠加生产第 4 道门，不能当实际自动采纳 |
| 生产默认放行 | 空集，代码默认门开启 | [dimensions](../../backend/src/notalone/memory_extraction/dimensions.py)；未读取本机运维开关，不声称核定运行时覆盖值 |

Conda `NotAlone` 中 Python 3.12.13；仅调用 `importlib.metadata.version` 读取包元数据，没有导入 `langchain_deepseek`、`httpx` 或 `openai`。

| 包 | pyproject 约定 | 当前安装元数据 |
| --- | --- | --- |
| deepagents | 0.7.6 | 0.7.6 |
| httpx | 0.28.1 | 0.28.1 |
| langchain | 1.3.15 | 1.3.15 |
| langchain-core | 1.5.5 | 1.5.5 |
| langchain-deepseek | 1.1.0 | 1.1.0 |
| langgraph | 1.2.11 | 1.2.11 |
| psycopg | ≥3.3.4、<4 | 3.3.4 |
| openai | 未直接固定 | 3.3.1 |
| pydantic | 未直接固定 | 2.13.4 |

固定主依赖与[pyproject](../../backend/pyproject.toml)一致；openai／pydantic 是当前安装元数据，不当作仓库锁定版本。该列表不是完整依赖锁，也没有实测工具绑定或服务端兼容性。

## 提示、schema 与源码指纹

下表均从上述提交的 Git blob 计算，不跟随并行工作树的新改动。并行新增的 `evaluation_http_budget.py` 不属于该 baseline；未来执行前应单独冻结审查后的硬门、runner、依赖和最终配置，不能用本表声称已冻结尚未提交的工具。

| 符号 | SHA-256 | 哈希范围 |
| --- | --- | --- |
| `EXTRACTION_SYSTEM_PROMPT` | `6a325d297dba32326fcdc0d571c69e20369dab459f8c257586d2789f12fec5ff` | 字符串值 UTF-8 |
| `EXTRACTION_SCHEMA` | `5bc4d5830dc96b899cdc2a1033a09fb6eb2005f082048c589a09079715143415` | RHS 源码表达式 UTF-8 |
| `SOURCE_VERIFICATION_SYSTEM_PROMPT` | `620ef476b448318cfda4cac14551d9b55804f3605c8e31ab002e17dd5a36c7ea` | 字符串值 UTF-8 |
| `SOURCE_VERIFICATION_SCHEMA` | `663fee187742d0f5e1a53c96d1d09a3360e48b25bd6bc594206017d971141435` | RHS 源码表达式 UTF-8 |

schema 表达式哈希不是最终序列化 JSON schema 哈希：其枚举与常量依赖同时冻结到下表，但没有执行 SDK 序列化。源文件 SHA-256：

| 仓库相对路径 | SHA-256 |
| --- | --- |
| `backend/pyproject.toml` | `cb10491e4cd77c949100fbcc808cf7685a02076a17ae8c857cfb598167bc2279` |
| `backend/src/notalone/reply/adapters/deepseek_provider.py` | `666989d84a881f87b9b75beb487e347db1ce6697a786c80ebda546a65e0ba1d3` |
| `backend/src/notalone/memory_extraction/cli_support.py` | `396deaf9341007b14603fe52aa2e3fefd2344242bd07e7fa927017f0e4acfa88` |
| `backend/src/notalone/memory_extraction/adapters.py` | `90d2a4ed0612d919f44f73548c04e450b2f0194e3643d96eaeaa09f6e4bc3c42` |
| `backend/src/notalone/memory_extraction/verification_adapters.py` | `5246eeaebcf21440527ef2ae9b008b1cc7b27f484903dd639e395c06f9ff5209` |
| `backend/src/notalone/memory_extraction/verification.py` | `f0bae241117d599d33857c6f6fdf331316d4536fca1233dd3e4f46976b2b8fc4` |
| `backend/src/notalone/memory_extraction/evaluation.py` | `e1c9f5a1d96ed8b4cf720cb3648a6d95747e40c6f10dbc7fec0f77ae175ac6b1` |
| `backend/src/notalone/memory_extraction/evaluation_cases.py` | `e0ddbede2caa2d196a3aa33f98f59d78db099163e67758d0ed21397e14ce8327` |
| `backend/src/notalone/memory_extraction/semantic_evaluation_cases.py` | `d3224647dcdae69fc76b7e6cd33a83be38360b192278ab9081609e598201fda3` |
| `backend/src/notalone/memory_extraction/cases/types.py` | `849ec5837881de1f130b6a399453d83b34761af17a8019d6ac02ec78d69684e2` |
| `backend/src/notalone/memory_extraction/cases/reference.py` | `1ea49516267a9b35016a4d1b0872f893f34df098c02a7dab453351d83ada4072` |
| `backend/src/notalone/memory_extraction/models.py` | `c5356d20dacd3e2336839494afe40007284ff96330f7cf6e31cb6d2fba3b4343` |
| `backend/src/notalone/memory_extraction/runtime.py` | `91fa35aabc912c4275afbc966e25db348ee0adc942d7df434c1bcea00ce93e03` |
| `backend/src/notalone/memory_extraction/flow.py` | `626e76d90ac0a48480711e9928734afb502e1d0977834288bd68688380c77bbd` |
| `backend/src/notalone/memory_extraction/pragmatics.py` | `d93648ba1194dcd640a3130a1408b4c2a3828c839b575d1502b6db867a426dcc` |
| `backend/src/notalone/memory_extraction/adoption.py` | `e37efa7eca96918a66d5561b400bd364d56daf572e7c5be7fc073e85d94c3305` |
| `backend/src/notalone/memory_extraction/dimensions.py` | `453a1963ff7339bcfcb09c67c1b4c7e08b20bb2096dedde1966c804bb6da84be` |
| `backend/src/notalone/memory_trace/transport.py` | `7f1aa39c96bc2ea32c48830b3c894517e172687ec1a35fa679316100aa8fc696` |
| `backend/src/notalone/memory/models.py` | `2ab5c1b4b37a728c8c77c8cc868d89cd7666ad3cd1c955bfd3a018aa3fecf549` |
| `backend/src/notalone/memory_trace/context.py` | `dfa3e4c49e2c1401ab06fe4f421b74e2f31171159d77f3a8c7318b8297ad9dc6` |

## 剩余执行条件与本轮验证

可自主准备的输入清单、独立 Agent 候选骨架和代码快照已具备；**基线执行继续关闭**。需先完成：

1. 在调用前核定上述答案分歧，尤其 A05、A06、借用方向与核心两窗的完整主张／来源／日期／分类；记录真正的人工语义复核及最终主张分母。Agent 候选不代签人工记录。
2. 完成并独立审查实际 transport 请求封顶及纯合成验证，再冻结该硬门与最终 runner。仅代码存在或 invoke 数量不足以开放执行。
3. 固定唯一 run ID、样本顺序、实际非秘密端点／请求与响应模型、thinking／reasoning_effort／tool_choice／timeout／retry、最终序列化与明确无 fallback。当前安装版本快照不替代这些配置。
4. 将程序去向、正文语义、时间／主体／来源、失败／未运行和全部额外候选分别计分；模型配置及初轮完整性满足后，才依原方案考虑 ≤42 请求的新基线。未复现一般错误不开展候选 A/B；不重用历史余额。

本轮静态验证：21 个输入窗全部列出，reference 16＋3／8 个严格窗及 11 个有限命题、核心两窗 5 个期望核对；20 个提交源码 SHA-256、4 个提示／schema 指纹和 3 个输入快照核对。Markdown 本地链接与空白检查由最小标准库脚本核验，不运行模型、业务测试或 App。文件未单独提交，交主 Agent 汇总 Standards／Spec 审查及本地提交；仅指代07因领取评测工具前置由open改为claimed，Triage仍needs-info；其他两票状态、全部模型验收、默认放行台账和旧成绩保持。

使用的命令只有 `rg`／源码读取、Conda `NotAlone` 内 `PYTHONDONTWRITEBYTECODE=1 python -I` 的标准库 AST／metadata／SHA-256／链接脚本以及 Git blob 读取与差异检查。没有调用SDK、网络、数据库或产品；本次记忆预检 HTTP 请求为 0，与前述独立 WCDB 公开补核分开统计。

## 评测 HTTP 工具的独立交付

后续领取07的评测工具前置，新增[同步／异步传输预算模块](../../backend/src/notalone/memory_extraction/evaluation_http_budget.py)及[纯合成测试](../../backend/tests/unit/memory_extraction/test_evaluation_http_budget.py)。它在实际发送前持久预约，失败、超时与响应读取故障不退款；固定run、输出目录身份、配置摘要及精确端点，同一run仅允许一个在途请求。成功持久关闭后不可重开；关闭凭证写入／fsync本身失败时只能保证当前句柄停发，外层未知运行禁止恢复尚待装配和验证。

Conda `NotAlone` 中单文件12／12通过；合成测试额外禁止真实HTTPTransport／AsyncHTTPTransport构造，并确认供应商SDK未导入。四条实际red分别为模块缺失、端点拒绝后仍可续开、异步入口缺失、隐藏重试transport可注入，均逐片修复为green。测试只在自有临时HOME建注册文件，没有创建用户实际评测注册根，没有供应商调用、真实HTTP、凭据或业务库操作。

该工具没有接入生产provider、trace或完整评测runner，不设42／84默认值。真实SDK重试集成、未知存储故障闭环、最终序列化配置、人工Gold、完整原始输出保存及批次关闭协议仍需完成；本文件列出的答案冲突未被改写。因此模型执行和自动采纳继续保持关闭。
