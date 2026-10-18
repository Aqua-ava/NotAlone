# E2 主断言与纳入顺序合同修复

2026-10-18，接续 `3e9403d4`，按指代会话明确请求实现一次 E2 专属合同修订。本轮模型调用 0；旧场次、Gold、预算及审核结果不修改，不按 Axx、整句或关键词给生产候选重分类。

## 证据与可观察原因

只读核对指代 thinking 场已封输出：E 事件 30 的事项请求 `unresolved=false`、39 的亲属借用 `topic=other`、117 的一次性消息传递 `kind=plan`、126 的普通动作完成 `kind=relationship_event`。对应 V 事件 33/42/120/129 均 supported、issues 空。实际 E 请求包含四条新规则，提示 SHA256 为 `283e7e75…`；原捕获错误发生在 E 输出，不是编译器丢字段或旧提示未送达。

旧合同存在可观察的重叠：身份明确即 false 的旧句没有检查事项；即时意向的 plan 规则没有先服从纳入判定；普通完成与关系经历未按主断言区分；family 的必要证据要求没有定义亲属间互动的优先级。这不是模型内部机制的因果证明，但足以支持修订合同，不以切换 thinking 后重试代替修复。

## 最小实现

只在 `GROUNDED_V2_PROMPT` 派生时替换冲突旧句：

- 先判是否有独立可保存信息，再按主断言选 kind；所有即时／未来 plan 说明显式以通过纳入为前提，真实计划、责任约定与无“保证”词的承诺仍保留。
- 主断言本身是互动关系经历时沿 relationship_event；普通完成进度或结果沿 event，关系背景或对象来历不能抢占主断言。
- 逐项检查人物、事项、对象及角色；任一必要指称未明即 unresolved，只有全部必要指称明确才 false。
- 主断言是明确亲属间互动时优先 family；亲属仅作职业／学习事实背景时按实际主题，不据地点或来访推亲属。

旧基底、事件提案、显式 v3/v4 提示、schema、编译器、V、proof 及采纳门不变。新 E2 原字节 SHA256 为 `10e85aa08c292821cb84279fc2e61a33d71ec3a83cd7a67217a095281687443f`。仅当前 E2 两处固定摘要更新，旧运行记录不重签。

## 零 API 验证与限制

封存结果的离线诊断保持 A04/A05/A14/A15 四个语义红信号，修订提示后也不能改写这些已生成输出。另一个实际 SDK 请求合同测试在旧身份规则仍存在时失败；替换后两种 E2 入口通过。跨措辞给定标签控制覆盖关系背景下普通完成、赠予／归还本身、亲属互动、亲属职业背景、已知／未知事项请求，以及原有真实承诺和纯消息交换控制。它们只验证合同送达与给定标签处理，不认证模型已正确分类。

在 `backend/` 使用指定 Conda Python、`PYTHONPATH=src`：

```sh
python -m unittest tests.unit.memory_extraction.test_e2_stable_fact_guidance tests.unit.memory_extraction.test_core_semantics_contract tests.unit.memory_extraction.test_grounded_v3_runtime tests.unit.memory_extraction.test_grounded_v4_runtime -v
```

最终 44 项通过。中途 9 个固定措辞断言失败，定位为现有阶段指导的字面片段变化；保留原阶段说明，在其前面显式加“已通过纳入判定时”后通过，未放宽业务断言。AST 对比和固定摘要测试确认旧基底、事件提案、v3/v4及全 140 动态 schema 不变。`git diff --check` 通过。

独立 Standards/Spec Agent 均无阻塞；Standards 提醒链式替换依赖精确旧句，SDK 合同断言继续保留；Spec 提醒关系动作本身与亲属职业背景，已纳入给定标签控制。`reviewer_kind=agent`。新模型效果由指代会话独立冻结对照验证；本轮仍不宣称原票完成、整体质量改善或生产放行。没有真实联系人、业务数据、桌面或远端 Git 变更。
