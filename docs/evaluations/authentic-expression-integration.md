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

2026-10-11正式公共来源守卫复验：本树已合`bd35f07`为`ce27628`。先由生产迁移器在新建随机`_test`库执行001–050，再显式设置`NOTALONE_TEST_DATABASE_URL`，执行`test_fidelity_api`、`test_fidelity_intent_api`、`test_style_samples`、`test_assistant_session_api`和`test_postgres_reply_store`，55项全部通过，无skip。样本HTTP夹具显式设置`dimension_release=None`，未打开自动采纳门禁；收尾DROP并精确核验owned_database_remaining=0。E03原两个完成后来源撤回200红已转绿，故意语义错误报告仍按原依据失败，不混为质量通过。

本轮完整回复单元186、TypeScript及safe40通过。合并的三个入口／夹具冲突限定审查两轴均0，保留原白名单、最多两组、有限时段与OS租约。首次未显式给隔离URL而误连旧测试库的31项运行有12个持久层错误及A模块skip；该失败保留，随后正确隔离复验未修改旧库。尚未运行本树公开页面，E02/E03仍claimed。

## E02/E03：正式树公开路径接续

总协调已将统一切片集成为`a2b6ae6`，并在正式树串行执行两个有限公开页面入口，复用生产React／controller／具名bridge／认证HTTP及正式迁移后的随机PG。`fidelity-intent --timeout-seconds 120`四例三输入green，quiet9；`fidelity-content --timeout-seconds 120`九例及无效结构、越权引用、模型期间来源撤回拒绝green，quiet19。两组均active0／onscreen0、单Chrome、cleanupConfirmed=true、Electron/native=false。上述GREEN说明路径与判定传播通过，故意语义错误仍按原依据失败。

- `authentic-expression-intent-public-current-v2.json`：4例、契约失败0、故意保真失败1，调用4／873.628417ms。
- `authentic-expression-content-public-v1.json`：9例、契约失败0、故意保真失败7，调用9／2648.521791ms。

两份报告来自root已交实际捕获，全部合成开发集、真人0／qualityfalse；自然度、关系适配及本人相似度unknown。旧HTTP报告与旧三例转换独立保留。重建只读已有捕获，不增加模型调用：

```bash
PYTHONPATH=src python -m tests.fidelity_capture --capture /Users/local-user/learn/NotAlone/desktop/artifacts/headless-pages/fidelity-intent-current-observations.json --case-spec tests/fixtures/fidelity/intent-public-current-review.json --output ../docs/evaluations/authentic-expression-intent-public-current-v2.json
PYTHONPATH=src python -m tests.fidelity_capture --capture /Users/local-user/learn/NotAlone/desktop/artifacts/headless-pages/fidelity-content-observations.json --case-spec tests/fixtures/fidelity/content-public-review.json --output ../docs/evaluations/authentic-expression-content-public-v1.json
```

原待运行页面现已实际完成，E02/E03自动契约和失败呈现据此收口；真实模型质量和真人验收按用户范围跳过，未将其记为质量通过。以`c376d0a`为固定点的两轴限定审查最终0，逐例比对两份源捕获及resolved范围；没有为文档再次运行模型或页面。后续持久Skill探索版本、会话恢复／删除、连续修改及样本组合由E06覆盖。

## E05：独立有界参考切片

表达参考独立于事实evidence/citation，最多五个完整有效样本；600字符只是额外取数界限，完整请求总预算必须消费A12最终system/messages/tools/schema和输出预留计量。本切片尚未取得该最终接口，不把模型调用的合成契约结果记成总预算通过。默认纯草稿不取样本，方向探索不装配样本port；实际B探索载荷仍待E06验证。

`PGHOST=/tmp NOTALONE_DISABLE_DOTENV=1 PYTHONPATH=src python -m unittest tests.integration.server.test_style_reference_api -q`：7项真实HTTP/生产装配/正式迁移后的随机隔离PG通过，自动采纳配置为空。覆盖有界和范围、同键重新装配重读、无样本与纯草稿、不可当事实引用、模型期间删除、派生保存/结果级联清理，以及没有事实历史输入、只通过样本引用原始来源时的实际后台五步删除。数据库精确清理；没有业务库迁移。最初零参考的RED及重放顺序差异保留，修后原断言green。

