# grounded-v4 物品所有权未知的显式开发协议修订

Triage: ready-for-agent
State: resolved

日期：2026-10-16。来源为已批准的D2后继范围；本任务仅在隔离工作树实施，主工作树的Gold及参考/审核结构由另一工作者负责。本规格不授权真实模型、预算或生产切换。

## 问题与目标

初版v4有六种受控歧义类别，不能专门说明物品所有者未明。人物、出借者、接收者和所有者是不同关系；出借或接收有据，不足以断定所有权，也不能因此把已明确的出借/接收角色或历史动作整体改成UNKNOWN。`place_ownership`说明地点／家里归属，`other_unresolved`也不能替代可明确列出的物品所有权未知。

本修订只增加封闭 `object_ownership` 类别及程序固定说明。不增加kind、模型自由正文或一分句多候选；保留原引用中的角色、方向、否定、条件和完成程度。不声称给定标签测试证明模型能正确分类或真实质量有所提高。

## Implementation Decisions

公开Seam沿用 `compile_labels_v4(window, draft)`、`grounded_schema_v4(window)` 和显式 `GroundedV4ExtractionRuntime(model=...)`。v4仍未注册 `EvaluationExtractionMode`，真实评测入口继续先于凭据、预算、审核与传输拒绝。此次v4提示和schema是开发协议修订，不能称其与初版六码合同完全相同；从未按本修订冻结真实运行，后继如另行授权必须绑定新的代码、实际提示及schema SHA。

仅v4的枚举追加 `object_ownership`。固定说明为“所引原句中的物品所有者在本窗口无法唯一确定；不因出借或接收认定所有者，保留原句。”，并逐条附该候选完整实际原引句和既有依赖上下文。模型按来源选择所有适用类别，物品所有者未明用本码，不能拿地点归属或泛其他未知替代；来源明确的角色或所有权不额外标未知。编译器不按词语、案例或Gold补码、推断所有者或生成proof。

数组仍必填、不能重复或含未知值，非空当且仅当 `unresolved=true`。前缀与未知第三人合并沿用实际成员并集、来源/依赖、最低置信度及敏感性传播。七码最多八条固定说明，单条上界仍为8400个Unicode字符，超限整窗可见失败，不截断引用或否定。

旧v2/v3提示字节、动态schema枚举、编译行为及生产默认v2不变；E14、typed来源证明、V只降不升、置信度0.7、风险/语用/维度门与默认空放行表均不变。旧v4切片及其575/66项记录、原独审结论保留，仅追加后继指针。ADR059当前说明记录这项有界修订。

## Testing Decisions

使用已批准的公开编译和实际SDK经精确 `httpx.MockTransport` wire两个Seam；仅公开合成输入与预置响应，阻止真实socket/DNS，禁dotenv。

- A05式“我姐把她的车借给我了。”给定relationship_event、contact、object_ownership，保留完整原句、姐姐出借/联系人接收方向、assertion/asserted/literal、历史双null；说明只保留车主未知，不添加人物/交付/所有权事实。
- 不按借用词补码，同类明确所有权来源给定空码时仍无alternatives；普通明确参与角色不整体降UNKNOWN。
- 前缀与未知第三人合并均保留本码及实际原引句/依赖，沿用风险和最低置信度；七码八条说明、8400字符失败安全。
- SDK实际请求中枚举恰为七码，提示解释物品与地点归属区别；非法未知码、重复、漏项、unresolved矛盾仍整窗失败，无修复请求。
- 给定confidence=1、合成V=supported后仍因ambiguity保持pending，不产生typed语义证明或自动采纳。
- 旧v2/v3拒绝新码；沿用独立变更前的140窗提示/schema/完整给定标签E14摘要，及原日周/月计算和显式真实入口拒绝回归。

按TDD先最小红绿，再运行必要相关六模块与来源核验/采纳回归及4文件类型检查。实际结果追加下方，独立双轴由主Agent组织；本工作者不提交。

## Out of Scope

不改Gold、原21/140分母、评分、任何runner/profile/预算或闭账原件；不新增自由解释、通用所有权解析、一分句多候选或自动放行。A15可选双候选缺口仍保留；此次仅解除物品所有权说明的协议缺口，不认证完整140端到端ready或达到至少15窗质量门。无真实聊天、凭据、模型、PG、GUI、安装或第三方API变更。

## 实际验证

全部命令使用Conda `NotAlone`，cwd为隔离工作树 `backend/`，显式 `NOTALONE_DISABLE_DOTENV=1 PYTHONPATH=src python -B`。再次核实 `grounded.__file__` 属于本工作树的 `backend/src/notalone/memory_extraction/grounded.py`，不使用主checkout的editable源码，没有修改全局安装。

