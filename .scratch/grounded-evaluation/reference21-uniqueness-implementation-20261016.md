# 原21显式归属来源提示合同：离线实施

> 状态：离线注册与相关验证完成，独立Standards／Spec均0项问题；无真实prepare／freeze、凭据、预算或模型请求。
> 日期：2026-10-16；依据[固定计划](reference21-uniqueness-plan-20261016.md)。

新固定身份为 `reference21-grounded-v4-source-v2-uniqueness-v-off-forced`，mode／stage／owned kind 分别为 `deepseek_bounded_reference21_v4_source_v2_uniqueness`、`reference21-v4-source-v2-uniqueness`、`reference21-v4-uniqueness`。仅E选择已审 `reference-uniqueness-v1`，V沿 `legacy-v4`／`public-author-quote-v1`，原21／28＋1、42次上界、4小时、E max／V off具名、零重试及全部硬停保持。

复用同一reference21 helper、factory、记录器、分阶段审核与owned控制，E profile穿透逐窗合同、配置、实际runtime和发送前复核；旧身份只能原默认E，新身份缺少或错配新E在预算／key前拒绝。原公开窗口无受控来源且类型unknown的准入、额外proof包括null拒绝、typed未评估无信用保持。旧profile／默认提示／schema、Gold及原结果不改，不新增验证mode、持久schema、runner或harness。

新增计划、本实施及已审提示规格／离线结果进入新源闭包，共93文件（原semantic4的89＋4份新合同／提示文档）；旧freeze仅为已关闭历史。当前没有可启动的新真实freeze或registry，不启动后继。

## 合同接线

`evaluation_extraction` 的合同及runtime显式接受封闭E提示profile，只有grounded-v4允许新值；已审adapter的纯选择器公开为 `grounded_v4_prompt`，冻结和实际runtime共用，提示／schema字节不改。新plan必须明确给出 `extraction_prompt_profile=reference-uniqueness-v1`，旧plan必须default；旧配置不新增该字段。

该选择贯穿ecnu准入、逐窗prompt／schema摘要、frozen_config、records精确注册、正式runtime、发送前live／frozen比对和新profile的expected-request核验。审核bundle及owned领取都绑定新字段；新records拒绝以旧默认prompt摘要冒充新profile。新plan／mode／stage／kind精确按计划，旧注册、默认和source契约保持，V继续沿已存在的严格四槽及作者包装提示。

同一 `reference21-v4-public.py` 新增封闭 `uniqueness` profile和显式准备命令，但本轮只在临时测试目录执行其纯prepare；未生成实际运行目录、真实freeze或预算。原FIXED／baseline／semantic4保持；source准入、typed false、额外proof包括null先保存再拒绝、零重试及早停／关闭沿原逻辑。

## 真实红绿与负控

1. factory／实际SDK Mock先red：`extraction_contract`不存在prompt_profile参数；增加共享选择后同一测试green。旧模式配新profile在调用前拒绝，新E与旧v4 schema一致。
2. 全21 helper先red：`uniqueness`尚未注册；完成精确注册后，同一实际SDK Mock新E／原V配对运行21E＋19V＝40／42，到B02完成RAW／FULL并关闭，typed_evaluated／typed_credit均false，无verification_program。此为给定标签及合成审核的控制链，不是模型质量成绩。
3. A05原无码参数经新profile保持0.95、空alternatives、原通用理由及模拟auto；合成重放已封的两字段失败／ambiguous审核，原评分器产生ambiguous_auto1／bad_auto1，10／42关闭、后16窗unrun，停止码仍为case_semantic_audit_safety_error。新提示没有修补旧输出或救分。
4. E profile缺失／default／未知／坏类型、旧plan混新E、错V／cap／范围／provider／source版本等在预算／key前拒绝；helper固定字段、旧逐窗合同、实际提示常量漂移亦先拒绝。四种非公开／已知类型来源拒绝；额外proof的null和对象原件保留后整批失败、无审核／重试／下一窗。

最初freeze篡改测试误用正式publish覆盖已有临时文件，按其不可覆盖语义得到FileExistsError；仅测试改为故意写坏自己的临时freeze，正式publish原行为保持。这不是产品red或证据损坏，不通过放宽写入修复。

## 实际验证

Python均先激活仓库规定的Conda环境，`NOTALONE_DISABLE_DOTENV=1`；测试替换环境、使用临时home及精确MockTransport，socket／DNS禁止。所有预算／freeze均只为这些临时合成测试，不是新真实预算。

- 工厂最小SDK红→绿：1／1。
- 新准入／records模块：8／8。
- 新profile helper控制：4／4，含完整40／42、A05安全停、proof／来源与混版冻结拒绝。
- `PYTHONPATH=src python -m unittest discover -s tests/unit/memory_extraction -t . -q`：573／573，26.059秒。
- `PYTHONPATH=src python -m unittest tests.integration.memory_extraction.test_evaluation_wire_contract tests.integration.memory_extraction.test_evaluation_ecnu tests.integration.memory_extraction.test_evaluation_offline -q`：106／106，19.794秒。
- 根目录 `PYTHONPATH=backend/src python -m unittest discover -s desktop/tests/fixtures -p test_reference21_v4_public.py -q`：15／15，8.260秒，包含原baseline／semantic4回归。
- 8份受影响Python源码mypy：通过。收窄新增expected-prompt检查仅用于新profile、整理factory守卫后，终态相关provider／mixed／reference21契约与wire复核39／39（1.568秒）、同helper15／15（7.485秒）、8源mypy再次通过；这些重叠复核不累加为新样本。
- `git diff --check`、新文档本地链接及本机身份路径核对通过；93源均存在，旧默认提示／schema固定摘要保持。最终文档补记后仅做静态检查，不生成真实freeze。

## 文件与剩余范围

本主题共14文件：8份源码 `grounded_adapter.py`、`evaluation_extraction.py`、`evaluation_provider_contract.py`、`evaluation_ecnu.py`、`evaluation_offline.py`、`evaluation_records.py`、`evaluation_phased_audit.py`、`evaluation_owned_process.py`；原reference21 helper；3份对应unit／wire／helper测试；Root提供的新plan及本implementation。初始dirty任务票、父进度及桌面工作未纳入本片。

未读真实key／私聊／业务DB，未运行App／GUI或真实模型，未新建验证mode／供应商枚举／持久schema／runner／harness，未改Gold／旧result／门或生产默认。旧v2／v3／v4默认及所有旧profile沿原字节回归；新注册只有本机接线信用，不提供模型改善、同场≥15、核心B01／B02、完整140、typed或业务放行信用。独立Standards／Spec均0项问题，Root复核reference21合同与wire共13项通过；本地提交后执行公开扫描。Root最终冻结核验仍须单独完成；禁止自动真实后继。
