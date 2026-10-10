# 真实表达统一接口的验证记录

本记录只使用合成资料、受控模型和随机隔离PostgreSQL。没有新增外部模型实验、私人聊天、实际App、OCR、微信、自动采纳放量或远端发布。公开页面由总协调统一预约，尚未执行的组合不能算通过。

## E02：三种当前意图

基线为总协调 `d23a762`，只保留 `notalone.reply.fidelity_evaluation` 这一离线报告入口。生成约定在 `notalone.reply.fidelity`；改写使用原句、回应使用已确认方向、主动联系使用已确认目的，附加要求仅影响表达。该约定是模型输入约束，没有自动语义审查器。

实际框架捕获用例包括原句拒绝与旧习惯／附加要求冲突、明确回应方向及无目标的主动目的。受控模型故意输出同意，结构和合法引用仍通过；不能因此将其说成意愿保真通过。旧分支 `2ab0105` 的3例公开页面捕获和故意失败逐例报告仍可恢复，待适配唯一报告格式与正式集成树页面。

当前自动验证：

- `PYTHONPATH=src python -m unittest tests.unit.reply.test_fidelity_input -v`：3项通过；改写缺少 `fidelity_contract` 及主动模式未支持的红例先运行，后修复。
- `NOTALONE_DISABLE_DOTENV=1 PYTHONPATH=src python -m unittest tests.integration.server.test_fidelity_intent_api -v`：1项实际HTTP／PG通过，主动目的、禁用Skill、无伪造消息、重新装配后端实例后的同键及依据持久重读、跨owner拒绝；模型只调用1次。
- `PYTHONPATH=src python -m unittest tests.unit.reply.test_fidelity_input tests.unit.reply.test_fidelity_evaluation tests.unit.reply.test_generator tests.unit.reply.test_context_retrieval tests.unit.reply.test_langchain_vertical_slice -q`：71项相关回归通过，包含唯一E01的原报告测试。

Python命令均先激活Conda `NotAlone`，关闭LangSmith／LangChain tracing。测试数据库创建于生产迁移器完整前缀，并在收尾精确核验不存在。本切片没有业务库迁移。未知质量仍是未知，票暂不关闭。

两轴只读审查以 `d23a762` 为固定点：Standards hard 0／smell 0；Spec最初发现“重启后”表述超出同进程重新装配证据，修正文案后复核0。

## E03与E01实际捕获适配

`notalone.reply.fidelity_evaluation` 原CLI和16例保持，实际捕获通过 `python -m tests.fidelity_capture` 薄适配到同一入口。报告逐例分开保存供审阅整理的 `generation_input`、实际 `actual_capture`、不可新增内容、原输出、确定性结构／引用结果、合成标注的四个硬维度及依据。聚合只汇总已有标注，不分析文本；没有真人审阅的记录不能计入真人通过。评价字段在白名单内任意嵌套时拒绝进入模型输入。

- `authentic-expression-content-http-v1.json`：本集成分支9次实际HTTP调用；7个故意错误、2个合成契约案例，真人通过0。直接HTTP发起至完成计时，token未知；所有案例是开发集，不能称未见保留集质量。
- `authentic-expression-intent-historical-v1.json`：旧 `2ab0105` 的3次页面捕获，只转换为同一报告；立场失败1、真人通过0。原捕获未记录入口字段，计时范围保留unknown，不能预填新树页面复验。
- `authentic-expression-purpose-http-v1.json`：当前分支已确认目的1次实际HTTP调用，保留目的且无安排的合成标注；真人通过0，自然度、关系适配及本人相似度未知。

生成和改写共同说明“用户本次声明不等于外部核实”“来源只支持其陈述和时间”“条件建议不是承诺”“无历史不证明联系间隔或心理动机”，并分别标记初始材料和历史Tool。原材料仍按既有owner/contact与来源规则处理，新增分类不放宽来源校验。

实际命令与结果：

- 激活Conda后运行8个相关单元模块（fidelity_input、history_tools、generator、context_retrieval、langchain_vertical_slice、fidelity_evaluation、fidelity_capture、fidelity_review_details）：86项通过。真实缺factual_role、实际捕获及嵌套评价泄漏红例先运行再修复。中间测试夹具拼接位置和补丁语法错误已修复，不计为产品红例。
- `NOTALONE_DISABLE_DOTENV=1 PYTHONPATH=src python -m unittest tests.integration.server.test_fidelity_api tests.integration.server.test_fidelity_intent_api -v`：6项中5项通过；完成后来源撤回1项的依据读取及同键重放两子断言仍红（均200）。保留回归，不删减断言或将整组标绿，接最终公共守卫复验。每个测试类都精确核验自有随机数据库不存在。
- `npm test`：typecheck及safe40通过，未启动普通页面、浏览器或App。页面 `fidelity-intent` 与 `fidelity-content` 已准备并保留脚本内白名单及OS租约，尚未运行。前者4例覆盖三种输入和故意立场错误；后者9例语义捕获及无效正文／越权引用／调用中来源删除拒绝，消费真正助手保存HTTP入口。

两份已执行捕获报告及旧证据转换可用以下命令重建；命令只读已有合成捕获，不调用模型：

```bash
PYTHONPATH=src python -m tests.fidelity_capture --capture ../desktop/artifacts/headless-pages/fidelity-content-http-observations.json --case-spec tests/fixtures/fidelity/content-public-review.json --output ../docs/evaluations/authentic-expression-content-http-v1.json
PYTHONPATH=src python -m tests.fidelity_capture --capture ../desktop/artifacts/headless-pages/fidelity-intent-observations.json --case-spec tests/fixtures/fidelity/intent-public-review.json --output ../docs/evaluations/authentic-expression-intent-historical-v1.json
PYTHONPATH=src python -m tests.fidelity_capture --capture ../desktop/artifacts/headless-pages/fidelity-purpose-http-observations.json --case-spec tests/fixtures/fidelity/intent-http-review.json --output ../docs/evaluations/authentic-expression-purpose-http-v1.json
```

捕获原文件仅在被忽略的测试产物目录，报告提交的实际输入全部是合成资料。新页面将四例写入 `fidelity-intent-current-observations.json`／`intent-public-current-v2`，使用 `intent-public-current-review.json`；旧三例捕获及报告重建命令独立保留。内容页面使用 `content-public-review.json`。E02／E03保持claimed，人工和真实模型质量不是本轮新增完成条件。

本切片两轴固定点为 `a38d8e3`。Spec最初发现递归评价字段遗漏与新页面覆盖旧捕获两个P2，Standards发现同一历史覆盖P3；补字段的三子断言先红后7报告相关单元通过，分离新文件与版本后双方复核0。未放宽仍红的来源断言。
