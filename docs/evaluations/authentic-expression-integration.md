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