首个编译红绿命令为：

```sh
python -B -m unittest tests.unit.memory_extraction.test_grounded_v4.GroundedV4CompilerTest.test_object_ownership_keeps_known_lending_roles_and_historical_assertion
```

首红为1项error：原v4拒绝未知码；只增加v4枚举、固定模板与实际引句绑定后，1项通过（0.001秒）。随后SDK切片使用：

```sh
python -B -m unittest tests.unit.memory_extraction.test_grounded_v4_runtime.GroundedV4RuntimeTest.test_sdk_object_ownership_contract_keeps_confidence_one_supported_candidate_pending
```

首红为1项failure：实际SDK wire提示缺新码；补仅v4两行指导后，1项通过（0.264秒）。原始首红日志未另保存；上述来自当次命令输出，不为补报告重跑首红。

扩充合并、边界与非法码控制后，新v4两个模块21项通过（0.650秒）。最终必要相关组124项通过（0.523秒）：编译/runtime六模块69项，来源/门四模块55项；包括旧v2/v3独立提示字节、140个动态schema集合及140组完整给定标签E14基线，原八个月份分支及真实入口最早拒绝v4。该结果不把新码合同冒称初版v4完全兼容，也不构成模型分类或真实质量证据。

实际完整相关命令的Python部分如下，前缀和cwd同上；读取模块前清空环境并仅保留禁dotenv标记。

```sh
NOTALONE_DISABLE_DOTENV=1 PYTHONPATH=src python -B - <<'PY'
import os, pathlib, unittest
os.environ.clear()
os.environ['NOTALONE_DISABLE_DOTENV'] = '1'
import notalone.memory_extraction.grounded as grounded
repo = pathlib.Path.cwd().parent
assert pathlib.Path(grounded.__file__).is_relative_to(repo)
print('module_origin_verified', pathlib.Path(grounded.__file__).relative_to(repo), flush=True)
loader = unittest.defaultTestLoader
compiler_runtime = loader.loadTestsFromNames([
 'tests.unit.memory_extraction.test_grounded_v4',
 'tests.unit.memory_extraction.test_grounded_v4_runtime',
 'tests.unit.memory_extraction.test_grounded_v3',
 'tests.unit.memory_extraction.test_grounded_v3_runtime',
 'tests.unit.memory_extraction.test_grounded_extraction',
 'tests.unit.memory_extraction.test_grounded_runtime',
])
gates_source = loader.loadTestsFromNames([
 'tests.unit.memory_extraction.test_source_verification',
 'tests.unit.memory_extraction.test_pragmatics',
 'tests.unit.memory_extraction.test_adoption',
 'tests.unit.memory_extraction.test_dimension_evidence_flow',
])
print('compiler_runtime_tests', compiler_runtime.countTestCases(), 'gates_source_tests', gates_source.countTestCases(), flush=True)
result = unittest.TextTestRunner(verbosity=1).run(unittest.TestSuite([compiler_runtime, gates_source]))
raise SystemExit(not result.wasSuccessful())
PY
```

同一环境的类型命令：

```sh
python -B -m mypy --follow-imports=silent \
  src/notalone/memory_extraction/grounded.py \
  src/notalone/memory_extraction/grounded_adapter.py \
  tests/unit/memory_extraction/test_grounded_v4.py \
  tests/unit/memory_extraction/test_grounded_v4_runtime.py
```

结果为 `Success: no issues found in 4 source files`。未重复初版575项范围。此次只处理公开合成文字/响应与内存追踪/记忆port，没有外部请求、真实凭据、真实运行预算或业务资料变更；无Gold或主工作树改动。

## Answer

本切片实现与离线验证完成。Root另行组织的独立Standards审查为硬违规0／判断性问题0，独立Spec审查为缺失／错实现／范围外0；两轴均只审基线`d8f6972a`后的这7份材料，不复算124项测试或沿用初版审查签名。主Agent据此集成本地提交；resolved只表示本切片完成，v4仍未注册真实入口，没有真实模型质量、自动采纳或完整140执行资格。

## 后继集成

上述未注册状态是本切片交付时的边界。后继[完整140固定入口](../grounded-evaluation/full140-v4-source-v2-readiness-20261016.md)已另行接显式v4、已审参考v2与独占有界控制，通过离线集成及两轴审查；旧计划仍拒v4，生产默认不变。本切片124项记录和原独审不改，不借后继Mock宣称真实质量或A15可选缺口已解决。
