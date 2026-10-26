# 独立事实与原话片段去向的本机原型（2026-10-03）

状态：用户回复“好继续”，批准本机原型及后续有限对照方案准备。本机原型已完成：12项不同原型unittest＋7项独立unittest、2文件mypy／AST通过，原两缺陷仍可捕获重放为预期红。当前0新API，不改生产默认或业务数据；所有旧试验继续关闭。本机验证不能宣称模型准确率提升，整体修复未完成。

## 设计问题与反馈

[上一轮匿名结果](memory-single-target-omission-pilot-result-20261003.md)暴露两个独立错误：知识句完整送达却首次E返回空；岗位候选附带独立历史、漏直接来源，被原V正确拒绝。原system已经要求阶段分开，原14字段能够表达合法知识状态；再次强调“拆开、补漏”本身不是新机制。

本机命令经原`LangChainExtractionRuntime.extract`和`ExtractionFlow.run`重放实际捕获；岗位同时重放原V公开返回，两个断言均红。它重现的是未保留应记主张，不把原V的正确拒绝称误拒。旧捕获、Gold和原产品逻辑不改。

原型检验一个联合输出：每条候选独立表达；每段target原话公开说明“对应候选”或“跳过”；每个声明source附真实片段。原型只校形状、字符去向和引用对应，原语义核验及采纳门继续负责后续判断。

## 临时联合协议

外部仍为已认可的`MemoryExtractionRuntime.extract(window)`返回原`ExtractionPayload`，继续原Flow。内部只用一次E，原system不改，工具返回`facts`、`coverage`、`evidence`；无R阶段、无新依赖或永久字段。

本机实现只接受显式`ScriptedModel／ReplayModel`，没有真实SDK模型、配置读取或联网启动器；装配后返回原14字段，原Flow为未经实际V核验的reviewable候选追加`semantic:unverified`，不能auto；question等NONE去向沿原采纳门也不能auto。真实SDK返回的绑定对象如何委托以及联合工具能否稳定返回，均尚未实现或验证，不把本机对象称为已可接生产模型。

- `facts`保持原14字段，新私有工具和结构检查将总raw数量限制为60。原Flow实际只限制60个reviewable候选，因此新总量口径更严格，不称原口径完全一致；潜在合法损失计入未来对照。私有工具说明要求一件独立主张一条候选；同一状态的否定、程度、条件、期间不能拆掉。程序不分句造事实，不改任何正文、主体、来源、置信度、风险或时间。
- `coverage`按输入顺序列齐每个target一次。每条含有序`segments`，各`quote`精确拼回全部原文，包含标点与空白。每段对应非空`fact_indices`且`skip_reason=null`，或无候选并给受控原因：`social`、`question_only`、`media_only`、`not_reusable`、`insufficient_context`。不强制每条消息产生事实。
- 每个候选至少被一个原话片段引用，片段所在target必须属于候选source；同一事实允许由多个片段或相连问答共同支持。不同来源、条件或阶段的拆分含义仍需独审。
- `evidence`按每候选一次列其声明source的逐字片段；每个source均有片段且无额外source，含target。coverage引用片段须落在该候选相同消息的evidence内。字符存在不证明主张受到完整语义支持。
- 未声明target、片段缺口／乱序、未知索引、假片段、缺声明source片段、跨窗或非法结构，整份返回为`invalid_output`；不补造、不回退。合法空必须说明全部target去向，仍不等于“没有应记事实”。

coverage及evidence是本次运行的临时公开产物，不是内部思考、长期关系记忆或用户确认。原型材料位于仓库外0700／0600目录；不进入业务表或Git。

## 与旧试验的区别与限制

| 旧机制 | 本机问题的差别 |
| --- | --- |
| [有界修订](memory-candidate-revision-contract-proposal-20261003.md) | 旧R改候选、补漏；这里不增加调用阶段，联合E输出原候选及全部原话的去向。 |
| [target分组](memory-target-group-wire-result-20261003.md) | 列齐组仍可无声空组；这里要求片段拼回全部原文并给跳过原因，仍不证明原因正确。 |
| [来源复制](memory-source-copy-plan-result-20261003.md) | 旧计划从字符组装正文；这里不渲染或限制正文字符，只检查声明的公开去向与证据。 |
| [逐条E](memory-single-target-omission-pilot-result-20261003.md) | 这里保留整窗所有target与一次E，不把target拆成多次调用。 |

联合契约同时改变工具说明和临时输出结构，不能声称单变量因果结果。机械检查必须保留两个反例：把完整知识句标为`skip`仍可能漏提；复合岗位主张只声明岗位来源、为该来源提供真实片段，也可能通过结构而仍被原V正确拒绝。不得为这些词句加特判以伪造修复。