报告`authentic-expression-style-reference-http-v1.json`保留两个实际HTTP调用：当前拒绝与旧赞成样本冲突；一个保留当前意图，一个故意改变意图并增加样本中的时间、地点及陪同承诺。合法结构/引用的故意错误仍被报告为失败。全部synthetic_fixture开发集，真人通过0，自然度／关系适配／本人相似度未知。报告只读已有捕获，命令如下：

```bash
PYTHONPATH=src python -m tests.fidelity_capture --capture ../desktop/artifacts/headless-pages/style-reference-http-observations.json --case-spec tests/fixtures/fidelity/style-reference-http-review.json --output ../docs/evaluations/authentic-expression-style-reference-http-v1.json
```

最终相关HTTP／PG回归分两组完成：样本引用、保真、主动目的及样本生命周期25项通过；助手会话和ReplyStore37项通过，合计62项、无skip。后一组显式随机隔离库先执行正式001–050迁移，核验实际库名，再精确DROP并确认剩余0。首次合跑的随机名称超过PG的63字节上限，后缀被截断，两个测试类在隔离护栏处拒绝；随后补跑入口的迁移相对路径有误，在进入测试前停止。两次失败与清理均保留，最终修正入口后37项green，未修改业务断言。

完整回复单元186、TypeScript及safe40通过；`style-reference`页面已准备且仍走原inline白名单/共享OS租约，尚未执行。以`1ac1566`为固定点的Standards最终hard0／smell0、Spec最终0：两路发现报告未同步最终提示／捕获，使用现有实际捕获重建后逐例复核关闭，无新增模型调用。E05保持claimed，最终总预算、真实页面及A/B组合未被本切片替代。


## 总协调公开复验

以上保留各C主题当时的结果及失败。总协调在正式root集成树以001–050生产迁移、认证HTTP及合成模型执行fidelity-intent四例和fidelity-content九例／三种确定性拒绝，两个公开组均exit0；quiet分别9及19次，active和屏上窗口0、单Chrome、cleanupConfirmed=true，Electron/native=false。唯一报告入口重建的新三输入报告4例含故意立场失败1、调用4，内容报告9例含故意扩写失败7、调用9；真人通过0、自然度／关系适配／本人相似度未验证。新捕获分别为fidelity-intent-current-observations.json和fidelity-content-observations.json，旧HTTP及历史捕获不覆盖。C05最终完整预算及组合仍待正式A12。
总协调后续已实际执行`style-reference`：root正式`37d5b70`，51认证HTTP／PG、186单元和type全green；页面exit0、quiet10、active0／onscreen0、单Chrome、cleanupConfirmed=true、Electron/native=false。A08正式恢复主题集成后同组与recovery再次全green，quiet26。E05剩余为A12完整请求计量，样本取数界限不能替代该预算。

## E06：正式助手HTTP的独立组合报告

沿正式001–051和生产生成装配，回应／主动各三个逐例实际调用：当前拒绝、继续只改短句、故意从旧表达扩写为答应和未来陪同。既有候选继续接口的覆盖不代表B10完整连续修改或消息组已经接入。每次同键重读零新增调用，样本回执不与事实引用混用；删除样本后三次相关讨论、依据、旧键和继续全部不可恢复。另两条独立组合仍验证删除原始来源或样本后无关讨论保留。

`test_authentic_expression_scenarios`＋`test_authentic_expression_combination`＋`test_style_reference_api`实际11项全部green、无skip，随机隔离库精确清理。样本竞态回归期间既有失败标记在被删除的租约上记录失效诊断，原拒绝／候选0仍通过，没有修改守卫或业务数据。

`authentic-expression-combination-http-v1.json`由唯一E01入口读取六个实际HTTP捕获生成；结构失败0、synthetic_fixture故意保真失败2、真人0／qualityfalse。自然度、关系适配、本人相似度和真实模型质量未知，全部开发集合成例；没有新增外部模型或自动语义评判器。

```bash
PYTHONPATH=src python -m tests.fidelity_capture --capture ../desktop/artifacts/headless-pages/authentic-combination-http-observations.json --case-spec tests/fixtures/fidelity/combined-http-review.json --output ../docs/evaluations/authentic-expression-combination-http-v1.json
```

真实A08组合页面、A09独立保留、B07持久Skill探索／澄清附加字段、B10消息组及A12完整预算仍需正式依赖后的组合证据；这些未执行项不勾选、不由本报告替代。