逐声明source输出片段也重复了旧R首版的证据负担；旧版曾因未返回规定evidence而整包失败。这里只新增了全字符去向及与候选的对应义务，不能把重复证据包装称为创新或语义保证。新增负担可能降低有效输出，必须把全部结构失败和正例损失计入未来对照；原V的独立引用及完整语义责任不减。

## 验证状态

| 验证 | 实际结果与含义 |
| --- | --- |
| 原缺陷重放 | 原E／Flow及捕获V的2项断言均预期红；原输出与评分不改，没有新模型返回。 |
| 12项不同原型unittest | 人工4条原14字段可表达，条件／否定／期间及相连问答完整保留；合法skip、目标与候选引用、直接来源、工具shape、失败可见性与数量边界通过。 |
| 7项不同独立unittest | 复核所有原型方法，并补公共接缝边界及机械通过的语义反例。合计19个不同绿方法；参数化子案例不另计。 |
| 2文件mypy／AST | 原型实现与测试通过；不声称产品全量或SDK集成通过。 |
| 总量缺口 | 独审发现61个question标签Fact原可通过，因为原Flow只数reviewable；保留首红后在私有schema／外壳落实总raw60。口径更严、潜在正例损失仍须实测计分。 |
| 语义限制 | 错误知识skip、复合岗位缺历史直接来源、正文丢条件／否定、合并不同话题偏好都可能机械通过。后者可能正文真实，但原子性义务不因此获得证明。原捕获V仍正确拒绝复合岗位；未伪造supported或加词句特判。 |

全部人工正确输出只证明可表达，不是模型4/4或准确率提升。原型的问题得到回答：能够核对公开字符去向和声明来源，不能确定模型选择了全部应记事实，也不能机械判断独立主张。本机阶段回到原ticket；[8次有限对照提案](memory-atomic-coverage-pilot-proposal-20261003.md)已具体准备，尚未批准联网。

实际命令均在Conda NotAlone：`python -m unittest test_atomic_coverage_v1 -v`；`python -m mypy --follow-imports=silent --no-incremental --cache-dir=/dev/null <实现> <测试>`及AST解析。完整路径、PYTHONPATH／MYPYPATH、退出状态和红／绿日志在worker收据；独立审阅另以只编译获准源文件并阻断真实网络／模型／DB的程序执行12＋7方法及原2项预期红。

初模块缺失／stub行为红、测试插入位置IndexError、首次mypy注解错误、独审读取旧bytecode被自身allowlist阻断、root将凭据读取次数0误当严格bool False的核查错误均保留后在本机纠正，不计新模型样本。独审依赖导入中urllib3的IPv6能力探针出现1次被阻断的socket构造，connect／DNS为0，无外部连接/API调用；不写成完全无socket尝试。

最终实现SHA `27750df41fe66fb1d2cfe3f8e38f94886f087b93419fac4fec9260d18ce37272`，测试SHA `d7d0b5c1ef0af7fc5dac4a2cd0384a4998519032dea5171996786a22033470d7`。可复查的私有凭证均不提交Git：

- [worker验证收据v2](~/.notalone/audits/memory-atomic-coverage-prototype-20261003/prototype-v1/validation-receipt-v2.json)，SHA `8ab12fdda6c4679305701307aa0828a1f5df0742d955caa560aa5dbc55957c51`。
- [独立契约审计](~/.notalone/audits/memory-atomic-coverage-prototype-20261003/independent-contract-audit-v1/independent-contract-audit-summary-v1.json)，SHA `f5c1bd8a3f63c807002491fdfe59679ead7b7e732ffae7e368104e0d8475f500`；此版本对应验证状态补写前的文档，代码与19方法结果不变，文档终态另行审阅。
- [独立本机执行](~/.notalone/audits/memory-atomic-coverage-prototype-20261003/independent-contract-audit-v1/independent-local-final-v1.json)，SHA `5c745356b19c2c715358cfc03a548f7b70d7af93cb58c68e8d01d9115d0b5b3f`。
- [root证据核对](~/.notalone/audits/memory-atomic-coverage-prototype-20261003/root-local-prototype-evidence-verification-v1.json)，SHA `ff586c8c8dec9a768ebdf8d2121f5e08badefdaee6ee6b5781a0707239f2f74a`，核49项去重字节指纹及当时70条私有路径权限，确认旧19次试验仍关闭。

本机私有目录：`~/.notalone/audits/memory-atomic-coverage-prototype-20261003/`。首红收据`captured-feedback-red-v1.json` SHA `de0edebbf5d822ac159fefa48225b5f4fb7fbdd8f9ea582d6c5bce6c6221129b`。不读凭据、真实聊天或留出，不读取隐藏思考，不写业务／水位／旧五条，不做远端Git；实际历史6/12及2/6保持。
